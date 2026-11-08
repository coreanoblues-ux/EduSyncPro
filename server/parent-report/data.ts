/**
 * 부모님 화면에 넘길 값을 **골라 담는다** (allowlist).
 *
 * 이 파일이 부모님 화면과 DB 사이의 유일한 통로다. 여기서 꺼내지 않은 칸은 화면에 나갈 길이 없다.
 * 그래서 **보호자 번호 · 학교 · 학생 메모 · 수납/결제 · 다른 학생의 이름·점수** 는 쿼리 단계에서
 * 아예 고르지 않는다(PLAN §4). 반 평균·상위 % 는 숫자로만 내보내고 누가 몇 점인지는 내보내지 않는다.
 *
 * 공개 규칙(PLAN §6): 기록(진도·숙제·점수·사진)은 **공개된 주**만. 일정(보강·재시)은 등록 즉시.
 * preview(선생님 미리보기)일 때만 공개 전 주도 읽는다.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "../db";
import {
  tenants,
  students,
  classes,
  enrollments,
  reportWeeks,
  homeworkItems,
  homeworkChecks,
  exams,
  examScores,
  makeupSessions,
  makeupStudents,
  notePhotos,
  vocabScores,
  studentClinicLevels,
  clinicDays,
  clinicScores,
  type HomeworkStatus,
} from "@shared/schema";
import { addDays, todayKst } from "@shared/day";
import {
  weekLabel,
  examStats,
  homeworkShortfall,
  mondayOf,
  vocabResult,
  isCountLevel,
  MIN_TAKERS_FOR_RANK,
  type VocabResult,
} from "@shared/learningReport";

export type ParentView = {
  academyName: string;
  student: { name: string; grade: string | null };
  classes: { id: string; name: string }[];
  classId: string | null;
  className: string | null;
  today: string;
  week: {
    weekStart: string;
    label: string;
    textbook: string | null;
    unit: string | null;
    topic: string | null;
    progressPct: number | null;
    published: boolean;
  } | null;
  /** 앞뒤로 볼 수 있는 주(공개된 주만, 미리보기면 전부). */
  prevWeek: string | null;
  nextWeek: string | null;
  homework: {
    title: string;
    totalCount: number | null;
    countUnit: string | null;
    dueDate: string | null;
    status: HomeworkStatus;
    doneCount: number | null;
    shortfall: number | null;
  }[];
  exams: {
    id: string;
    name: string;
    kind: string;
    examDate: string;
    passScore: number | null;
    areas: string[];
    areaScores: Record<string, number>;
    total: number | null;
    absent: boolean;
    comment: string | null;
    takers: number;
    average: number | null;
    topPct: number | null;
    passed: boolean | null;
  }[];
  /** 이 반에서 본 최근 시험 5개의 내 점수 (오래된 것 → 최근). */
  trend: { date: string; name: string; total: number }[];
  /** 지난 주들의 숙제 요약 (최근 3주). */
  history: { weekStart: string; label: string; done: number; partial: number; none: number; total: number }[];
  photos: { id: string; title: string; takenDate: string; purged: boolean }[];
  /** 클리닉 단계. 안 듣거나(none) 아직 안 정했으면 null — 부모님 화면에 클리닉 칸이 안 나온다. */
  clinicLevel: string | null;
  /** 이 주의 클리닉 결과 (공개된 클리닉 날만). 같은 단계 평균은 응시 5명 이상일 때만 숫자로. */
  clinic: {
    date: string;
    level: string;
    paper: string | null;
    score: number | null;
    correct: number | null;
    total: number | null;
    reviewDone: boolean;
    levelAverage: number | null;
  }[];
  /** 최근 클리닉 5회 (오래된 것 → 최근). value 는 점수, 듣기는 정답률(%). */
  clinicTrend: { date: string; level: string; value: number }[];
  /** 이번 주 단어시험 (기록이 있는 날만). 판정은 vocabResult 로 계산한 값. */
  vocab: { date: string; total: number; wrong: number; result: VocabResult; retestPassed: boolean | null }[];
  /** 보강·재시 일정. 지난 2주 + 앞으로. 공개와 상관없이 보인다. */
  schedule: { date: string; startTime: string | null; minutes: number | null; content: string; reason: string; status: string }[];
};

/** 학생 한 명이 지금 볼 수 있는 상태인가. 퇴원(isActive=false)이면 null — 링크가 저절로 닫힌다. */
export async function loadParentStudent(tenantId: string, studentId: string) {
  const [s] = await db
    .select({ id: students.id, name: students.name, grade: students.grade, parentPhone: students.parentPhone, isActive: students.isActive })
    .from(students)
    .where(and(eq(students.id, studentId), eq(students.tenantId, tenantId)));
  return s && s.isActive ? s : null;
}

