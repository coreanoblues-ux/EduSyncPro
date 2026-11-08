/**
 * 학부모 학습 리포트 — 부모님 공개 화면(/p/:token) 문단속 검증. `npm run test:parent-report`
 *
 * ════════════════════════════════════════════════════════════════════════
 * 무엇을 못 박는가 (이 화면은 로그인 없이 열린다)
 * ════════════════════════════════════════════════════════════════════════
 *   · 번호 뒤 4자리를 맞히기 전에는 **아무 기록도, 학생 이름도** 나가지 않는다
 *   · 틀리면 남은 횟수 안내, 5번째에 잠기고, 잠긴 동안은 맞는 번호도 안 받는다
 *   · 맞히면 이 링크 주소에만 쓰이는 쿠키가 생기고, 쿠키로 화면이 열린다
 *   · 화면에 **보호자 번호 · 다른 학생 이름** 이 없다
 *   · 공개 안 한 주는 안 보인다. 반 전체 사진은 보이고, **다른 학생 전용 사진은 404**
 *   · 재발급하면 옛 링크는 "닫힌 링크"
 *   · 선생님 미리보기는 로그인해야 열리고, 공개 전 주도 보인다
 *
 * ════════════════════════════════════════════════════════════════════════
 * ⚠️ 이 테스트는 실제 DB 에 쓴다 (test:learning-report 와 같은 규칙)
 * ════════════════════════════════════════════════════════════════════════
 *   · 기록은 실제 반 하나의 **2000-01-03 주** 에만 쓰고, 화면은 ?w=2000-01-03 으로 연다.
 *   · 링크는 **살아 있는 링크가 없는 학생**에게만 만들고 끝나면 지운다 — 원장이 보낸 링크를 건드리지 않는다.
 *   · 보호자 번호는 비교에만 쓰고 **출력하지 않는다.**
 */

import "dotenv/config";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../server/db";
import { users, classes, enrollments, students, reportWeeks, parentLinks, studentClinicLevels, clinicDays } from "@shared/schema";
import { phoneLast4 } from "@shared/learningReport";
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

const TEST_WEEK = "2000-01-03";
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0parent-report-test")]);

