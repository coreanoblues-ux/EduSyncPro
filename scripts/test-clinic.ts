/**
 * 주간 클리닉 API 검증. `npm run test:clinic`
 *
 * 못 박는 것
 *   · 등급: 90 이상 1등급 … 20 미만 9등급 (영어 절대평가)
 *   · 단계를 안 정했거나 "안 들음" 인 학생은 점수를 못 넣는다
 *   · 듣기는 맞은 개수(총 문항 기본 17, 맞은 개수 > 총 문항은 400), 나머지는 100점 점수
 *   · 그날 기록에 저장 시점의 단계가 남는다
 *   · 공개 · 공개 취소, 점수를 비우면 기록이 지워진다
 *
 * ⚠️ 실제 DB 에 쓴다. 규칙:
 *   · 클리닉 날은 **2000-01-07** 만 쓰고 끝나면 지운다.
 *   · 학생 단계는 실제 데이터라 **시작 전 값을 적어 두고 finally 에서 그대로 되돌린다.**
 */

import "dotenv/config";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../server/db";
import { users, studentClinicLevels, clinicDays } from "@shared/schema";
import { englishGrade } from "@shared/learningReport";
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

const DAY = "2000-01-07";

async function main() {
  console.log("\n주간 클리닉 API 테스트\n");

  await test("영어 절대평가 등급", () => {
    assert.equal(englishGrade(100), 1);
    assert.equal(englishGrade(90), 1);
    assert.equal(englishGrade(89), 2);
    assert.equal(englishGrade(80), 2);
    assert.equal(englishGrade(79), 3);
    assert.equal(englishGrade(20), 8);
    assert.equal(englishGrade(19), 9);
    assert.equal(englishGrade(0), 9);
  });

  const [owner] = await db.select().from(users).where(eq(users.email, "coreanoblues@gmail.com"));
  if (!owner?.tenantId) {
    console.error("원장 계정을 찾지 못했습니다.");
    process.exit(1);
  }

  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const { default: clinicRouter } = await import("../server/learning-report/clinicRoutes");
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(clinicRouter);
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

  const list = await (await call("GET", "/api/learning-report/clinic/students")).json();
  if (!Array.isArray(list) || list.length < 3) {
    console.error("영어 학생이 3명 이상 필요합니다.");
    process.exit(1);
  }
  const [A, B, C] = list;
  const ids = [A.studentId, B.studentId, C.studentId];
  // 실제 단계를 적어 둔다 — 끝나면 그대로 되돌린다.
  const before = await db.select().from(studentClinicLevels).where(inArray(studentClinicLevels.studentId, ids));
  await db.delete(clinicDays).where(and(eq(clinicDays.tenantId, owner.tenantId), eq(clinicDays.date, DAY)));
  const dayPath = `/api/learning-report/clinic/days/${DAY}`;

  try {
    await test("토큰 없이 401", async () => {
      assert.equal((await fetch(`${base}${dayPath}`)).status, 401);
    });

    await test("단계 저장 (A 고1 모의 · B 듣기 · C 안 들음)", async () => {
      const r = await call("PUT", "/api/learning-report/clinic/levels", {
        items: [
          { studentId: A.studentId, level: "mock1" },
          { studentId: B.studentId, level: "listening" },
          { studentId: C.studentId, level: "none" },
        ],
      });
      assert.equal(r.status, 200);
    });

    await test("화면을 열기만 해서는 클리닉 날이 생기지 않는다", async () => {
      const b = await (await call("GET", dayPath)).json();
      assert.equal(b.day, null);
      assert.equal(b.students.find((s: any) => s.studentId === A.studentId).level, "mock1");
      assert.equal(b.listeningDefaultTotal, 17);
    });

    await test("고1 모의는 점수, 듣기는 맞은 개수(총 17 기본)", async () => {
      const r = await call("PUT", `${dayPath}/scores`, {
        entries: [
          { studentId: A.studentId, score: 84, reviewDone: true },
          { studentId: B.studentId, correct: 15 },
        ],
      });
      assert.equal(r.status, 200);
      const b = await (await call("GET", dayPath)).json();
      const a = b.scores.find((s: any) => s.studentId === A.studentId);
      const bb = b.scores.find((s: any) => s.studentId === B.studentId);
      assert.deepEqual([a.level, a.score, a.correct, a.reviewDone], ["mock1", 84, null, true]);
      assert.deepEqual([bb.level, bb.score, bb.correct, bb.total], ["listening", null, 15, 17]);
    });

    await test("안 들음 학생 점수는 400, 맞은 개수 > 총 문항은 400, 명단 밖 학생은 400", async () => {
      assert.equal((await call("PUT", `${dayPath}/scores`, { entries: [{ studentId: C.studentId, score: 70 }] })).status, 400);
      assert.equal((await call("PUT", `${dayPath}/scores`, { entries: [{ studentId: B.studentId, correct: 18, total: 17 }] })).status, 400);
      assert.equal((await call("PUT", `${dayPath}/scores`, { entries: [{ studentId: "00000000-0000-4000-8000-000000000000", score: 70 }] })).status, 400);
    });

    await test("오답 정리만 바꿔도 점수는 남는다", async () => {
      await call("PUT", `${dayPath}/scores`, { entries: [{ studentId: B.studentId, reviewDone: true }] });
      const b = await (await call("GET", dayPath)).json();
      const bb = b.scores.find((s: any) => s.studentId === B.studentId);
      assert.deepEqual([bb.correct, bb.reviewDone], [15, true]);
    });

    await test("시험지 이름 저장 · 공개를 다시 눌러도 처음 시각 유지 · 공개 취소", async () => {
      await call("PATCH", dayPath, { papers: { mock1: "[TEST] 2024년 9월 고1" } });
      const first = await (await call("POST", `${dayPath}/publish`)).json();
      await new Promise((r) => setTimeout(r, 30));
      const second = await (await call("POST", `${dayPath}/publish`)).json();
      assert.equal(second.publishedAt, first.publishedAt);
      const b = await (await call("GET", dayPath)).json();
      assert.equal(b.day.papers.mock1, "[TEST] 2024년 9월 고1");
      const off = await (await call("POST", `${dayPath}/unpublish`)).json();
      assert.equal(off.publishedAt, null);
    });

    await test("점수를 비우면 그 학생 기록이 지워진다", async () => {
      await call("PUT", `${dayPath}/scores`, { entries: [{ studentId: A.studentId, score: null }] });
      const b = await (await call("GET", dayPath)).json();
      assert.ok(!b.scores.some((s: any) => s.studentId === A.studentId));
    });
  } finally {
    await db.delete(clinicDays).where(and(eq(clinicDays.tenantId, owner.tenantId), eq(clinicDays.date, DAY)));
    // 학생 단계를 시작 전 그대로 되돌린다.
    await db.delete(studentClinicLevels).where(inArray(studentClinicLevels.studentId, ids));
    if (before.length) await db.insert(studentClinicLevels).values(before);
    server.close();
  }

  console.log("\n뒷정리:");
  await test("클리닉 날이 남지 않았고, 학생 단계가 시작 전과 같다", async () => {
    assert.equal((await db.select().from(clinicDays).where(and(eq(clinicDays.tenantId, owner.tenantId), eq(clinicDays.date, DAY)))).length, 0);
    const after = await db.select().from(studentClinicLevels).where(inArray(studentClinicLevels.studentId, ids));
    const norm = (rows: typeof before) => rows.map((r) => `${r.studentId}:${r.level}`).sort();
    assert.deepEqual(norm(after), norm(before));
  });

  console.log(`\n결과: 통과 ${passed} · 실패 ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\n테스트 실행 실패:", e);
  process.exit(1);
});