type BuildOpts = Parameters<typeof buildClassView>[0];

/**
 * 부모님 화면 값 전체. 반 기록(buildClassView) 위에 클리닉을 붙인다 — 클리닉은 반이 섞이고 공개도
 * 클리닉 날마다 따로라서, 반의 공개된 주가 아직 없어도 클리닉 결과는 보일 수 있다.
 */
export async function buildParentView(opts: BuildOpts): Promise<ParentView | null> {
  const v = await buildClassView(opts);
  if (!v) return null;
  const weekStart = v.week?.weekStart ?? mondayOf(v.today);
  await attachClinic(v, opts.tenantId, opts.studentId, weekStart, !!opts.preview);
  return v;
}

async function attachClinic(v: ParentView, tenantId: string, studentId: string, weekStart: string, preview: boolean) {
  const [lv] = await db.select({ level: studentClinicLevels.level }).from(studentClinicLevels).where(eq(studentClinicLevels.studentId, studentId));
  v.clinicLevel = lv && lv.level !== "none" ? lv.level : null;

  const visible = and(eq(clinicDays.tenantId, tenantId), preview ? undefined : isNotNull(clinicDays.publishedAt));
  const mine = await db
    .select({
      dayId: clinicDays.id,
      date: clinicDays.date,
      papers: clinicDays.papers,
      level: clinicScores.level,
      score: clinicScores.score,
      correct: clinicScores.correct,
      total: clinicScores.total,
      reviewDone: clinicScores.reviewDone,
    })
    .from(clinicScores)
    .innerJoin(clinicDays, eq(clinicDays.id, clinicScores.clinicDayId))
    .where(and(visible, eq(clinicScores.studentId, studentId)))
    .orderBy(desc(clinicDays.date));

  const valueOf = (r: { level: string; score: number | null; correct: number | null; total: number | null }) =>
    isCountLevel(r.level) ? (r.correct != null && r.total ? Math.round((r.correct / r.total) * 100) : null) : r.score;

  v.clinicTrend = mine
    .filter((r) => r.date <= addDays(weekStart, 6))
    .slice(0, 5)
    .map((r) => ({ date: r.date, level: r.level, value: valueOf(r) }))
    .filter((r): r is { date: string; level: string; value: number } => r.value != null)
    .reverse();

  const thisWeek = mine.filter((r) => r.date >= weekStart && r.date <= addDays(weekStart, 6));
  for (const r of thisWeek) {
    // 같은 날 같은 단계 평균 — 숫자만 내보낸다(누가 몇 점인지는 나가지 않는다). 5명 미만이면 숨긴다.
    const peers = await db
      .select({ level: clinicScores.level, score: clinicScores.score, correct: clinicScores.correct, total: clinicScores.total })
      .from(clinicScores)
      .where(and(eq(clinicScores.clinicDayId, r.dayId), eq(clinicScores.level, r.level)));
    const vals = peers.map(valueOf).filter((x): x is number => x != null);
    v.clinic.push({
      date: r.date,
      level: r.level,
      paper: (r.papers as Record<string, string>)?.[r.level] || null,
      score: r.score,
      correct: r.correct,
      total: r.total,
      reviewDone: r.reviewDone,
      levelAverage: vals.length >= MIN_TAKERS_FOR_RANK ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null,
    });
  }
  v.clinic.reverse();
}

