/**
 * 주간 클리닉 시험 — 선생님용 API (/api/learning-report/clinic/*)
 *
 * 클리닉은 반이 섞인다(브릿지·모의고사는 여러 반 학생이 한 교실에서 각자 단계를 푼다). 그래서 이 파일의
 * 단위는 반이 아니라 **학원 전체의 영어 학생**과 **클리닉 날**이다. 공개도 반의 주(report_weeks)가 아니라
 * 클리닉 날마다 따로 건다.
 *
 * 문단속은 learning-report/routes.ts 와 같다: authGuard → tenantGuard → roleGuard("owner","teacher"),
 * 학생 id 는 전부 우리 학원·재원 중인지 확인한다.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";
import {
  students,
  classes,
  enrollments,
  studentClinicLevels,
  clinicDays,
  clinicScores,
  vocabScores,
  CLINIC_LEVELS,
  clinicLevelsBodySchema,
  clinicDayBodySchema,
  clinicScoresBodySchema,
  type ClinicDay,
} from "@shared/schema";
import { LISTENING_DEFAULT_TOTAL, isCountLevel } from "@shared/learningReport";

const router = Router();
const P = "/api/learning-report/clinic";
const guards = [authGuard, tenantGuard, roleGuard("owner", "teacher")] as const;

/** 클리닉 대상 과목. 학부모 리포트는 영어만 쓴다(원장 지시 2026-11-07). */
const CLINIC_SUBJECTS = ["영어"];

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다.");

function validateBody(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "입력 데이터가 올바르지 않습니다." });
    }
    req.body = parsed.data;
    next();
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function handle(label: string, fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
      console.error(`클리닉 ${label} 오류:`, err);
      if (!res.headersSent) res.status(500).json({ error: `${label} 중 오류가 발생했습니다.` });
    }
  };
}

const tenantOf = (req: Request) => req.user!.tenantId!;

function parseDate(v: string): string {
  const p = dateParam.safeParse(v);
  if (!p.success) throw new HttpError(400, p.error.errors[0]?.message ?? "날짜가 올바르지 않습니다.");
  return p.data;
}

/**
 * 클리닉에 올 수 있는 학생 = 영어 반에 수강 중인 재원생. 반이 둘이면 이름순 첫 반을 "소속 반" 으로 쓴다
 * (클리닉 날 단어시험을 그 반 단어시험 표에 적기 위해서다. 지금은 영어 학생 전원이 반 하나씩이다).
 */
