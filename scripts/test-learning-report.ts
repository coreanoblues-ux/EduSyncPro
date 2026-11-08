/**
 * 학부모 학습 리포트 — 선생님용 API 검증. `npm run test:learning-report`
 *
 * ════════════════════════════════════════════════════════════════════════
 * 무엇을 못 박는가
 * ════════════════════════════════════════════════════════════════════════
 *   · 문단속 — 토큰 없이 401, 다른 학원 반·학생은 404, 반 명단 밖 학생은 400
 *   · 숙제 — 해온 개수가 상태를 이긴다(20개 중 14개면 "일부"), "전원 완료" 는
 *     **이미 검사한 학생을 덮지 않는다** (실수로 두 번 눌러도 검사가 안 사라진다)
 *   · 시험 — 총점은 영역 평균 반올림(88·76·90 → 85), 영역 하나만 고쳐도 나머지가 남는다,
 *     시험에 없는 영역은 버린다, 상위 % 는 응시 5명 미만이면 숨긴다
 *   · 공개 — 다시 눌러도 처음 공개 시각이 바뀌지 않는다
 *   · 사진 — 이미지가 아닌 파일은 거절, 6개월 지난 사진은 **원본만** 지우고 행은 남긴다
 *   · 링크 — 두 번 눌러도 같은 주소, 재발급하면 옛 주소는 닫힌다, 주소는 /p/ (레벨테스트 /r/ 와 안 겹침)
 *
 * ════════════════════════════════════════════════════════════════════════
 * ⚠️ 이 테스트는 실제 DB 에 쓴다
 * ════════════════════════════════════════════════════════════════════════
 *   로컬 DB 가 따로 없어 운영 DB 를 쓴다(test:projects 와 같다). 그래서 규칙이 있다:
 *     · 실제 반 하나를 빌리되, 기록은 **2000-01-03 주** 에만 쓴다. 실제 수업 주와 겹칠 수 없다.
 *     · 보강·링크는 만든 id 를 적어 두고 finally 에서 그것만 지운다.
 *     · 링크는 **이미 살아 있는 링크가 없는 학생**에게만 만든다 — 실제로 보낸 링크를 닫지 않으려고.
 *     · 학생·수강·결제·상담 테이블은 읽기만 한다. 시작·끝 개수를 세어 무변동을 증명한다.
 */