async function buildClassView(opts: {
  tenantId: string;
  studentId: string;
  /** 주소의 ?c= — 두 반을 듣는 학생만 쓴다. 이 학생의 반이 아니면 무시한다. */
  classId?: string;
  /** 주소의 ?w= — 지난 주 보기. 볼 수 있는 주가 아니면 무시한다. */
  weekStart?: string;
  preview?: boolean;
}): Promise<ParentView | null> {
  const { tenantId, studentId, preview = false } = opts;
  const today = todayKst();

  const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const student = await loadParentStudent(tenantId, studentId);
  if (!tenant || !student) return null;

  const myClasses = await db
    .selectDistinct({ id: classes.id, name: classes.name })
    .from(enrollments)
    .innerJoin(classes, eq(classes.id, enrollments.classId))
    .where(and(eq(enrollments.studentId, studentId), eq(enrollments.tenantId, tenantId), eq(enrollments.isActive, true), eq(classes.isActive, true)))
    .orderBy(asc(classes.name));
  const cls = myClasses.find((c) => c.id === opts.classId) ?? myClasses[0] ?? null;

  const schedule = await loadSchedule(studentId, addDays(today, -14));

  const base: ParentView = {
    academyName: tenant.name,
    student: { name: student.name, grade: student.grade },
    classes: myClasses,
    classId: cls?.id ?? null,
    className: cls?.name ?? null,
    today,
    week: null,
    prevWeek: null,
    nextWeek: null,
    homework: [],
    exams: [],
    trend: [],
    history: [],
    photos: [],
    vocab: [],
    clinicLevel: null,
    clinic: [],
    clinicTrend: [],
    schedule,
  };
  if (!cls) return base;

  // 볼 수 있는 주 목록. 부모님은 공개된 주만, 미리보기는 기록이 있는 주 전부 + 요청한 주.
  const weekRows = await db
    .select()
    .from(reportWeeks)
    .where(and(eq(reportWeeks.classId, cls.id), preview ? undefined : isNotNull(reportWeeks.publishedAt)))
    .orderBy(desc(reportWeeks.weekStart));
  const wanted = opts.weekStart && /^\d{4}-\d{2}-\d{2}$/.test(opts.weekStart) ? mondayOf(opts.weekStart) : null;
  const idx = wanted ? weekRows.findIndex((w) => w.weekStart === wanted) : 0;
  const week = idx >= 0 ? weekRows[idx] : weekRows[0];
  if (!week) return base;

  const i = weekRows.indexOf(week);
  base.prevWeek = weekRows[i + 1]?.weekStart ?? null;
  base.nextWeek = i > 0 ? weekRows[i - 1].weekStart : null;
  base.week = {
    weekStart: week.weekStart,
    label: weekLabel(week.weekStart),
    textbook: week.textbook,
    unit: week.unit,
    topic: week.topic,
    progressPct: week.progressPct,
    published: !!week.publishedAt,
  };

  // ── 숙제 (이 학생 것만) ──
  const items = await db.select().from(homeworkItems).where(eq(homeworkItems.reportWeekId, week.id)).orderBy(asc(homeworkItems.sortOrder), asc(homeworkItems.createdAt));
  const myChecks = items.length
    ? await db
        .select({ itemId: homeworkChecks.homeworkItemId, status: homeworkChecks.status, doneCount: homeworkChecks.doneCount })
        .from(homeworkChecks)
        .where(and(inArray(homeworkChecks.homeworkItemId, items.map((x) => x.id)), eq(homeworkChecks.studentId, studentId)))
    : [];
  base.homework = items.map((it) => {
    const c = myChecks.find((x) => x.itemId === it.id);
    const status = (c?.status ?? "pending") as HomeworkStatus;
    const doneCount = c?.doneCount ?? null;
    return {
      title: it.title,
      totalCount: it.totalCount,
      countUnit: it.countUnit,
      dueDate: it.dueDate,
      status,
      doneCount,
      shortfall: status === "partial" ? homeworkShortfall(it.totalCount, doneCount) : null,
    };
  });

  // ── 시험: 내 점수 + 반 통계(숫자만). 다른 학생의 이름·점수는 내보내지 않는다 ──
  const examRows = await db.select().from(exams).where(eq(exams.reportWeekId, week.id)).orderBy(asc(exams.examDate), asc(exams.createdAt));
  if (examRows.length) {
    const scores = await db
      .select({ examId: examScores.examId, studentId: examScores.studentId, total: examScores.total, absent: examScores.absent, areaScores: examScores.areaScores, comment: examScores.comment })
      .from(examScores)
      .where(inArray(examScores.examId, examRows.map((e) => e.id)));
    base.exams = examRows
      .map((e) => {
        const mine = scores.filter((s) => s.examId === e.id);
        const me = mine.find((s) => s.studentId === studentId);
        const stats = examStats(mine.map((s) => ({ studentId: s.studentId, total: s.total, absent: s.absent })), e.passScore);
        return {
          id: e.id,
          name: e.name,
          kind: e.kind,
          examDate: e.examDate,
          passScore: e.passScore,
          areas: e.areas,
          areaScores: me?.areaScores ?? {},
          total: me?.total ?? null,
          absent: me?.absent ?? false,
          comment: me?.comment ?? null,
          takers: stats.takers,
          average: stats.average,
          topPct: stats.topPct[studentId] ?? null,
          passed: me?.total == null || e.passScore == null || me.absent ? null : me.total >= e.passScore,
        };
      })
      // 이 학생이 안 본(점수가 없는) 시험은 부모님께 빈 카드로 보여 줄 이유가 없다.
      .filter((e) => e.total != null || e.absent);
  }

  // ── 최근 추이: 이 반의 볼 수 있는 주들에서 내 점수 5개 ──
  const visibleWeekIds = weekRows.filter((w) => w.weekStart <= week.weekStart).map((w) => w.id);
  if (visibleWeekIds.length) {
    const rows = await db
      .select({ date: exams.examDate, name: exams.name, total: examScores.total })
      .from(examScores)
      .innerJoin(exams, eq(exams.id, examScores.examId))
      .where(and(inArray(exams.reportWeekId, visibleWeekIds), eq(examScores.studentId, studentId), eq(examScores.absent, false), isNotNull(examScores.total)))
      .orderBy(desc(exams.examDate), desc(exams.createdAt))
      .limit(5);
    base.trend = rows.reverse().map((r) => ({ date: r.date, name: r.name, total: r.total! }));
  }

  // ── 지난 숙제 기록: 이 주 앞의 볼 수 있는 주 3개 ──
  const earlier = weekRows.slice(i + 1, i + 4);
  for (const w of earlier) {
    const its = await db.select({ id: homeworkItems.id }).from(homeworkItems).where(eq(homeworkItems.reportWeekId, w.id));
    if (!its.length) continue;
    const cs = await db
      .select({ status: homeworkChecks.status })
      .from(homeworkChecks)
      .where(and(inArray(homeworkChecks.homeworkItemId, its.map((x) => x.id)), eq(homeworkChecks.studentId, studentId)));
    base.history.push({
      weekStart: w.weekStart,
      label: weekLabel(w.weekStart),
      total: its.length,
      done: cs.filter((c) => c.status === "done").length,
      partial: cs.filter((c) => c.status === "partial").length,
      none: cs.filter((c) => c.status === "none").length,
    });
  }

  // ── 노트 사진: 반 전체 것 + 이 학생 것만 ──
  const photos = await db
    .select({ id: notePhotos.id, title: notePhotos.title, takenDate: notePhotos.takenDate, purgedAt: notePhotos.purgedAt })
    .from(notePhotos)
    .where(and(eq(notePhotos.reportWeekId, week.id), or(isNull(notePhotos.studentId), eq(notePhotos.studentId, studentId))))
    .orderBy(asc(notePhotos.takenDate), asc(notePhotos.createdAt));
  base.photos = photos.map((p) => ({ id: p.id, title: p.title, takenDate: p.takenDate, purged: !!p.purgedAt }));

  // ── 단어시험: 이 학생 것만, 이 주 것만 ──
  const vocabRows = await db
    .select({ date: vocabScores.testDate, total: vocabScores.total, wrong: vocabScores.wrong, retestPassed: vocabScores.retestPassed })
    .from(vocabScores)
    .where(and(eq(vocabScores.reportWeekId, week.id), eq(vocabScores.studentId, studentId)))
    .orderBy(asc(vocabScores.testDate));
  base.vocab = vocabRows.map((v) => ({ ...v, result: vocabResult(v.total, v.wrong) }));

  return base;
}