async function loadClinicStudents(tenantId: string) {
  const rows = await db
    .select({
      studentId: students.id,
      name: students.name,
      grade: students.grade,
      classId: classes.id,
      className: classes.name,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .innerJoin(classes, eq(classes.id, enrollments.classId))
    .where(
      and(
        eq(enrollments.tenantId, tenantId),
        eq(enrollments.isActive, true),
        eq(students.isActive, true),
        eq(classes.isActive, true),
        inArray(classes.subject, CLINIC_SUBJECTS)
      )
    )
    .orderBy(asc(classes.name), asc(students.name));
  const levels = rows.length
    ? await db
        .select({ studentId: studentClinicLevels.studentId, level: studentClinicLevels.level })
        .from(studentClinicLevels)
        .where(inArray(studentClinicLevels.studentId, rows.map((r) => r.studentId)))
    : [];
  const levelOf = new Map(levels.map((l) => [l.studentId, l.level]));
  const seen = new Set<string>();
  return rows
    .filter((r) => (seen.has(r.studentId) ? false : (seen.add(r.studentId), true)))
    .map((r) => ({ ...r, level: levelOf.get(r.studentId) ?? null }));
}

async function findDay(tenantId: string, date: string): Promise<ClinicDay | null> {
  const [row] = await db.select().from(clinicDays).where(and(eq(clinicDays.tenantId, tenantId), eq(clinicDays.date, date)));
  return row ?? null;
}

async function ensureDay(req: Request, date: string): Promise<ClinicDay> {
  await db.insert(clinicDays).values({ tenantId: tenantOf(req), date, createdBy: req.user!.id }).onConflictDoNothing();
  return (await findDay(tenantOf(req), date))!;
}

// ─── 학생 · 단계 ─────────────────────────────────────────────────────────

router.get(
  `${P}/students`,
  ...guards,
  handle("학생 목록", async (req, res) => {
    res.json(await loadClinicStudents(tenantOf(req)));
  })
);

/** 단계 정하기(여러 명 한 번에). "none" 은 안 들음 — 클리닉 표와 부모님 화면 클리닉 칸에서 빠진다. */
router.put(
  `${P}/levels`,
  ...guards,
  validateBody(clinicLevelsBodySchema),
  handle("단계 저장", async (req, res) => {
    const items = req.body.items as z.infer<typeof clinicLevelsBodySchema>["items"];
    const allowed = new Set((await loadClinicStudents(tenantOf(req))).map((s) => s.studentId));
    if (items.some((i) => !allowed.has(i.studentId))) throw new HttpError(400, "영어 반에 수강 중인 학생이 아닌 학생이 섞여 있습니다.");
    for (const i of items) {
      await db
        .insert(studentClinicLevels)
        .values({ tenantId: tenantOf(req), studentId: i.studentId, level: i.level, updatedBy: req.user!.id })
        .onConflictDoUpdate({ target: [studentClinicLevels.studentId], set: { level: i.level, updatedBy: req.user!.id, updatedAt: new Date() } });
    }
    res.json({ saved: items.length });
  })
);

// ─── 클리닉 날 ───────────────────────────────────────────────────────────

/**
 * 그날의 묶음: 학생(단계 포함)·점수·그날 단어시험. 화면이 단계별로 묶어 그린다.
 * 화면을 열기만 해서는 클리닉 날 행을 만들지 않는다(처음 저장할 때 만든다).
 */
router.get(
  `${P}/days/:date`,
  ...guards,
  handle("클리닉 조회", async (req, res) => {
    const date = parseDate(req.params.date);
    const tenantId = tenantOf(req);
    const [list, day] = await Promise.all([loadClinicStudents(tenantId), findDay(tenantId, date)]);
    const scores = day ? await db.select().from(clinicScores).where(eq(clinicScores.clinicDayId, day.id)) : [];
    const ids = list.map((s) => s.studentId);
    const vocab = ids.length
      ? await db
          .select({ studentId: vocabScores.studentId, classId: vocabScores.classId, total: vocabScores.total, wrong: vocabScores.wrong, retestPassed: vocabScores.retestPassed })
          .from(vocabScores)
          .where(and(eq(vocabScores.testDate, date), inArray(vocabScores.studentId, ids)))
      : [];
    // 단어시험 총 문항 기본값 — 학생마다 지난번 값 (반 단어시험 탭과 같은 규칙).
    const lastVocab = ids.length
      ? await db
          .selectDistinctOn([vocabScores.studentId], { studentId: vocabScores.studentId, total: vocabScores.total })
          .from(vocabScores)
          .where(inArray(vocabScores.studentId, ids))
          .orderBy(vocabScores.studentId, desc(vocabScores.testDate))
      : [];
    res.json({
      date,
      day: day ? { papers: day.papers, publishedAt: day.publishedAt } : null,
      students: list,
      scores: scores.map((s) => ({ studentId: s.studentId, level: s.level, score: s.score, correct: s.correct, total: s.total, reviewDone: s.reviewDone })),
      vocab,
      lastVocabTotals: Object.fromEntries(lastVocab.map((r) => [r.studentId, r.total])),
      listeningDefaultTotal: LISTENING_DEFAULT_TOTAL,
    });
  })
);

router.patch(
  `${P}/days/:date`,
  ...guards,
  validateBody(clinicDayBodySchema),
  handle("시험지 이름 저장", async (req, res) => {
    const day = await ensureDay(req, parseDate(req.params.date));
    const papers = { ...day.papers, ...(req.body.papers ?? {}) };
    const [row] = await db.update(clinicDays).set({ papers, updatedAt: new Date() }).where(eq(clinicDays.id, day.id)).returning();
    res.json(row);
  })
);

/** 공개. 다시 눌러도 처음 공개 시각을 덮지 않는다(report_weeks 와 같은 규칙). */
router.post(
  `${P}/days/:date/publish`,
  ...guards,
  handle("클리닉 공개", async (req, res) => {
    const day = await ensureDay(req, parseDate(req.params.date));
    if (day.publishedAt) return res.json(day);
    const [row] = await db
      .update(clinicDays)
      .set({ publishedAt: new Date(), publishedBy: req.user!.id, updatedAt: new Date() })
      .where(eq(clinicDays.id, day.id))
      .returning();
    res.json(row);
  })
);

router.post(
  `${P}/days/:date/unpublish`,
  ...guards,
  handle("클리닉 공개 취소", async (req, res) => {
    const day = await findDay(tenantOf(req), parseDate(req.params.date));
    if (!day) throw new HttpError(404, "이 날의 클리닉 기록이 없습니다.");
    const [row] = await db
      .update(clinicDays)
      .set({ publishedAt: null, publishedBy: null, updatedAt: new Date() })
      .where(eq(clinicDays.id, day.id))
      .returning();
    res.json(row);
  })
);

/**
 * 점수 일괄 저장. 학생 단계는 서버가 정한다(화면이 보낸 단계를 믿지 않는다) — 그날 기록에 그 단계가 남는다.
 * 단계를 아직 안 정했거나 "안 들음" 인 학생은 400. 듣기는 맞은 개수(총 문항 기본 17), 나머지는 100점 점수.
 */
router.put(
  `${P}/days/:date/scores`,
  ...guards,
  validateBody(clinicScoresBodySchema),
  handle("클리닉 점수 저장", async (req, res) => {
    const date = parseDate(req.params.date);
    const entries = req.body.entries as z.infer<typeof clinicScoresBodySchema>["entries"];
    const list = await loadClinicStudents(tenantOf(req));
    const byId = new Map(list.map((s) => [s.studentId, s]));
    for (const e of entries) {
      const s = byId.get(e.studentId);
      if (!s) throw new HttpError(400, "영어 반에 수강 중인 학생이 아닌 학생이 섞여 있습니다.");
      if (!s.level || !(CLINIC_LEVELS as readonly string[]).includes(s.level)) throw new HttpError(400, `${s.name} 학생의 클리닉 단계를 먼저 정해 주세요.`);
      if (e.correct != null && e.total != null && e.correct > e.total) throw new HttpError(400, `${s.name}: 맞은 개수가 총 문항보다 많습니다.`);
    }
    const day = await ensureDay(req, date);
    const existing = await db.select().from(clinicScores).where(eq(clinicScores.clinicDayId, day.id));
    for (const e of entries) {
      const s = byId.get(e.studentId)!;
      const prev = existing.find((x) => x.studentId === e.studentId);
      const counted = isCountLevel(s.level!);
      const score = counted ? null : e.score !== undefined ? e.score : prev?.score ?? null;
      const correct = counted ? (e.correct !== undefined ? e.correct : prev?.correct ?? null) : null;
      const total = counted ? (e.total ?? prev?.total ?? LISTENING_DEFAULT_TOTAL) : null;
      const reviewDone = e.reviewDone ?? prev?.reviewDone ?? false;
      if (score == null && correct == null) {
        await db.delete(clinicScores).where(and(eq(clinicScores.clinicDayId, day.id), eq(clinicScores.studentId, e.studentId)));
        continue;
      }
      if (correct != null && total != null && correct > total) throw new HttpError(400, `${s.name}: 맞은 개수가 총 문항보다 많습니다.`);
      await db
        .insert(clinicScores)
        .values({ tenantId: day.tenantId, clinicDayId: day.id, studentId: e.studentId, level: s.level!, score, correct, total, reviewDone, updatedBy: req.user!.id })
        .onConflictDoUpdate({
          target: [clinicScores.clinicDayId, clinicScores.studentId],
          set: { level: s.level!, score, correct, total, reviewDone, updatedBy: req.user!.id, updatedAt: new Date() },
        });
    }
    res.json({ saved: entries.length });
  })
);

export default router;