import "dotenv/config";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  users,
  classes,
  enrollments,
  students,
  payments,
  consultations,
  tasks,
  reportWeeks,
  notePhotos,
  makeupSessions,
  parentLinks,
  vocabScores,
  DEFAULT_EXAM_AREAS,
} from "@shared/schema";
import { mondayOf, weekLabel, examStats, examTotal, deriveHomeworkStatus, phoneLast4, vocabResult, weekDatesFor } from "@shared/learningReport";
import { generateToken } from "../server/middleware/auth";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}\n`);
  }
}

const TEST_WEEK = "2000-01-03"; // 월요일. 실제 수업 기록이 생길 수 없는 날짜.
const RANDOM_UUID = "00000000-0000-4000-8000-000000000000";

async function snapshot() {
  const count = async (t: any) => (await db.select({ n: sql<number>`count(*)::int` }).from(t))[0].n;
  const [sum] = await db.select({ s: sql<string>`coalesce(sum(amount),0)::text` }).from(payments);
  return {
    students: await count(students),
    enrollments: await count(enrollments),
    payments: await count(payments),
    paymentSum: sum.s,
    consultations: await count(consultations),
    tasks: await count(tasks),
  };
}

/** 가장 작은 진짜 JPEG 머리. 내용은 화면에 안 그려지지만 앞머리 판정은 통과한다. */
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0test-learning-report")]);

async function main() {
  console.log("\n학부모 학습 리포트 — 선생님용 API 테스트\n");

  /* ── 계산 규칙 (DB 없이) ─────────────────────────────────────────────── */
  console.log("계산 규칙:");

  await test("주의 월요일: 목요일·일요일 → 그 주 월요일", () => {
    assert.equal(mondayOf("2026-11-06"), "2026-11-02");
    assert.equal(mondayOf("2026-11-08"), "2026-11-02"); // 일요일은 앞 주
    assert.equal(mondayOf("2026-11-09"), "2026-11-09");
    assert.equal(weekLabel("2026-11-02"), "11월 1주차");
  });

  await test("총점은 영역 평균 반올림 (88·76·90 → 85)", () => {
    assert.equal(examTotal(["어휘", "문법", "독해"], { 어휘: 88, 문법: 76, 독해: 90 }), 85);
    assert.equal(examTotal(["어휘"], {}), null);
  });

  await test("상위 %: 10명 중 2등이면 20%, 5명 미만이면 숨김", () => {
    const totals = [92, 85, 80, 78, 74, 72, 70, 66, 58, 50];
    const rows = totals.map((t, i) => ({ studentId: `s${i}`, total: t }));
    const s = examStats(rows, 70);
    assert.equal(s.topPct["s1"], 20);
    assert.equal(s.average, 72.5);
    assert.equal(s.passCount, 7);
    assert.deepEqual(s.failStudentIds, ["s7", "s8", "s9"]);
    assert.deepEqual(examStats(rows.slice(0, 4), 70).topPct, {});
  });

  await test("단어시험 판정: 50문항 5개 통과 · 7개 반복쓰기 · 8개 재시험 (경계 포함)", () => {
    assert.equal(vocabResult(50, 5), "pass"); // 10%
    assert.equal(vocabResult(50, 6), "rewrite"); // 12%
    assert.equal(vocabResult(50, 7), "rewrite"); // 14%
    assert.equal(vocabResult(20, 3), "rewrite"); // 정확히 15%
    assert.equal(vocabResult(50, 8), "retest"); // 16%
    assert.equal(vocabResult(30, 0), "pass");
    assert.deepEqual(weekDatesFor("2026-11-02", ["월", "수", "금"]), ["2026-11-02", "2026-11-04", "2026-11-06"]);
  });

  await test("해온 개수가 고른 상태를 이긴다", () => {
    assert.equal(deriveHomeworkStatus(20, 14, "done"), "partial");
    assert.equal(deriveHomeworkStatus(20, 20, "partial"), "done");
    assert.equal(deriveHomeworkStatus(20, 0, null), "none");
    assert.equal(deriveHomeworkStatus(null, null, "partial"), "partial");
  });

  /* ── 준비: 실제 반 하나 빌리기 ───────────────────────────────────────── */
  const owners = await db.select().from(users).where(eq(users.role, "owner"));
  let owner: (typeof owners)[number] | null = null;
  let cls: typeof classes.$inferSelect | null = null;
  let roster: { id: string; name: string; parentPhone: string | null }[] = [];
  for (const o of owners) {
    if (!o.tenantId) continue;
    const list = await db.select().from(classes).where(and(eq(classes.tenantId, o.tenantId), eq(classes.isActive, true)));
    for (const c of list) {
      const r = await db
        .selectDistinct({ id: students.id, name: students.name, parentPhone: students.parentPhone })
        .from(enrollments)
        .innerJoin(students, eq(students.id, enrollments.studentId))
        .where(and(eq(enrollments.classId, c.id), eq(enrollments.isActive, true), eq(students.isActive, true)));
      if (r.length >= 3) {
        owner = o;
        cls = c;
        roster = r;
        break;
      }
    }
    if (cls) break;
  }
  if (!owner || !cls) {
    console.error("학생 3명 이상인 반을 찾지 못했습니다. DATABASE_URL 을 확인하세요.");
    process.exit(1);
  }
  console.log(`\n  대상: ${owner.name} / 반 "${cls.name}"(${cls.subject}) 학생 ${roster.length}명 / 기록 주 ${TEST_WEEK}\n`);

  const leftover = await db.select().from(reportWeeks).where(and(eq(reportWeeks.classId, cls.id), eq(reportWeeks.weekStart, TEST_WEEK)));
  if (leftover.length) {
    await db.delete(reportWeeks).where(eq(reportWeeks.id, leftover[0].id));
    console.log("  (정리) 지난번에 남은 테스트 주 기록을 지웠습니다\n");
  }

  const before = await snapshot();

  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const { default: router } = await import("../server/learning-report/routes");
  const { purgeOldPhotos } = await import("../server/learning-report/photoStore");

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(router);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = generateToken({ id: owner.id, email: owner.email, name: owner.name, role: "owner", tenantId: owner.tenantId });
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const weekPath = `/api/learning-report/classes/${cls.id}/weeks/${TEST_WEEK}`;
  const bundle = async () => (await call("GET", weekPath)).json();

  const [A, B, C] = roster;
  const makeupIds: string[] = [];
  const linkIds: string[] = [];

  try {
    /* ── 문단속 ───────────────────────────────────────────────────────── */
    console.log("문단속:");

    await test("토큰 없이 401", async () => {
      const r = await fetch(`${base}${weekPath}`);
      assert.equal(r.status, 401);
    });

    await test("없는(다른 학원) 반은 404", async () => {
      const r = await call("GET", `/api/learning-report/classes/${RANDOM_UUID}/weeks/${TEST_WEEK}`);
      assert.equal(r.status, 404);
    });

    await test("월요일이 아닌 주는 400", async () => {
      const r = await call("GET", `/api/learning-report/classes/${cls.id}/weeks/2000-01-05`);
      assert.equal(r.status, 400);
    });

    await test("화면을 열기만 해서는 주 기록이 생기지 않는다", async () => {
      const b = await bundle();
      assert.equal(b.week, null);
      assert.equal(b.students.length, roster.length);
      assert.deepEqual(b.defaultAreas, DEFAULT_EXAM_AREAS[cls!.subject] ?? DEFAULT_EXAM_AREAS["영어"]);
    });

    /* ── 진도 · 공개 ──────────────────────────────────────────────────── */
    console.log("\n진도 · 공개:");

    await test("진도를 저장하면 주 기록이 생기고, 공개 전 상태다", async () => {
      const r = await call("PATCH", weekPath, { textbook: "[TEST] 교재", unit: "Unit 05", progressPct: 65 });
      assert.equal(r.status, 200);
      const b = await bundle();
      assert.equal(b.week.textbook, "[TEST] 교재");
      assert.equal(b.week.publishedAt, null);
    });

    await test("공개를 다시 눌러도 처음 공개 시각이 그대로다", async () => {
      const first = await (await call("POST", `${weekPath}/publish`)).json();
      assert.ok(first.publishedAt);
      await new Promise((r) => setTimeout(r, 30));
      const second = await (await call("POST", `${weekPath}/publish`)).json();
      assert.equal(second.publishedAt, first.publishedAt);
      const undone = await (await call("POST", `${weekPath}/unpublish`)).json();
      assert.equal(undone.publishedAt, null);
    });

    await test("진도율 101 은 400", async () => {
      const r = await call("PATCH", weekPath, { progressPct: 101 });
      assert.equal(r.status, 400);
    });

    /* ── 숙제 ─────────────────────────────────────────────────────────── */
    console.log("\n숙제:");

    let itemId = "";
    await test("숙제 등록 (20문항)", async () => {
      const r = await call("POST", `${weekPath}/homework`, { title: "[TEST] 워크북", totalCount: 20, countUnit: "문항", dueDate: "2000-01-07" });
      assert.equal(r.status, 201);
      itemId = (await r.json()).id;
    });

    await test("14개 해옴 → 일부, '완료' 만 고르면 20개로 채워진다", async () => {
      const r = await call("PUT", `/api/learning-report/homework/${itemId}/checks`, {
        checks: [
          { studentId: A.id, doneCount: 14, status: "done" },
          { studentId: B.id, status: "done" },
        ],
      });
      assert.equal(r.status, 200);
      const hw = (await bundle()).homework[0];
      assert.deepEqual(hw.checks[A.id], { status: "partial", doneCount: 14 });
      assert.deepEqual(hw.checks[B.id], { status: "done", doneCount: 20 });
    });

    await test("반 명단 밖 학생은 400", async () => {
      const r = await call("PUT", `/api/learning-report/homework/${itemId}/checks`, { checks: [{ studentId: RANDOM_UUID, status: "done" }] });
      assert.equal(r.status, 400);
    });

    await test("'전원 완료' 는 이미 검사한 학생(A 일부)을 덮지 않는다", async () => {
      const r = await (await call("POST", `/api/learning-report/homework/${itemId}/fill-done`)).json();
      assert.equal(r.filled, roster.length - 2);
      const hw = (await bundle()).homework[0];
      assert.equal(hw.checks[A.id].status, "partial");
      assert.equal(hw.checks[C.id].status, "done");
    });

    await test("총 개수를 14 로 고치면 14개 해온 A 가 완료로 바뀐다", async () => {
      await call("PATCH", `/api/learning-report/homework/${itemId}`, { totalCount: 14 });
      const hw = (await bundle()).homework[0];
      assert.equal(hw.checks[A.id].status, "done");
    });

    /* ── 단어시험 ─────────────────────────────────────────────────────── */
    console.log("\n단어시험:");

    const vocabPath = `${weekPath}/vocab`;
    await test("통과·반복쓰기·재시험 저장, 재시험은 보강 추천에 오른다", async () => {
      const r = await call("PUT", vocabPath, {
        entries: [
          { studentId: A.id, testDate: "2000-01-03", total: 50, wrong: 5 },
          { studentId: B.id, testDate: "2000-01-03", total: 50, wrong: 7 },
          { studentId: C.id, testDate: "2000-01-07", total: 40, wrong: 9 },
        ],
      });
      assert.equal(r.status, 200);
      const b = await bundle();
      assert.equal(b.vocab.scores.length, 3);
      assert.ok(b.vocab.dates.includes("2000-01-07"), "기록이 있는 날(클리닉 날 등)은 날짜 칸에 들어가야 한다");
      // 지난번 총 문항 = 그 학생의 가장 최근 날짜 기록. 실제 기록(2000년 이후)이 있으면 그 값이 나와야 맞다.
      const [latest] = await db
        .select({ total: vocabScores.total })
        .from(vocabScores)
        .where(eq(vocabScores.studentId, C.id))
        .orderBy(desc(vocabScores.testDate))
        .limit(1);
      assert.equal(b.vocab.lastTotals[C.id], latest.total, "학생별 지난번 총 문항");
      const sug = b.suggestions.find((s: any) => s.studentId === C.id);
      assert.ok(sug && sug.reasons.some((x: string) => x.startsWith("단어 재시험")), "재시험 학생이 보강 추천에 있어야 한다");
    });

    await test("재시 통과를 체크하면 추천에서 빠지고, 점수를 고쳐 통과가 되면 재시 표시는 지워진다", async () => {
      await call("PUT", vocabPath, { entries: [{ studentId: C.id, testDate: "2000-01-07", total: 40, wrong: 9, retestPassed: true }] });
      let b = await bundle();
      assert.equal(b.vocab.scores.find((v: any) => v.studentId === C.id).retestPassed, true);
      assert.ok(!(b.suggestions.find((s: any) => s.studentId === C.id)?.reasons ?? []).some((x: string) => x.startsWith("단어 재시험")));
      await call("PUT", vocabPath, { entries: [{ studentId: C.id, testDate: "2000-01-07", total: 40, wrong: 2 }] });
      b = await bundle();
      assert.equal(b.vocab.scores.find((v: any) => v.studentId === C.id).retestPassed, null);
    });

    await test("다른 주 날짜·틀린 개수 > 총 문항·반 명단 밖 학생은 400", async () => {
      assert.equal((await call("PUT", vocabPath, { entries: [{ studentId: A.id, testDate: "2000-01-10", total: 50, wrong: 1 }] })).status, 400);
      assert.equal((await call("PUT", vocabPath, { entries: [{ studentId: A.id, testDate: "2000-01-04", total: 10, wrong: 11 }] })).status, 400);
      assert.equal((await call("PUT", vocabPath, { entries: [{ studentId: RANDOM_UUID, testDate: "2000-01-04", total: 10, wrong: 1 }] })).status, 400);
    });

    await test("칸을 비우면(null) 그날 기록이 지워진다", async () => {
      await call("PUT", vocabPath, { entries: [{ studentId: B.id, testDate: "2000-01-03", total: 50, wrong: null }] });
      const b = await bundle();
      assert.ok(!b.vocab.scores.some((v: any) => v.studentId === B.id));
    });

    /* ── 시험 ─────────────────────────────────────────────────────────── */
    console.log("\n시험:");

    let examId = "";
    await test("시험 등록 — 영역을 비우면 반 과목 기본값", async () => {
      const r = await call("POST", `${weekPath}/exams`, { name: "[TEST] 주간평가", examDate: "2000-01-04", passScore: 70 });
      assert.equal(r.status, 201);
      const exam = await r.json();
      examId = exam.id;
      assert.deepEqual(exam.areas, DEFAULT_EXAM_AREAS[cls!.subject] ?? DEFAULT_EXAM_AREAS["영어"]);
    });

    await test("총점 서버 계산, 한 영역만 고쳐도 나머지는 남고, 없는 영역은 버린다", async () => {
      const areas: string[] = (await bundle()).exams[0].areas;
      const [a1, a2, a3] = areas;
      await call("PUT", `/api/learning-report/exams/${examId}/scores`, {
        scores: [
          { studentId: A.id, areaScores: { [a1]: 88, [a2]: 76, [a3]: 90 }, comment: "[TEST] 잘했어요" },
          { studentId: B.id, areaScores: { [a1]: 50, [a2]: 50, [a3]: 50 } },
        ],
      });
      await call("PUT", `/api/learning-report/exams/${examId}/scores`, { scores: [{ studentId: A.id, areaScores: { [a1]: 91, 듣기: 100 } }] });
      const exam = (await bundle()).exams[0];
      const a = exam.scores.find((s: any) => s.studentId === A.id);
      assert.deepEqual(a.areaScores, { [a1]: 91, [a2]: 76, [a3]: 90 });
      assert.equal(a.total, 86);
      assert.equal(a.comment, "[TEST] 잘했어요");
      assert.deepEqual(exam.stats.topPct, {}, "응시 2명이면 상위 % 를 숨겨야 한다");
      assert.deepEqual(exam.stats.failStudentIds, [B.id]);
    });

    await test("칸을 비우면(null) 그 영역 점수만 지워지고 총점이 다시 계산된다", async () => {
      const areas: string[] = (await bundle()).exams[0].areas;
      await call("PUT", `/api/learning-report/exams/${examId}/scores`, { scores: [{ studentId: B.id, areaScores: { [areas[0]]: null, [areas[1]]: 80 } }] });
      const b = (await bundle()).exams[0].scores.find((s: any) => s.studentId === B.id);
      assert.deepEqual(b.areaScores, { [areas[1]]: 80, [areas[2]]: 50 });
      assert.equal(b.total, 65);
    });

    await test("점수 101 은 400", async () => {
      const areas: string[] = (await bundle()).exams[0].areas;
      const r = await call("PUT", `/api/learning-report/exams/${examId}/scores`, { scores: [{ studentId: C.id, areaScores: { [areas[0]]: 101 } }] });
      assert.equal(r.status, 400);
    });

    await test("재시 일괄 등록 — 학생을 안 고르면 통과 못 한 학생(B)만", async () => {
      const r = await call("POST", `/api/learning-report/exams/${examId}/retest`, { date: "2000-01-08", startTime: "14:00" });
      assert.equal(r.status, 201);
      const m = await r.json();
      makeupIds.push(m.id);
      assert.deepEqual(m.studentIds, [B.id]);
      assert.equal(m.reason, "retest");
      const b = await bundle();
      assert.ok(b.makeups.some((x: any) => x.id === m.id), "보강 목록에 재시가 보여야 한다");
      assert.ok(b.suggestions.some((s: any) => s.studentId === B.id), "B 가 보강 추천에 있어야 한다");
    });

    /* ── 보강 ─────────────────────────────────────────────────────────── */
    console.log("\n보강:");

    await test("다른 학원(없는) 학생으로 보강은 404", async () => {
      const r = await call("POST", "/api/learning-report/makeups", { classId: cls!.id, date: "2000-01-10", content: "[TEST]", studentIds: [RANDOM_UUID] });
      assert.equal(r.status, 404);
    });

    await test("보강 등록 → 학생 상태를 완료로", async () => {
      const r = await call("POST", "/api/learning-report/makeups", {
        classId: cls!.id,
        date: "2000-01-10",
        startTime: "17:00",
        minutes: 60,
        reason: "homework",
        content: "[TEST] 워크북 문법 보충",
        studentIds: [A.id, C.id],
      });
      assert.equal(r.status, 201);
      const m = await r.json();
      makeupIds.push(m.id);
      const u = await call("PATCH", `/api/learning-report/makeups/${m.id}/students/${A.id}`, { status: "done" });
      assert.equal(u.status, 200);
      const found = (await bundle()).makeups.find((x: any) => x.id === m.id);
      assert.equal(found.students.find((s: any) => s.studentId === A.id).status, "done");
    });

    /* ── 사진 ─────────────────────────────────────────────────────────── */
    console.log("\n사진:");

    const upload = (body: Buffer, query: string) =>
      fetch(`${base}${weekPath}/photos?${query}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg" }, body });

    await test("이미지가 아닌 파일은 JPEG 라고 해도 400", async () => {
      const r = await upload(Buffer.from("<html><script>alert(1)</script></html>"), "title=x&takenDate=2000-01-04");
      assert.equal(r.status, 400);
    });

    let photoId = "";
    await test("사진 올리기 → 같은 바이트로 다시 보인다", async () => {
      const r = await upload(FAKE_JPEG, `title=${encodeURIComponent("[TEST] 개념 정리")}&takenDate=2000-01-04`);
      assert.equal(r.status, 201);
      photoId = (await r.json()).id;
      const img = await call("GET", `/api/learning-report/photos/${photoId}/image`);
      assert.equal(img.status, 200);
      assert.equal(img.headers.get("content-type"), "image/jpeg");
      assert.ok(Buffer.from(await img.arrayBuffer()).equals(FAKE_JPEG));
    });

    await test("사진 제목·보일 사람 고치기 (반 명단 밖 학생은 400)", async () => {
      const r = await call("PATCH", `/api/learning-report/photos/${photoId}`, { title: "[TEST] 오답 노트", studentId: A.id });
      assert.equal(r.status, 200);
      const row = await r.json();
      assert.equal(row.title, "[TEST] 오답 노트");
      assert.equal(row.studentId, A.id);
      const back = await call("PATCH", `/api/learning-report/photos/${photoId}`, { studentId: null });
      assert.equal((await back.json()).studentId, null);
      const bad = await call("PATCH", `/api/learning-report/photos/${photoId}`, { studentId: RANDOM_UUID });
      assert.equal(bad.status, 400);
    });

    await test("반 명단 밖 학생 전용 사진은 400", async () => {
      const r = await upload(FAKE_JPEG, `title=x&takenDate=2000-01-04&studentId=${RANDOM_UUID}`);
      assert.equal(r.status, 400);
    });

    await test("6개월 지난 사진은 원본만 지우고 행은 남긴다", async () => {
      const n = await purgeOldPhotos();
      assert.ok(n >= 1, `지운 장 수가 1 이상이어야 하는데 ${n}`);
      const img = await call("GET", `/api/learning-report/photos/${photoId}/image`);
      assert.equal(img.status, 410);
      const [row] = await db.select().from(notePhotos).where(eq(notePhotos.id, photoId));
      assert.ok(row && row.purgedAt, "사진 행은 남아 있고 purgedAt 이 찍혀야 한다");
    });

    /* ── 부모님 링크 ──────────────────────────────────────────────────── */
    console.log("\n부모님 링크:");

    const activeLinks = await db
      .select({ studentId: parentLinks.studentId })
      .from(parentLinks)
      .where(and(inArray(parentLinks.studentId, roster.map((s) => s.id)), isNull(parentLinks.revokedAt)));
    const taken = new Set(activeLinks.map((l) => l.studentId));
    const linkStudent = roster.find((s) => phoneLast4(s.parentPhone) && !taken.has(s.id));
    const noPhone = roster.find((s) => !phoneLast4(s.parentPhone));

    if (!linkStudent) {
      console.log("  (건너뜀) 링크가 없는 보호자 번호 있는 학생이 이 반에 없음");
    } else {
      await test("링크 발급 → /p/ 주소, 두 번 눌러도 같은 주소", async () => {
        const r1 = await call("POST", `/api/learning-report/students/${linkStudent.id}/link`);
        assert.equal(r1.status, 201);
        const l1 = await r1.json();
        assert.match(l1.path, /^\/p\/[A-Za-z0-9_-]{12}$/);
        const r2 = await call("POST", `/api/learning-report/students/${linkStudent.id}/link`);
        assert.equal(r2.status, 200);
        assert.equal((await r2.json()).token, l1.token);
        const rows = await db.select().from(parentLinks).where(eq(parentLinks.studentId, linkStudent.id));
        linkIds.push(...rows.map((r) => r.id));
      });

      await test("재발급하면 옛 링크는 닫히고 새 주소가 나온다", async () => {
        const old = (await db.select().from(parentLinks).where(and(eq(parentLinks.studentId, linkStudent.id), isNull(parentLinks.revokedAt))))[0];
        const r = await call("POST", `/api/learning-report/students/${linkStudent.id}/link/reissue`);
        assert.equal(r.status, 201);
        const fresh = await r.json();
        assert.notEqual(fresh.token, old.token);
        const [oldNow] = await db.select().from(parentLinks).where(eq(parentLinks.id, old.id));
        assert.ok(oldNow.revokedAt, "옛 링크에 revokedAt 이 찍혀야 한다");
        const rows = await db.select().from(parentLinks).where(eq(parentLinks.studentId, linkStudent.id));
        linkIds.push(...rows.map((x) => x.id).filter((id) => !linkIds.includes(id)));
      });

      await test("링크 목록에 번호가 가려져 나온다", async () => {
        const list = await (await call("GET", `/api/learning-report/classes/${cls!.id}/links`)).json();
        const me = list.find((x: any) => x.studentId === linkStudent.id);
        assert.match(me.phoneMasked, /^\*\*\*-\*\*\*\*-\d{4}$/);
        assert.ok(me.link?.token);
      });
    }

    if (noPhone) {
      await test("보호자 번호 없는 학생은 링크 400", async () => {
        const r = await call("POST", `/api/learning-report/students/${noPhone.id}/link`);
        assert.equal(r.status, 400);
      });
    }
  } finally {
    // 중간에 던져도 반드시 치운다. 주 기록을 지우면 숙제·검사·시험·점수·사진이 CASCADE 로 함께 사라진다.
    await db.delete(reportWeeks).where(and(eq(reportWeeks.classId, cls.id), eq(reportWeeks.weekStart, TEST_WEEK)));
    if (makeupIds.length) await db.delete(makeupSessions).where(inArray(makeupSessions.id, makeupIds));
    if (linkIds.length) await db.delete(parentLinks).where(inArray(parentLinks.id, linkIds));
    server.close();
  }

  console.log("\n뒷정리:");
  await test("테스트 기록이 하나도 남지 않았다", async () => {
    const w = await db.select().from(reportWeeks).where(eq(reportWeeks.weekStart, TEST_WEEK));
    assert.equal(w.length, 0);
    if (makeupIds.length) assert.equal((await db.select().from(makeupSessions).where(inArray(makeupSessions.id, makeupIds))).length, 0);
    if (linkIds.length) assert.equal((await db.select().from(parentLinks).where(inArray(parentLinks.id, linkIds))).length, 0);
  });

  /*
    결제·상담·할 일은 "같아야 한다" 로 단정하지 않는다. 학원이 문을 연 시간에 돌리면 그 사이
    태블릿 결제·통화 자동등록·스케줄러가 실제로 행을 더한다 (2026-11-07 첫 실행 때 15:51 태블릿
    결제 1건과 15:48 프로젝트 할 일 8개가 들어와 이 단정이 거짓 실패했다). 이 테스트의 코드는
    세 테이블에 쓰는 경로가 아예 없다. 그래서 전후 숫자만 찍어 사람이 볼 수 있게 남긴다.
    학생·수강은 수업 중에 바뀔 일이 드물어 단정으로 둔다.
  */
  const after = await snapshot();
  await test("학생·수강 수가 시작 때와 같다 (운영 데이터 무변동)", async () => {
    assert.equal(after.students, before.students);
    assert.equal(after.enrollments, before.enrollments);
  });

  console.log(`\n  운영 데이터 시작: ${JSON.stringify(before)}`);
  console.log(`  운영 데이터 끝:   ${JSON.stringify(after)}`);
  if (after.payments !== before.payments || after.tasks !== before.tasks || after.consultations !== before.consultations) {
    console.log("  ↑ 결제·할 일·상담이 달라졌다면 그 사이 학원에서 실제로 들어온 것이다 (이 테스트는 그 테이블에 쓰지 않는다)");
  }
  console.log(`\n결과: 통과 ${passed} · 실패 ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\n테스트 실행 실패:", e);
  process.exit(1);
});
