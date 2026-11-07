/**
 * 학부모 학습 리포트 — 선생님용 API (/api/learning-report/*)
 *
 * 설계·결정은 docs/PARENT_REPORT_PLAN.md. 화면 시안은 design/parent-report/teacher_input_english.html.
 * 부모님이 로그인 없이 여는 경로(/p/:token)는 이 파일에 없다 — 5단계에서 별도 파일로 만든다.
 * 같은 파일에 두면 "여기는 전부 로그인 필요" 라고 읽히는 자리에 공개 경로가 섞인다
 * (server/level-test/shareRoutes.ts 머리말과 같은 이유).
 *
 * 문단속 규칙
 *   · 모든 경로가 authGuard → tenantGuard → roleGuard("owner","teacher")
 *   · 강사·원장 모두 입력·공개 가능 (원장 결정 2026-11-07)
 *   · 주소에 들어온 반·숙제·시험·사진·학생 id 는 전부 **우리 학원 것인지** 확인한다.
 *     다른 학원 것은 404 — 존재 여부조차 알려주지 않는다
 *   · 학생 id 묶음은 **그 반 명단 안에 있는지** 확인한다. 다른 반 학생 점수가 섞여 들어가면
 *     그 반 평균·상위 % 가 틀어지고, 그 학생 부모님 화면에 남의 반 시험이 뜬다
 */

import express, { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";
import {
  classes,
  students,
  enrollments,
  reportWeeks,
  homeworkItems,
  homeworkChecks,
  exams,
  examScores,
  makeupSessions,
  makeupStudents,
  notePhotos,
  parentLinks,
  DEFAULT_EXAM_AREAS,
  updateReportWeekBodySchema,
  homeworkItemBodySchema,
  updateHomeworkItemBodySchema,
  homeworkChecksBodySchema,
  examBodySchema,
  updateExamBodySchema,
  examScoresBodySchema,
  makeupBodySchema,
  updateMakeupBodySchema,
  makeupStudentStatusBodySchema,
  retestBodySchema,
  type Class,
  type ReportWeek,
  type HomeworkItem,
  type Exam,
  type HomeworkStatus,
} from "@shared/schema";
import { addDays } from "@shared/day";
import {
  isMonday,
  weekLabel,
  deriveHomeworkStatus,
  examTotal,
  examStats,
  phoneLast4,
  maskPhone,
} from "@shared/learningReport";
import { generateShareToken } from "../lib/shareLink";
import { savePhoto, readPhoto, deletePhoto, detectImageMime, MAX_PHOTO_BYTES } from "./photoStore";

const router = Router();
const P = "/api/learning-report";
const guards = [authGuard, tenantGuard, roleGuard("owner", "teacher")] as const;

const idParam = z.string().uuid();
const weekParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isMonday, "주 시작일은 월요일이어야 합니다.");

/** 부모님 링크 경로. 레벨테스트 결과지가 /r/ 를 쓰므로 겹치지 않게 /p/ 다. */
export const PARENT_LINK_PREFIX = "/p/";

function validateBody(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message ?? "입력 데이터가 올바르지 않습니다.", details: parsed.error.errors });
    }
    req.body = parsed.data;
    next();
  };
}

/** 라우트마다 같은 try/catch 를 반복하지 않으려고. 오류 문구는 원장이 읽는 말로. */
function handle(label: string, fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      console.error(`학습 리포트 ${label} 오류:`, error);
      if (!res.headersSent) res.status(500).json({ error: `${label} 중 오류가 발생했습니다.` });
    }
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function sendHttpError(res: Response, err: unknown): boolean {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return true;
  }
  return false;
}

const tenantOf = (req: Request) => req.user!.tenantId!;

// ─── 불러오기 + 우리 학원 것인지 확인 ────────────────────────────────────

async function loadClass(req: Request, classId: string): Promise<Class> {
  if (!idParam.safeParse(classId).success) throw new HttpError(400, "유효하지 않은 반 ID 입니다.");
  const [row] = await db.select().from(classes).where(and(eq(classes.id, classId), eq(classes.tenantId, tenantOf(req))));
  if (!row) throw new HttpError(404, "반을 찾을 수 없습니다.");
  return row;
}

function parseWeek(weekStart: string): string {
  const parsed = weekParam.safeParse(weekStart);
  if (!parsed.success) throw new HttpError(400, parsed.error.errors[0]?.message ?? "주 시작일이 올바르지 않습니다.");
  return parsed.data;
}

/** 반 명단 = 그 반에 수강 중(enrollments.isActive)이고 재원 중(students.isActive)인 학생. */
async function loadRoster(tenantId: string, classId: string) {
  return await db
    .selectDistinct({ id: students.id, name: students.name, grade: students.grade, parentPhone: students.parentPhone })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(
      and(
        eq(enrollments.tenantId, tenantId),
        eq(enrollments.classId, classId),
        eq(enrollments.isActive, true),
        eq(students.isActive, true)
      )
    )
    .orderBy(asc(students.name));
}