async function loadSchedule(studentId: string, from: string) {
  const rows = await db
    .select({
      date: makeupSessions.date,
      startTime: makeupSessions.startTime,
      minutes: makeupSessions.minutes,
      content: makeupSessions.content,
      reason: makeupSessions.reason,
      status: makeupStudents.status,
    })
    .from(makeupStudents)
    .innerJoin(makeupSessions, eq(makeupSessions.id, makeupStudents.makeupId))
    .where(and(eq(makeupStudents.studentId, studentId), gte(makeupSessions.date, from)))
    .orderBy(asc(makeupSessions.date), asc(makeupSessions.startTime));
  return rows;
}

/**
 * 부모님이 이 사진을 볼 수 있는가. 사진 주소만 알아서는 안 되고,
 * ① 같은 학원 ② 이 학생의 반 ③ 반 전체 사진이거나 이 학생 것 ④ 공개된 주 ⑤ 보관 기간 안 — 모두 맞아야 한다.
 */
export async function canParentSeePhoto(tenantId: string, studentId: string, photoId: string): Promise<boolean> {
  const [row] = await db
    .select({ studentId: notePhotos.studentId, purgedAt: notePhotos.purgedAt, classId: reportWeeks.classId, publishedAt: reportWeeks.publishedAt })
    .from(notePhotos)
    .innerJoin(reportWeeks, eq(reportWeeks.id, notePhotos.reportWeekId))
    .where(and(eq(notePhotos.id, photoId), eq(notePhotos.tenantId, tenantId)));
  if (!row || row.purgedAt || !row.publishedAt) return false;
  if (row.studentId && row.studentId !== studentId) return false;
  const [enrolled] = await db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(and(eq(enrollments.studentId, studentId), eq(enrollments.classId, row.classId), eq(enrollments.isActive, true)));
  return !!enrolled;
}
