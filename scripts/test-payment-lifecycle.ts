/**
 * 결제 수명주기 회귀 테스트.
 *
 * 지키려는 두 가지 사고:
 *
 *   (1) 유령 결제가 학생을 영원히 막는다 — 2026-08-29 현장
 *       어제 실패한 시도의 intent 가 CREATED 로 남아, 오늘 온 학생이 같은 달을
 *       결제하려 하면 "진행중인 결제가 있습니다" 만 반복해서 떴다. 실패는 기록으로만
 *       남고 다음 결제를 방해하면 안 된다.
 *
 *   (2) 승인된 돈이 장부에서 사라진다 — (1) 을 고치다 새로 생길 뻔한 사고
 *       카드 승인은 단말기에서 먼저 끝나고 confirm 은 나중에 온다. 만료·TIMEOUT 을
 *       이유로 confirm 을 거절하면 돈은 빠져나갔는데 payments 행은 없다.
 *
 * 실행: npx tsx scripts/test-payment-lifecycle.ts
 */

import assert from "node:assert/strict";
import { isBlocking, secondsUntilFree, classifyConfirm } from "../server/toss-front/lifecycle";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e?.message ?? e}`);
    failed++;
  }
}

const NOW = new Date("2026-08-29T13:00:00+09:00");
const inFuture = (sec: number) => new Date(NOW.getTime() + sec * 1000);
const inPast = (sec: number) => new Date(NOW.getTime() - sec * 1000);

console.log("─── isBlocking: 살아 있는 결제만 막는다 ───");

test("진행 중인 PENDING dispatch 는 막는다", () => {
  assert.equal(isBlocking("PENDING", inFuture(120), NOW), true);
});

test("진행 중인 DELIVERED dispatch 는 막는다 (카드 꽂는 중)", () => {
  assert.equal(isBlocking("DELIVERED", inFuture(60), NOW), true);
});

test("진행 중인 CREATED intent 는 막는다", () => {
  assert.equal(isBlocking("CREATED", inFuture(180), NOW), true);
});

test("진행 중인 PROCESSING intent 는 막는다", () => {
  assert.equal(isBlocking("PROCESSING", inFuture(1), NOW), true);
});

test("★ 만료된 CREATED intent 는 막지 않는다 (어제 실패 건이 오늘을 막던 그 버그)", () => {
  // 화면에 찍힌 실제 데이터: 2026-08-28 19:24 생성, TTL 3분 → 진작 만료.
  const yesterday = new Date("2026-08-28T19:24:56+09:00");
  const expiredAt = new Date(yesterday.getTime() + 3 * 60 * 1000);
  assert.equal(isBlocking("CREATED", expiredAt, NOW), false);
});

test("★ 만료된 PROCESSING intent 도 막지 않는다 (단말기가 응답 없이 꺼진 경우)", () => {
  assert.equal(isBlocking("PROCESSING", inPast(1), NOW), false);
});

test("만료된 PENDING dispatch 는 막지 않는다 (정리 배치가 죽어 있어도 스스로 풀림)", () => {
  assert.equal(isBlocking("PENDING", inPast(3600), NOW), false);
});

test("마감된 상태는 만료 전이어도 막지 않는다", () => {
  for (const s of ["APPROVED", "CANCELED", "TIMEOUT", "FAILED"]) {
    assert.equal(isBlocking(s, inFuture(120), NOW), false, `${s} 가 막고 있다`);
  }
});

test("만료 시각이 정확히 지금이면 막지 않는다 (경계)", () => {
  assert.equal(isBlocking("PENDING", NOW, NOW), false);
});

test("문자열로 들어온 만료 시각도 동일하게 판단한다", () => {
  assert.equal(isBlocking("PENDING", inFuture(60).toISOString(), NOW), true);
  assert.equal(isBlocking("PENDING", inPast(60).toISOString(), NOW), false);
});

console.log("\n─── secondsUntilFree: 얼마나 기다리면 되는지 ───");

test("남은 시간을 초로 올림해 돌려준다", () => {
  assert.equal(secondsUntilFree(inFuture(90), NOW), 90);
});

test("이미 지났어도 최소 1초 (0초·음수를 화면에 띄우지 않는다)", () => {
  assert.equal(secondsUntilFree(inPast(500), NOW), 1);
});

console.log("\n─── classifyConfirm: 승인된 돈은 절대 버리지 않는다 ───");

test("정상 흐름 CREATED → 그대로 승인", () => {
  const d = classifyConfirm({ intentStatus: "CREATED", expiresAt: inFuture(60), now: NOW });
  assert.deepEqual(d, { kind: "accept", lateRecovery: false });
});

test("정상 흐름 PROCESSING → 그대로 승인", () => {
  const d = classifyConfirm({ intentStatus: "PROCESSING", expiresAt: inFuture(60), now: NOW });
  assert.deepEqual(d, { kind: "accept", lateRecovery: false });
});

test("이미 APPROVED 면 재전송으로 보고 idempotent", () => {
  const d = classifyConfirm({ intentStatus: "APPROVED", expiresAt: inPast(10), now: NOW });
  assert.equal(d.kind, "idempotent");
});

test("★ 만료 후 도착한 승인도 받아 준다 (카드는 이미 긁혔다)", () => {
  const d = classifyConfirm({ intentStatus: "PROCESSING", expiresAt: inPast(30), now: NOW });
  assert.equal(d.kind, "accept");
  assert.equal((d as any).lateRecovery, true);
  assert.match((d as any).why, /만료/);
});

test("★ 정리 배치가 TIMEOUT 으로 바꿔 둔 뒤 도착한 승인도 받아 준다", () => {
  const d = classifyConfirm({ intentStatus: "TIMEOUT", expiresAt: inPast(600), now: NOW });
  assert.equal(d.kind, "accept");
  assert.equal((d as any).lateRecovery, true);
});

test("★ 태블릿에서 취소했지만 단말기는 이미 승인한 경합 — 기록이 이긴다", () => {
  const d = classifyConfirm({ intentStatus: "CANCELED", expiresAt: inFuture(60), now: NOW });
  assert.equal(d.kind, "accept");
  assert.equal((d as any).lateRecovery, true);
});

test("★ FAILED 로 적어 둔 건에 승인이 도착해도 받아 준다", () => {
  const d = classifyConfirm({ intentStatus: "FAILED", expiresAt: inFuture(60), now: NOW });
  assert.equal(d.kind, "accept");
  assert.equal((d as any).lateRecovery, true);
});

test("지각 승인의 사유는 사람이 읽을 수 있어야 한다 (비고에 남는다)", () => {
  const d = classifyConfirm({ intentStatus: "TIMEOUT", expiresAt: inPast(10), now: NOW });
  const why = (d as any).why as string;
  assert.ok(why.includes("TIMEOUT"), `상태가 사유에 없다: ${why}`);
  assert.ok(why.includes("만료"), `만료 사실이 사유에 없다: ${why}`);
});

test("알 수 없는 상태는 거절한다 (스키마가 늘어나도 조용히 통과시키지 않는다)", () => {
  const d = classifyConfirm({ intentStatus: "REFUNDED", expiresAt: inFuture(60), now: NOW });
  assert.equal(d.kind, "reject");
});

console.log(`\n${failed === 0 ? "✅" : "❌"} 통과 ${passed} · 실패 ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