function assertInRoster(roster: { id: string }[], studentIds: string[]) {
  const ids = new Set(roster.map((s) => s.id));
  const outsiders = studentIds.filter((id) => !ids.has(id));
  if (outsiders.length) throw new HttpError(400, `이 반 명단에 없는 학생이 ${outsiders.length}명 섞여 있습니다.`);
}

async function findWeek(classId: string, weekStart: string): Promise<ReportWeek | null> {
  const [row] = await db.select().from(reportWeeks).where(and(eq(reportWeeks.classId, classId), eq(reportWeeks.weekStart, weekStart)));
  return row ?? null;
}

/**
 * 그 반·그 주 행이 없으면 만든다. 화면을 열기만 해서는 만들지 않고, 처음 무언가를 저장할 때 만든다.
 * 두 강사가 동시에 처음 저장해도 (class_id, week_start) 유니크가 하나만 남긴다.
 */
async function ensureWeek(req: Request, cls: Class, weekStart: string): Promise<ReportWeek> {
  await db
    .insert(reportWeeks)
    .values({ tenantId: cls.tenantId, classId: cls.id, weekStart, createdBy: req.user!.id })
    .onConflictDoNothing();
  return (await findWeek(cls.id, weekStart))!;
}

async function loadHomeworkItem(req: Request, itemId: string): Promise<{ item: HomeworkItem; week: ReportWeek }> {
  if (!idParam.safeParse(itemId).success) throw new HttpError(400, "유효하지 않은 숙제 ID 입니다.");
  const [row] = await db
    .select({ item: homeworkItems, week: reportWeeks })
    .from(homeworkItems)
    .innerJoin(reportWeeks, eq(reportWeeks.id, homeworkItems.reportWeekId))
    .where(and(eq(homeworkItems.id, itemId), eq(homeworkItems.tenantId, tenantOf(req))));
  if (!row) throw new HttpError(404, "숙제를 찾을 수 없습니다.");
  return row;
}

async function loadExam(req: Request, examId: string): Promise<Exam> {
  if (!idParam.safeParse(examId).success) throw new HttpError(400, "유효하지 않은 시험 ID 입니다.");
  const [row] = await db.select().from(exams).where(and(eq(exams.id, examId), eq(exams.tenantId, tenantOf(req))));
  if (!row) throw new HttpError(404, "시험을 찾을 수 없습니다.");
  return row;
}

async function loadStudentsOfTenant(req: Request, studentIds: string[]) {
  if (studentIds.length === 0) return [];
  const rows = await db
    .select({ id: students.id, name: students.name, parentPhone: students.parentPhone, isActive: students.isActive })
    .from(students)
    .where(and(eq(students.tenantId, tenantOf(req)), inArray(students.id, studentIds)));
  if (rows.length !== new Set(studentIds).size) throw new HttpError(404, "학생을 찾을 수 없습니다.");
  return rows;
}

// ─── 한 주 묶음 ──────────────────────────────────────────────────────────

/**
 * 선생님 화면이 한 번에 받는 묶음. 탭 넷(진도·숙제 / 시험 / 보강 / 사진)이 전부 여기서 그린다.
 * 화면이 탭마다 서버를 왕복하면 탭을 넘길 때마다 깜빡이고, 숫자가 서로 다른 시점의 값이 된다.
 */