async function main() {
  console.log("\n학부모 학습 리포트 — 부모님 공개 화면 테스트\n");

  // ── 준비: 링크 없는(보호자 번호 있는) 학생이 있는, 학생 3명 이상인 반 ──
  const owners = await db.select().from(users).where(eq(users.role, "owner"));
  let owner: (typeof owners)[number] | null = null;
  let cls: typeof classes.$inferSelect | null = null;
  let roster: { id: string; name: string; parentPhone: string | null }[] = [];
  let me: (typeof roster)[number] | null = null;
  for (const o of owners) {
    if (!o.tenantId) continue;
    for (const c of await db.select().from(classes).where(and(eq(classes.tenantId, o.tenantId), eq(classes.isActive, true)))) {
      const r = await db
        .selectDistinct({ id: students.id, name: students.name, parentPhone: students.parentPhone })
        .from(enrollments)
        .innerJoin(students, eq(students.id, enrollments.studentId))
        .where(and(eq(enrollments.classId, c.id), eq(enrollments.isActive, true), eq(students.isActive, true)));
      if (r.length < 3) continue;
      const linked = new Set(
        (await db.select({ s: parentLinks.studentId }).from(parentLinks).where(and(inArray(parentLinks.studentId, r.map((x) => x.id)), isNull(parentLinks.revokedAt)))).map((x) => x.s)
      );
      const pick = r.find((s) => phoneLast4(s.parentPhone) && !linked.has(s.id));
      if (pick) {
        owner = o;
        cls = c;
        roster = r;
        me = pick;
        break;
      }
    }
    if (cls) break;
  }
  if (!owner || !cls || !me) {
    console.error("링크 없는 학생이 있는 반을 찾지 못했습니다 — 테스트를 건너뜁니다.");
    process.exit(1);
  }
  const other = roster.find((s) => s.id !== me!.id)!;
  const last4 = phoneLast4(me.parentPhone)!;
  const wrong = last4 === "0000" ? "1111" : "0000";
  console.log(`  대상: 반 "${cls.name}" / 학생 1명(링크 없음) / 기록 주 ${TEST_WEEK}\n`);

  await db.delete(reportWeeks).where(and(eq(reportWeeks.classId, cls.id), eq(reportWeeks.weekStart, TEST_WEEK)));

  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const { default: teacherRouter } = await import("../server/learning-report/routes");
  const { default: parentRouter } = await import("../server/parent-report/routes");
  const { default: clinicRouter } = await import("../server/learning-report/clinicRoutes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(teacherRouter);
  app.use(clinicRouter);
  app.use(parentRouter);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = generateToken({ id: owner.id, email: owner.email, name: owner.name, role: "owner", tenantId: owner.tenantId });
  const teacher = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const weekPath = `/api/learning-report/classes/${cls.id}/weeks/${TEST_WEEK}`;
  const linkIds: string[] = [];
  // 클리닉: 이 학생의 실제 단계를 적어 두고 끝나면 되돌린다. 클리닉 날은 2000-01-07 만 쓴다.
  const CLINIC_DAY = "2000-01-07";
  const levelBefore = await db.select().from(studentClinicLevels).where(eq(studentClinicLevels.studentId, me.id));
  await db.delete(clinicDays).where(and(eq(clinicDays.tenantId, owner.tenantId!), eq(clinicDays.date, CLINIC_DAY)));

  try {
    // ── 선생님 쪽 준비: 진도·숙제·시험·사진 2장(반 전체, 다른 학생 전용) ──
    await teacher("PATCH", weekPath, { textbook: "[TEST] 교재", unit: "[TEST] Unit 99", progressPct: 40 });
    const item = await (await teacher("POST", `${weekPath}/homework`, { title: "[TEST] 워크북", totalCount: 20, countUnit: "문항" })).json();
    await teacher("PUT", `/api/learning-report/homework/${item.id}/checks`, { checks: [{ studentId: me.id, doneCount: 14 }] });
    const exam = await (await teacher("POST", `${weekPath}/exams`, { name: "[TEST] 주간평가", examDate: "2000-01-04", passScore: 70 })).json();
    const [a1, a2, a3] = exam.areas;
    await teacher("PUT", `/api/learning-report/exams/${exam.id}/scores`, {
      scores: [
        { studentId: me.id, areaScores: { [a1]: 88, [a2]: 76, [a3]: 90 }, comment: "[TEST] 잘했어요" },
        { studentId: other.id, areaScores: { [a1]: 50, [a2]: 50, [a3]: 50 }, comment: "[TEST] 남의 한마디" },
      ],
    });
    const up = (q: string) =>
      fetch(`${base}${weekPath}/photos?${q}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "image/jpeg" }, body: FAKE_JPEG }).then((r) => r.json());
    const shared = await up(`title=${encodeURIComponent("[TEST] 반 전체 노트")}&takenDate=2000-01-04`);
    const privateOther = await up(`title=${encodeURIComponent("[TEST] 남의 노트")}&takenDate=2000-01-04&studentId=${other.id}`);
    await teacher("PUT", `${weekPath}/vocab`, {
      entries: [
        { studentId: me.id, testDate: "2000-01-03", total: 50, wrong: 3 },
        { studentId: me.id, testDate: "2000-01-05", total: 50, wrong: 7 },
        { studentId: me.id, testDate: "2000-01-07", total: 40, wrong: 9, retestPassed: true },
        { studentId: other.id, testDate: "2000-01-03", total: 50, wrong: 20 },
      ],
    });
    await teacher("POST", `${weekPath}/publish`);
    // 클리닉: 영어 학생이면 고1 모의고사 84점(2등급), 오답 정리 전, 공개.
    const clinicOk = (await teacher("PUT", "/api/learning-report/clinic/levels", { items: [{ studentId: me.id, level: "mock1" }] })).status === 200;
    if (clinicOk) {
      await teacher("PUT", `/api/learning-report/clinic/days/${CLINIC_DAY}/scores`, { entries: [{ studentId: me.id, score: 84 }] });
      await teacher("PATCH", `/api/learning-report/clinic/days/${CLINIC_DAY}`, { papers: { mock1: "[TEST] 2024년 9월 고1" } });
      await teacher("POST", `/api/learning-report/clinic/days/${CLINIC_DAY}/publish`);
    }

    const link = await (await teacher("POST", `/api/learning-report/students/${me.id}/link`)).json();
    linkIds.push(...(await db.select({ id: parentLinks.id }).from(parentLinks).where(eq(parentLinks.studentId, me.id))).map((r) => r.id));
    const P = `/p/${link.token}`;
    const W = `?w=${TEST_WEEK}&c=${cls.id}`;
    let cookie = "";
    const parent = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, { redirect: "manual", ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
    const verify = (digits: string) =>
      parent(`${P}/verify`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `last4=${digits}` });

    console.log("문 앞:");
    await test("모양이 틀린 주소는 404", async () => {
      assert.equal((await parent("/p/short")).status, 404);
    });

    await test("확인 전에는 번호 입력 화면만 — 기록·학생 이름이 없다", async () => {
      const r = await parent(`${P}${W}`);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.ok(html.includes('name="last4"'), "번호 입력 칸이 있어야 한다");
      assert.ok(!html.includes("[TEST]"), "확인 전에 기록이 보이면 안 된다");
      assert.ok(!html.includes(me!.name), "확인 전에 학생 이름이 보이면 안 된다");
      assert.equal(r.headers.get("cache-control"), "private, no-store, max-age=0");
      assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    });

    await test("확인 전 상세 화면도 번호 입력 화면", async () => {
      const html = await (await parent(`${P}/exam${W}`)).text();
      assert.ok(html.includes('name="last4"') && !html.includes("[TEST]"));
    });

    await test("확인 전 사진은 404", async () => {
      assert.equal((await parent(`${P}/photo/${shared.id}`)).status, 404);
    });

    await test("틀리면 401 + 남은 횟수 안내", async () => {
      const r = await verify(wrong);
      assert.equal(r.status, 401);
      assert.ok((await r.text()).includes("4번 더 틀리면"));
    });

    await test("맞히면 이 링크 주소 전용 쿠키 + 홈으로 이동", async () => {
      const r = await verify(last4);
      assert.equal(r.status, 303);
      assert.equal(r.headers.get("location"), P);
      const set = r.headers.get("set-cookie") ?? "";
      assert.match(set, /^pr=/);
      assert.match(set, new RegExp(`Path=${P.replace(/[/]/g, "\\/")}`));
      assert.match(set, /HttpOnly/i);
      cookie = set.split(";")[0];
      const [row] = await db.select().from(parentLinks).where(eq(parentLinks.token, link.token));
      assert.equal(row.failedAttempts, 0, "맞히면 틀린 횟수가 0 으로 돌아가야 한다");
    });

    console.log("\n화면:");
    await test("홈: 이름·진도·숙제·시험이 보이고, 보호자 번호와 다른 학생 이름은 없다", async () => {
      const r = await parent(`${P}${W}`);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.ok(html.includes(me!.name));
      assert.ok(html.includes("[TEST] Unit 99"));
      assert.ok(html.includes("6문항 모자랍니다"), "숙제 부족 안내");
      // 반 시험 총점은 시험 화면에서 본다 — 클리닉을 듣는 학생은 홈 4번째 칸이 "주간 클리닉" 으로 바뀌기 때문이다.
      const examHtml = await (await parent(`${P}/exam${W}`)).text();
      assert.ok(examHtml.includes(">85<"), "반 시험 총점 85");
      const digits = (me!.parentPhone ?? "").replace(/\D/g, "");
      assert.ok(!html.includes(digits), "보호자 번호 전체가 보이면 안 된다");
      assert.ok(!html.includes(other.name), "다른 학생 이름이 보이면 안 된다");
      const [row] = await db.select().from(parentLinks).where(eq(parentLinks.token, link.token));
      await new Promise((res) => setTimeout(res, 200));
      const [after] = await db.select().from(parentLinks).where(eq(parentLinks.token, link.token));
      assert.ok(after.viewCount >= 1 && after.lastViewedAt, "열람 기록이 남아야 한다");
      void row;
    });

    await test("단어시험: 홈 타일 '2/3회 통과'(재시 통과 포함), 숙제 화면에 날짜별 결과 (남의 기록은 없다)", async () => {
      const home = await (await parent(`${P}${W}`)).text();
      assert.ok(home.includes("단어시험") && home.includes("2<small>/3회 통과"), "홈 단어시험 타일 — 재시 통과도 통과로 센다");
      assert.ok(home.includes("반복쓰기 1회"));
      const hw = await (await parent(`${P}/homework${W}`)).text();
      assert.ok(hw.includes("50개 중 <b>47개</b> 맞힘"), "1/3 통과 기록");
      assert.ok(hw.includes("50개 중 <b>43개</b> 맞힘"), "1/5 반복쓰기 기록");
      assert.ok(hw.includes("재시 통과"), "1/7 재시험은 '재시 통과' 로 따로 보인다");
      assert.ok(!hw.includes("<b>30개</b>"), "다른 학생(20개 틀림) 기록이 보이면 안 된다");
    });

    if (clinicOk) {
      await test("클리닉: 홈 4번째 타일이 '주간 클리닉 84점 · 2등급', 시험 화면에 시험지 이름", async () => {
        const home = await (await parent(`${P}${W}`)).text();
        assert.ok(home.includes("주간 클리닉") && home.includes("84<small>점") && home.includes("2등급"), "홈 클리닉 타일");
        assert.ok(home.includes("오답 정리 전"));
        const exam = await (await parent(`${P}/exam${W}`)).text();
        assert.ok(exam.includes("고1 모의고사") && exam.includes("[TEST] 2024년 9월 고1"));
      });

      await test("클리닉 공개를 취소하면 클리닉 결과가 사라진다", async () => {
        await teacher("POST", `/api/learning-report/clinic/days/${CLINIC_DAY}/unpublish`);
        const exam = await (await parent(`${P}/exam${W}`)).text();
        assert.ok(!exam.includes("[TEST] 2024년 9월 고1"));
        await teacher("POST", `/api/learning-report/clinic/days/${CLINIC_DAY}/publish`);
      });
    } else {
      console.log("  (건너뜀) 이 학생은 영어 반이 아니라 클리닉 대상이 아님");
    }

    await test("시험: 내 한마디는 있고 남의 한마디는 없다", async () => {
      const html = await (await parent(`${P}/exam${W}`)).text();
      assert.ok(html.includes("[TEST] 잘했어요"));
      assert.ok(!html.includes("[TEST] 남의 한마디"));
    });

    await test("노트: 반 전체 사진만, 다른 학생 전용 사진은 목록에도 주소에도 없다", async () => {
      const html = await (await parent(`${P}/notes${W}`)).text();
      assert.ok(html.includes(shared.id));
      assert.ok(!html.includes(privateOther.id));
      const ok = await parent(`${P}/photo/${shared.id}`);
      assert.equal(ok.status, 200);
      assert.ok(Buffer.from(await ok.arrayBuffer()).equals(FAKE_JPEG));
      assert.equal((await parent(`${P}/photo/${privateOther.id}`)).status, 404);
    });

    await test("공개를 취소하면 그 주 기록이 안 보인다", async () => {
      await teacher("POST", `${weekPath}/unpublish`);
      const html = await (await parent(`${P}${W}`)).text();
      assert.ok(!html.includes("[TEST] Unit 99"));
      assert.equal((await parent(`${P}/photo/${shared.id}`)).status, 404, "공개 취소된 주의 사진도 막혀야 한다");
    });

    await test("선생님 미리보기: 로그인 없이는 401, 로그인하면 공개 전 주도 보인다", async () => {
      assert.equal((await fetch(`${base}/api/learning-report/students/${me!.id}/preview${W}`)).status, 401);
      const r = await teacher("GET", `/api/learning-report/students/${me!.id}/preview${W}`);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.ok(html.includes("선생님 미리보기") && html.includes("[TEST] Unit 99"));
    });

    console.log("\n잠금 · 재발급:");
    await test("5번 틀리면 잠기고, 잠긴 동안은 맞는 번호도 안 받는다", async () => {
      cookie = "";
      for (let i = 1; i <= 4; i++) assert.equal((await verify(wrong)).status, 401, `${i}번째`);
      const fifth = await verify(wrong);
      assert.equal(fifth.status, 429);
      assert.ok((await fifth.text()).includes("잠시 잠겼습니다"));
      assert.equal((await verify(last4)).status, 429, "잠긴 동안 맞는 번호도 막혀야 한다");
    });

    await test("재발급하면 옛 링크는 닫힌 링크", async () => {
      await db.update(parentLinks).set({ lockedUntil: null, failedAttempts: 0 }).where(eq(parentLinks.token, link.token));
      const fresh = await (await teacher("POST", `/api/learning-report/students/${me!.id}/link/reissue`)).json();
      linkIds.push(...(await db.select({ id: parentLinks.id }).from(parentLinks).where(eq(parentLinks.studentId, me!.id))).map((r) => r.id).filter((id) => !linkIds.includes(id)));
      const r = await parent(P);
      assert.equal(r.status, 410);
      assert.ok((await r.text()).includes("닫힌 링크"));
      assert.equal((await parent(`/p/${fresh.token}`)).status, 200);
    });
  } finally {
    await db.delete(clinicDays).where(and(eq(clinicDays.tenantId, owner.tenantId!), eq(clinicDays.date, CLINIC_DAY)));
    await db.delete(studentClinicLevels).where(eq(studentClinicLevels.studentId, me.id));
    if (levelBefore.length) await db.insert(studentClinicLevels).values(levelBefore);
    await db.delete(reportWeeks).where(and(eq(reportWeeks.classId, cls.id), eq(reportWeeks.weekStart, TEST_WEEK)));
    if (linkIds.length) await db.delete(parentLinks).where(inArray(parentLinks.id, linkIds));
    server.close();
  }

  console.log("\n뒷정리:");
  await test("테스트 기록·링크가 남지 않았다", async () => {
    assert.equal((await db.select().from(reportWeeks).where(eq(reportWeeks.weekStart, TEST_WEEK))).length, 0);
    if (linkIds.length) {
      const left = await db.select({ n: sql<number>`count(*)::int` }).from(parentLinks).where(inArray(parentLinks.id, linkIds));
      assert.equal(left[0].n, 0);
    }
  });

  console.log(`\n결과: 통과 ${passed} · 실패 ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\n테스트 실행 실패:", e);
  process.exit(1);
});