async function weekBundle(tenantId: string, cls: Class, weekStart: string) {
  const [week, roster] = await Promise.all([findWeek(cls.id, weekStart), loadRoster(tenantId, cls.id)]);

  const items = week
    ? await db.select().from(homeworkItems).where(eq(homeworkItems.reportWeekId, week.id)).orderBy(asc(homeworkItems.sortOrder), asc(homeworkItems.createdAt))
    : [];
  const checks = items.length
    ? await db.select().from(homeworkChecks).where(inArray(homeworkChecks.homeworkItemId, items.map((i) => i.id)))
    : [];
  const examRows = week
    ? await db.select().from(exams).where(eq(exams.reportWeekId, week.id)).orderBy(asc(exams.examDate), asc(exams.createdAt))
    : [];
  const scores = examRows.length
    ? await db.select().from(examScores).where(inArray(examScores.examId, examRows.map((e) => e.id)))
    : [];
  const photos = week
    ? await db
        .select()
        .from(notePhotos)
        .where(eq(notePhotos.reportWeekId, week.id))
        .orderBy(asc(notePhotos.takenDate), asc(notePhotos.createdAt))
    : [];

  // 보강은 주에 매달리지 않는다(일정이라서). 이 반의 전후 몇 주를 보여 준다.
  const makeups = await loadMakeups(tenantId, cls.id, addDays(weekStart, -28), addDays(weekStart, 35));

  const homework = items.map((item) => ({
    ...item,
    checks: Object.fromEntries(
      checks.filter((c) => c.homeworkItemId === item.id).map((c) => [c.studentId, { status: c.status, doneCount: c.doneCount }])
    ),
  }));

  const examList = examRows.map((exam) => {
    const mine = scores.filter((s) => s.examId === exam.id);
    return {
      ...exam,
      scores: mine.map((s) => ({ studentId: s.studentId, areaScores: s.areaScores, total: s.total, absent: s.absent, comment: s.comment })),
      stats: examStats(mine.map((s) => ({ studentId: s.studentId, total: s.total, absent: s.absent })), exam.passScore),
    };
  });

  return {
    class: { id: cls.id, name: cls.name, subject: cls.subject },
    weekStart,
    label: weekLabel(weekStart),
    week,
    students: roster.map((s) => ({ id: s.id, name: s.name, grade: s.grade })),
    defaultAreas: DEFAULT_EXAM_AREAS[cls.subject] ?? DEFAULT_EXAM_AREAS["영어"],
    homework,
    exams: examList,
    photos: photos.map(({ ...p }) => ({ ...p, purged: !!p.purgedAt })),
    makeups,
    suggestions: makeupSuggestions(roster, homework, examList),
  };
}

/**
 * "보강이 필요해 보이는 학생". 이번 주 숙제를 하나도 안 했거나 일부만 했거나, 시험 재시 대상이면 올린다.
 * 추천일 뿐 자동으로 보강을 잡지 않는다 — 결정은 선생님이 한다.
 */
function makeupSuggestions(
  roster: { id: string; name: string }[],
  homework: { title: string; checks: Record<string, { status: string; doneCount: number | null }> }[],
  examList: { name: string; stats: { failStudentIds: string[] } }[]
) {
  const out: { studentId: string; name: string; reasons: string[] }[] = [];
  for (const s of roster) {
    const reasons: string[] = [];
    const statuses = homework.map((h) => h.checks[s.id]?.status).filter(Boolean);
    const none = statuses.filter((st) => st === "none").length;
    const partial = statuses.filter((st) => st === "partial").length;
    if (homework.length && none === homework.length) reasons.push(`숙제 0/${homework.length}`);
    else if (none) reasons.push(`안 해온 숙제 ${none}건`);
    if (partial) reasons.push(`일부만 해온 숙제 ${partial}건`);
    for (const e of examList) if (e.stats.failStudentIds.includes(s.id)) reasons.push(`${e.name} 재시`);
    if (reasons.length) out.push({ studentId: s.id, name: s.name, reasons });
  }
  return out;
}

async function loadMakeups(tenantId: string, classId: string | null, from: string, to: string) {
  const sessions = await db
    .select()
    .from(makeupSessions)
    .where(
      and(
        eq(makeupSessions.tenantId, tenantId),
        classId ? eq(makeupSessions.classId, classId) : sql`true`,
        gte(makeupSessions.date, from),
        lte(makeupSessions.date, to)
      )
    )
    .orderBy(asc(makeupSessions.date), asc(makeupSessions.startTime));
  if (sessions.length === 0) return [];
  const members = await db
    .select({ makeupId: makeupStudents.makeupId, studentId: makeupStudents.studentId, status: makeupStudents.status, name: students.name })
    .from(makeupStudents)
    .innerJoin(students, eq(students.id, makeupStudents.studentId))
    .where(inArray(makeupStudents.makeupId, sessions.map((m) => m.id)));
  return sessions.map((m) => ({
    ...m,
    students: members.filter((x) => x.makeupId === m.id).map(({ makeupId, ...rest }) => rest),
  }));
}

router.get(
  `${P}/classes/:classId/weeks/:weekStart`,
  ...guards,
  handle("주간 기록 조회", async (req, res) => {
    try {
      const cls = await loadClass(req, req.params.classId);
      const weekStart = parseWeek(req.params.weekStart);
      res.json(await weekBundle(tenantOf(req), cls, weekStart));
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

// ─── 진도 · 공개 ─────────────────────────────────────────────────────────

router.patch(
  `${P}/classes/:classId/weeks/:weekStart`,
  ...guards,
  validateBody(updateReportWeekBodySchema),
  handle("진도 저장", async (req, res) => {
    try {
      const cls = await loadClass(req, req.params.classId);
      const week = await ensureWeek(req, cls, parseWeek(req.params.weekStart));
      const [row] = await db.update(reportWeeks).set({ ...req.body, updatedAt: new Date() }).where(eq(reportWeeks.id, week.id)).returning();
      res.json(row);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

/**
 * 공개. 이미 공개된 주를 다시 눌러도 처음 공개한 시각·사람을 덮지 않는다
 * ("언제부터 부모님이 볼 수 있었나" 는 바뀌면 안 되는 사실이다).
 */
router.post(
  `${P}/classes/:classId/weeks/:weekStart/publish`,
  ...guards,
  handle("리포트 공개", async (req, res) => {
    try {
      const cls = await loadClass(req, req.params.classId);
      const week = await ensureWeek(req, cls, parseWeek(req.params.weekStart));
      if (week.publishedAt) return res.json(week);
      const [row] = await db
        .update(reportWeeks)
        .set({ publishedAt: new Date(), publishedBy: req.user!.id, updatedAt: new Date() })
        .where(eq(reportWeeks.id, week.id))
        .returning();
      res.json(row);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

router.post(
  `${P}/classes/:classId/weeks/:weekStart/unpublish`,
  ...guards,
  handle("공개 취소", async (req, res) => {
    try {
      const cls = await loadClass(req, req.params.classId);
      const week = await findWeek(cls.id, parseWeek(req.params.weekStart));
      if (!week) return res.status(404).json({ error: "이 주의 기록이 없습니다." });
      const [row] = await db
        .update(reportWeeks)
        .set({ publishedAt: null, publishedBy: null, updatedAt: new Date() })
        .where(eq(reportWeeks.id, week.id))
        .returning();
      res.json(row);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

// ─── 숙제 ────────────────────────────────────────────────────────────────

router.post(
  `${P}/classes/:classId/weeks/:weekStart/homework`,
  ...guards,
  validateBody(homeworkItemBodySchema),
  handle("숙제 등록", async (req, res) => {
    try {
      const cls = await loadClass(req, req.params.classId);
      const week = await ensureWeek(req, cls, parseWeek(req.params.weekStart));
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(homeworkItems).where(eq(homeworkItems.reportWeekId, week.id));
      const [row] = await db
        .insert(homeworkItems)
        .values({ ...req.body, sortOrder: req.body.sortOrder ?? n, tenantId: cls.tenantId, reportWeekId: week.id })
        .returning();
      res.status(201).json(row);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

router.patch(
  `${P}/homework/:itemId`,
  ...guards,
  validateBody(updateHomeworkItemBodySchema),
  handle("숙제 수정", async (req, res) => {
    try {
      const { item } = await loadHomeworkItem(req, req.params.itemId);
      const [row] = await db.update(homeworkItems).set(req.body).where(eq(homeworkItems.id, item.id)).returning();
      // 총 개수를 바꾸면 이미 넣은 해온 개수로 상태를 다시 맞춘다. 안 그러면 20→30 으로 고쳤을 때
      // 20개 해온 학생이 "완료" 로 남는다.
      if (req.body.totalCount !== undefined) await rederiveChecks(row);
      res.json(row);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

async function rederiveChecks(item: HomeworkItem) {
  if (item.totalCount == null) return;
  const rows = await db.select().from(homeworkChecks).where(eq(homeworkChecks.homeworkItemId, item.id));
  for (const c of rows) {
    if (c.doneCount == null) continue;
    const status = deriveHomeworkStatus(item.totalCount, c.doneCount, c.status as HomeworkStatus);
    if (status !== c.status) await db.update(homeworkChecks).set({ status }).where(eq(homeworkChecks.id, c.id));
  }
}

router.delete(
  `${P}/homework/:itemId`,
  ...guards,
  handle("숙제 삭제", async (req, res) => {
    try {
      const { item } = await loadHomeworkItem(req, req.params.itemId);
      await db.delete(homeworkItems).where(eq(homeworkItems.id, item.id));
      res.json({ message: "숙제가 삭제되었습니다." });
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

/**
 * 검사 결과 저장(여러 학생 한 번에). 해온 개수가 있으면 상태는 서버가 정한다(deriveHomeworkStatus).
 * 개수 있는 숙제에서 "완료" 만 고르면 해온 개수를 총 개수로, "안함" 이면 0 으로 채운다 —
 * 그래야 부모님 화면의 게이지와 "N문항 모자랍니다" 가 버튼과 어긋나지 않는다.
 */
router.put(
  `${P}/homework/:itemId/checks`,
  ...guards,
  validateBody(homeworkChecksBodySchema),
  handle("숙제 검사 저장", async (req, res) => {
    try {
      const { item, week } = await loadHomeworkItem(req, req.params.itemId);
      const roster = await loadRoster(item.tenantId, week.classId);
      const input = req.body.checks as z.infer<typeof homeworkChecksBodySchema>["checks"];
      assertInRoster(roster, input.map((c) => c.studentId));
      for (const c of input) {
        let doneCount = c.doneCount ?? null;
        if (doneCount == null && item.totalCount != null) {
          if (c.status === "done") doneCount = item.totalCount;
          if (c.status === "none") doneCount = 0;
        }
        if (doneCount != null && item.totalCount != null) doneCount = Math.min(doneCount, item.totalCount);
        const status = deriveHomeworkStatus(item.totalCount, doneCount, c.status);
        await db
          .insert(homeworkChecks)
          .values({ tenantId: item.tenantId, homeworkItemId: item.id, studentId: c.studentId, status, doneCount, updatedBy: req.user!.id })
          .onConflictDoUpdate({
            target: [homeworkChecks.homeworkItemId, homeworkChecks.studentId],
            set: { status, doneCount, updatedBy: req.user!.id, updatedAt: new Date() },
          });
      }
      res.json({ saved: input.length });
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

/**
 * "전원 완료로 채우기". **아직 검사 안 한 학생만** 채운다.
 * 이미 "일부" 로 고쳐 둔 학생을 다시 완료로 덮으면, 버튼을 실수로 한 번 더 누른 것만으로
 * 선생님이 한 검사가 사라진다.
 */
router.post(
  `${P}/homework/:itemId/fill-done`,
  ...guards,
  handle("전원 완료 채우기", async (req, res) => {
    try {
      const { item, week } = await loadHomeworkItem(req, req.params.itemId);
      const roster = await loadRoster(item.tenantId, week.classId);
      const existing = await db.select().from(homeworkChecks).where(eq(homeworkChecks.homeworkItemId, item.id));
      const checked = new Set(existing.filter((c) => c.status !== "pending").map((c) => c.studentId));
      const targets = roster.filter((s) => !checked.has(s.id));
      for (const s of targets) {
        await db
          .insert(homeworkChecks)
          .values({ tenantId: item.tenantId, homeworkItemId: item.id, studentId: s.id, status: "done", doneCount: item.totalCount, updatedBy: req.user!.id })
          .onConflictDoUpdate({
            target: [homeworkChecks.homeworkItemId, homeworkChecks.studentId],
            set: { status: "done", doneCount: item.totalCount, updatedBy: req.user!.id, updatedAt: new Date() },
          });
      }
      res.json({ filled: targets.length, kept: checked.size });
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

// ─── 시험 ────────────────────────────────────────────────────────────────

router.post(
  `${P}/classes/:classId/weeks/:weekStart/exams`,
  ...guards,
  validateBody(examBodySchema),
  handle("시험 등록", async (req, res) => {
    try {
      const cls = await loadClass(req, req.params.classId);
      const week = await ensureWeek(req, cls, parseWeek(req.params.weekStart));
      if (req.body.retestOf) await loadExam(req, req.body.retestOf);
      const [row] = await db
        .insert(exams)
        .values({
          ...req.body,
          kind: req.body.kind ?? (req.body.retestOf ? "retest" : "weekly"),
          areas: req.body.areas ?? DEFAULT_EXAM_AREAS[cls.subject] ?? DEFAULT_EXAM_AREAS["영어"],
          tenantId: cls.tenantId,
          classId: cls.id,
          reportWeekId: week.id,
          createdBy: req.user!.id,
        })
        .returning();
      res.status(201).json(row);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

router.patch(
  `${P}/exams/:examId`,
  ...guards,
  validateBody(updateExamBodySchema),
  handle("시험 수정", async (req, res) => {
    try {
      const exam = await loadExam(req, req.params.examId);
      if (req.body.retestOf) await loadExam(req, req.body.retestOf);
      const [row] = await db.update(exams).set({ ...req.body, updatedAt: new Date() }).where(eq(exams.id, exam.id)).returning();
      // 영역을 바꾸면 총점을 다시 계산한다(없어진 영역의 점수는 총점에서 빠진다).
      if (req.body.areas) {
        const rows = await db.select().from(examScores).where(eq(examScores.examId, exam.id));
        for (const s of rows) {
          await db.update(examScores).set({ total: examTotal(row.areas, s.areaScores) }).where(eq(examScores.id, s.id));
        }
      }
      res.json(row);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

router.delete(
  `${P}/exams/:examId`,
  ...guards,
  handle("시험 삭제", async (req, res) => {
    try {
      const exam = await loadExam(req, req.params.examId);
      await db.delete(exams).where(eq(exams.id, exam.id));
      res.json({ message: "시험이 삭제되었습니다." });
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

/**
 * 점수 저장(여러 학생 한 번에). 시험 영역에 없는 칸은 버린다 — 화면 버그로 "듣기" 같은 칸이
 * 섞여 들어와도 부모님 화면에 엉뚱한 막대가 생기지 않는다. 총점은 서버가 계산한다.
 */
router.put(
  `${P}/exams/:examId/scores`,
  ...guards,
  validateBody(examScoresBodySchema),
  handle("점수 저장", async (req, res) => {
    try {
      const exam = await loadExam(req, req.params.examId);
      const roster = await loadRoster(exam.tenantId, exam.classId);
      const input = req.body.scores as z.infer<typeof examScoresBodySchema>["scores"];
      assertInRoster(roster, input.map((s) => s.studentId));
      const existing = await db.select().from(examScores).where(eq(examScores.examId, exam.id));
      for (const s of input) {
        const prev = existing.find((e) => e.studentId === s.studentId);
        // 보낸 영역만 바꾼다. 어휘 칸 하나를 고쳤다고 문법·독해 점수가 지워지면 안 된다. null 은 그 칸 지우기.
        const merged: Record<string, number | null> = { ...(prev?.areaScores ?? {}), ...(s.areaScores ?? {}) };
        const areaScores = Object.fromEntries(
          Object.entries(merged).filter((e): e is [string, number] => exam.areas.includes(e[0]) && e[1] != null)
        );
        const absent = s.absent ?? prev?.absent ?? false;
        const comment = s.comment !== undefined ? s.comment : prev?.comment ?? null;
        const total = examTotal(exam.areas, areaScores);
        await db
          .insert(examScores)
          .values({ tenantId: exam.tenantId, examId: exam.id, studentId: s.studentId, areaScores, total, absent, comment, updatedBy: req.user!.id })
          .onConflictDoUpdate({
            target: [examScores.examId, examScores.studentId],
            set: { areaScores, total, absent, comment, updatedBy: req.user!.id, updatedAt: new Date() },
          });
      }
      const rows = await db.select().from(examScores).where(eq(examScores.examId, exam.id));
      res.json({
        saved: input.length,
        stats: examStats(rows.map((r) => ({ studentId: r.studentId, total: r.total, absent: r.absent })), exam.passScore),
      });
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

/** 재시 일괄 등록. 학생을 고르지 않으면 통과 기준 아래인 학생 전원. 보강 일정(사유: 재시)으로 만든다. */
router.post(
  `${P}/exams/:examId/retest`,
  ...guards,
  validateBody(retestBodySchema),
  handle("재시 등록", async (req, res) => {
    try {
      const exam = await loadExam(req, req.params.examId);
      const roster = await loadRoster(exam.tenantId, exam.classId);
      let studentIds: string[] = req.body.studentIds ?? [];
      if (studentIds.length === 0) {
        const rows = await db.select().from(examScores).where(eq(examScores.examId, exam.id));
        studentIds = examStats(rows.map((r) => ({ studentId: r.studentId, total: r.total, absent: r.absent })), exam.passScore).failStudentIds;
      }
      if (studentIds.length === 0) return res.status(400).json({ error: "재시 대상 학생이 없습니다." });
      assertInRoster(roster, studentIds);
      const session = await createMakeup(req, {
        classId: exam.classId,
        examId: exam.id,
        date: req.body.date,
        startTime: req.body.startTime ?? null,
        minutes: req.body.minutes ?? null,
        reason: "retest",
        content: req.body.content || `${exam.name} 재시험`,
        studentIds,
      });
      res.status(201).json(session);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

// ─── 보강 ────────────────────────────────────────────────────────────────

type MakeupInput = z.infer<typeof makeupBodySchema>;

async function createMakeup(req: Request, body: MakeupInput) {
  return await db.transaction(async (tx) => {
    const [session] = await tx
      .insert(makeupSessions)
      .values({
        tenantId: tenantOf(req),
        classId: body.classId ?? null,
        examId: body.examId ?? null,
        date: body.date,
        startTime: body.startTime ?? null,
        minutes: body.minutes ?? null,
        reason: body.reason ?? "other",
        content: body.content,
        createdBy: req.user!.id,
      })
      .returning();
    const unique = Array.from(new Set(body.studentIds));
    await tx.insert(makeupStudents).values(unique.map((studentId) => ({ tenantId: session.tenantId, makeupId: session.id, studentId })));
    return { ...session, studentIds: unique };
  });
}

async function loadMakeup(req: Request, makeupId: string) {
  if (!idParam.safeParse(makeupId).success) throw new HttpError(400, "유효하지 않은 보강 ID 입니다.");
  const [row] = await db.select().from(makeupSessions).where(and(eq(makeupSessions.id, makeupId), eq(makeupSessions.tenantId, tenantOf(req))));
  if (!row) throw new HttpError(404, "보강을 찾을 수 없습니다.");
  return row;
}

router.post(
  `${P}/makeups`,
  ...guards,
  validateBody(makeupBodySchema),
  handle("보강 등록", async (req, res) => {
    try {
      const body = req.body as MakeupInput;
      if (body.classId) {
        await loadClass(req, body.classId);
      }
      if (body.examId) await loadExam(req, body.examId);
      const rows = await loadStudentsOfTenant(req, body.studentIds);
      if (rows.some((s) => !s.isActive)) return res.status(400).json({ error: "퇴원한 학생은 보강에 넣을 수 없습니다." });
      res.status(201).json(await createMakeup(req, body));
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

router.patch(
  `${P}/makeups/:makeupId`,
  ...guards,
  validateBody(updateMakeupBodySchema),
  handle("보강 수정", async (req, res) => {
    try {
      const m = await loadMakeup(req, req.params.makeupId);
      const [row] = await db.update(makeupSessions).set({ ...req.body, updatedAt: new Date() }).where(eq(makeupSessions.id, m.id)).returning();
      res.json(row);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

router.delete(
  `${P}/makeups/:makeupId`,
  ...guards,
  handle("보강 삭제", async (req, res) => {
    try {
      const m = await loadMakeup(req, req.params.makeupId);
      await db.delete(makeupSessions).where(eq(makeupSessions.id, m.id));
      res.json({ message: "보강이 삭제되었습니다." });
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

router.patch(
  `${P}/makeups/:makeupId/students/:studentId`,
  ...guards,
  validateBody(makeupStudentStatusBodySchema),
  handle("보강 상태 변경", async (req, res) => {
    try {
      const m = await loadMakeup(req, req.params.makeupId);
      if (!idParam.safeParse(req.params.studentId).success) return res.status(400).json({ error: "유효하지 않은 학생 ID 입니다." });
      const [row] = await db
        .update(makeupStudents)
        .set({ status: req.body.status, updatedAt: new Date() })
        .where(and(eq(makeupStudents.makeupId, m.id), eq(makeupStudents.studentId, req.params.studentId)))
        .returning();
      if (!row) return res.status(404).json({ error: "이 보강에 없는 학생입니다." });
      res.json(row);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

// ─── 노트 사진 ───────────────────────────────────────────────────────────

const photoQuerySchema = z.object({
  title: z.string().trim().min(1, "사진 제목이 필요합니다.").max(60),
  takenDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "날짜는 YYYY-MM-DD 형식이어야 합니다."),
  studentId: z.string().uuid().optional(),
  width: z.coerce.number().int().min(1).max(10000).optional(),
  height: z.coerce.number().int().min(1).max(10000).optional(),
});

/**
 * 사진 올리기. 본문은 이미지 바이트 그대로(화면이 줄여서 보낸다), 정보는 주소 뒤 ?title=… 로 받는다.
 * multipart 를 쓰지 않는 이유: 사진 한 장에 정보 몇 칸이라 원본 바이트를 그대로 보내는 편이
 * 검사할 곳이 적다. 형식은 Content-Type 이 아니라 파일 앞머리로 판정한다(photoStore.detectImageMime).
 */
router.post(
  `${P}/classes/:classId/weeks/:weekStart/photos`,
  ...guards,
  express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }),
  handle("사진 올리기", async (req, res) => {
    try {
      const cls = await loadClass(req, req.params.classId);
      const weekStart = parseWeek(req.params.weekStart);
      const q = photoQuerySchema.safeParse(req.query);
      if (!q.success) return res.status(400).json({ error: q.error.errors[0]?.message ?? "사진 정보가 올바르지 않습니다." });
      const data = req.body;
      if (!Buffer.isBuffer(data) || data.length === 0) return res.status(400).json({ error: "사진 파일이 비어 있습니다." });
      const mime = detectImageMime(data);
      if (!mime) return res.status(400).json({ error: "JPG·PNG·WEBP 사진만 올릴 수 있습니다." });
      if (q.data.studentId) assertInRoster(await loadRoster(cls.tenantId, cls.id), [q.data.studentId]);
      const week = await ensureWeek(req, cls, weekStart);
      const row = await savePhoto(
        {
          tenantId: cls.tenantId,
          reportWeekId: week.id,
          studentId: q.data.studentId ?? null,
          title: q.data.title,
          takenDate: q.data.takenDate,
          width: q.data.width ?? null,
          height: q.data.height ?? null,
          createdBy: req.user!.id,
        },
        data,
        mime
      );
      res.status(201).json(row);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

async function loadPhotoRow(req: Request, photoId: string) {
  if (!idParam.safeParse(photoId).success) throw new HttpError(400, "유효하지 않은 사진 ID 입니다.");
  const [row] = await db.select().from(notePhotos).where(and(eq(notePhotos.id, photoId), eq(notePhotos.tenantId, tenantOf(req))));
  if (!row) throw new HttpError(404, "사진을 찾을 수 없습니다.");
  return row;
}

router.get(
  `${P}/photos/:photoId/image`,
  ...guards,
  handle("사진 보기", async (req, res) => {
    try {
      const row = await loadPhotoRow(req, req.params.photoId);
      if (row.purgedAt) return res.status(410).json({ error: "보관 기간이 지난 사진입니다." });
      const file = await readPhoto(row.id);
      if (!file) return res.status(404).json({ error: "사진 파일이 없습니다." });
      res.setHeader("Content-Type", file.mime);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.end(file.data);
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

router.delete(
  `${P}/photos/:photoId`,
  ...guards,
  handle("사진 삭제", async (req, res) => {
    try {
      const row = await loadPhotoRow(req, req.params.photoId);
      await deletePhoto(row.id);
      res.json({ message: "사진이 삭제되었습니다." });
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

// ─── 부모님 링크 ─────────────────────────────────────────────────────────

/**
 * 반 명단 + 링크 상태. 토큰을 그대로 내려 주는 것은 원장·강사가 "복사" 해서 카톡으로 보내야 하기
 * 때문이다. 화면 밖(로그)으로는 찍지 않는다.
 */
router.get(
  `${P}/classes/:classId/links`,
  ...guards,
  handle("링크 목록", async (req, res) => {
    try {
      const cls = await loadClass(req, req.params.classId);
      const roster = await loadRoster(cls.tenantId, cls.id);
      const links = roster.length
        ? await db
            .select()
            .from(parentLinks)
            .where(and(inArray(parentLinks.studentId, roster.map((s) => s.id)), isNull(parentLinks.revokedAt)))
        : [];
      res.json(
        roster.map((s) => {
          const link = links.find((l) => l.studentId === s.id);
          return {
            studentId: s.id,
            name: s.name,
            phoneMasked: maskPhone(s.parentPhone),
            canIssue: phoneLast4(s.parentPhone) != null,
            link: link ? linkInfo(link) : null,
          };
        })
      );
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

function linkInfo(l: typeof parentLinks.$inferSelect) {
  return {
    token: l.token,
    path: `${PARENT_LINK_PREFIX}${l.token}`,
    createdAt: l.createdAt,
    lastViewedAt: l.lastViewedAt,
    viewCount: l.viewCount,
    lockedUntil: l.lockedUntil,
  };
}

async function loadLinkStudent(req: Request, studentId: string) {
  if (!idParam.safeParse(studentId).success) throw new HttpError(400, "유효하지 않은 학생 ID 입니다.");
  const [s] = await loadStudentsOfTenant(req, [studentId]);
  if (!s.isActive) throw new HttpError(400, "퇴원한 학생은 링크를 만들 수 없습니다.");
  if (phoneLast4(s.parentPhone) == null) throw new HttpError(400, "보호자 번호가 없어 링크를 만들 수 없습니다. 학생 관리에서 번호를 먼저 넣어 주세요.");
  return s;
}

async function activeLink(studentId: string) {
  const [row] = await db.select().from(parentLinks).where(and(eq(parentLinks.studentId, studentId), isNull(parentLinks.revokedAt)));
  return row ?? null;
}

/** Postgres 유니크 위반. 두 번 눌렀거나(학생당 하나), 극히 드물게 토큰이 겹쳤을 때. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23505";
}

async function insertLink(req: Request, tenantId: string, studentId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [row] = await db
        .insert(parentLinks)
        .values({ tenantId, studentId, token: generateShareToken(), createdBy: req.user!.id })
        .returning();
      return row;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await activeLink(studentId);
      if (existing) return existing; // 다른 요청이 먼저 만들었다 — 그걸 쓴다
    }
  }
  throw new Error("링크 토큰을 만들지 못했습니다.");
}

/** 링크 받기. 이미 살아 있는 링크가 있으면 그것을 돌려준다 — 누를 때마다 새 주소가 생기면 앞서 보낸 카톡이 죽는다. */
router.post(
  `${P}/students/:studentId/link`,
  ...guards,
  handle("링크 만들기", async (req, res) => {
    try {
      const s = await loadLinkStudent(req, req.params.studentId);
      const existing = await activeLink(s.id);
      if (existing) return res.json(linkInfo(existing));
      res.status(201).json(linkInfo(await insertLink(req, tenantOf(req), s.id)));
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

/** 재발급. 기존 링크를 닫고 새로 만든다. 잘못 전달된 링크를 막는 유일한 방법이다. */
router.post(
  `${P}/students/:studentId/link/reissue`,
  ...guards,
  handle("링크 재발급", async (req, res) => {
    try {
      const s = await loadLinkStudent(req, req.params.studentId);
      await db
        .update(parentLinks)
        .set({ revokedAt: new Date() })
        .where(and(eq(parentLinks.studentId, s.id), isNull(parentLinks.revokedAt)));
      res.status(201).json(linkInfo(await insertLink(req, tenantOf(req), s.id)));
    } catch (err) {
      if (!sendHttpError(res, err)) throw err;
    }
  })
);

export default router;
