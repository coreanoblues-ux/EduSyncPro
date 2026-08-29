/**
 * 환불 규칙 회귀 테스트.
 *
 * 지키려는 사고:
 *
 *   (1) 같은 돈이 두 번 빠져나간다
 *       원장이 관리자 화면에서 환불을 기록한 뒤 토스 취소 웹훅이 도착하면,
 *       예전 웹훅 코드는 intent.amount 를 통째로 다시 음수로 꽂았다.
 *       27만원 결제가 -54만원이 된다.
 *
 *   (2) 두 번 클릭하면 두 번 환불된다
 *       환불 버튼은 네트워크가 느리면 반드시 두 번 눌린다.
 *       "이미 환불된 누적액"을 매번 다시 세는 것으로만 막을 수 있다.
 *
 *   (3) 승인되지도 않은 건을 환불한다
 *       돈이 나간 적 없는데 장부에 마이너스가 생기면 그게 곧 분식이다.
 *
 * 실행: npx tsx scripts/test-refund.ts
 */

import assert from "node:assert/strict";
import { classifyRefund, refundableAmount, webhookCancelAmount } from "../server/toss-front/refund";

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

/** 현장 기준값: 수강료 27만원. */
const TUITION = 270_000;

console.log("─── classifyRefund: 승인된 건만, 남은 만큼만 ───");

test("승인된 27만원을 전액 환불하면 fullyRefunded", () => {
  const d = classifyRefund({
    intentStatus: "APPROVED",
    approvedAmount: TUITION,
    alreadyRefunded: 0,
    requested: TUITION,
  });
  assert.deepEqual(d, { kind: "ok", amount: TUITION, remainingAfter: 0, fullyRefunded: true });
});

test("부분 환불하면 나머지가 남고 fullyRefunded 아님", () => {
  const d = classifyRefund({
    intentStatus: "APPROVED",
    approvedAmount: TUITION,
    alreadyRefunded: 0,
    requested: 70_000,
  });
  assert.deepEqual(d, {
    kind: "ok",
    amount: 70_000,
    remainingAfter: 200_000,
    fullyRefunded: false,
  });
});

test("부분 환불을 이어서 하면 남은 만큼 채워 전액이 된다", () => {
  const d = classifyRefund({
    intentStatus: "APPROVED",
    approvedAmount: TUITION,
    alreadyRefunded: 70_000,
    requested: 200_000,
  });
  assert.equal(d.kind, "ok");
  assert.equal((d as any).fullyRefunded, true);
  assert.equal((d as any).remainingAfter, 0);
});

test("★ 두 번 클릭 — 이미 전액 환불된 건은 거절한다", () => {
  const d = classifyRefund({
    intentStatus: "APPROVED",
    approvedAmount: TUITION,
    alreadyRefunded: TUITION,
    requested: TUITION,
  });
  assert.equal(d.kind, "reject");
  assert.match((d as any).reason, /이미 전액 환불/);
});

test("★ 남은 금액보다 크게 요청하면 거절하고, 얼마까지 되는지 알려 준다", () => {
  const d = classifyRefund({
    intentStatus: "APPROVED",
    approvedAmount: TUITION,
    alreadyRefunded: 70_000,
    requested: 250_000,
  });
  assert.equal(d.kind, "reject");
  assert.match((d as any).reason, /200,000원/);
});

test("남은 금액과 정확히 같은 요청은 통과한다 (경계)", () => {
  const d = classifyRefund({
    intentStatus: "APPROVED",
    approvedAmount: TUITION,
    alreadyRefunded: 269_000,
    requested: 1_000,
  });
  assert.equal(d.kind, "ok");
  assert.equal((d as any).fullyRefunded, true);
});

test("★ 승인 안 된 CREATED 건은 환불이 아니라 취소라고 안내한다", () => {
  const d = classifyRefund({
    intentStatus: "CREATED",
    approvedAmount: TUITION,
    alreadyRefunded: 0,
    requested: TUITION,
  });
  assert.equal(d.kind, "reject");
  assert.match((d as any).reason, /취소/);
});

test("PROCESSING 도 같은 이유로 거절한다", () => {
  const d = classifyRefund({
    intentStatus: "PROCESSING",
    approvedAmount: 1_000,
    alreadyRefunded: 0,
    requested: 1_000,
  });
  assert.equal(d.kind, "reject");
  assert.match((d as any).reason, /승인되지 않은/);
});

test("TIMEOUT·FAILED·CANCELED 는 상태를 사유에 밝히며 거절한다", () => {
  for (const s of ["TIMEOUT", "FAILED", "CANCELED"]) {
    const d = classifyRefund({
      intentStatus: s,
      approvedAmount: TUITION,
      alreadyRefunded: 0,
      requested: 1_000,
    });
    assert.equal(d.kind, "reject", `${s} 가 통과했다`);
    assert.ok((d as any).reason.includes(s), `사유에 상태가 없다: ${(d as any).reason}`);
  }
});

test("0원·음수 환불은 거절한다", () => {
  for (const amt of [0, -1, -TUITION]) {
    const d = classifyRefund({
      intentStatus: "APPROVED",
      approvedAmount: TUITION,
      alreadyRefunded: 0,
      requested: amt,
    });
    assert.equal(d.kind, "reject", `${amt} 가 통과했다`);
  }
});

test("소수점 금액은 거절한다 (원 단위 장부를 오염시킨다)", () => {
  const d = classifyRefund({
    intentStatus: "APPROVED",
    approvedAmount: TUITION,
    alreadyRefunded: 0,
    requested: 1000.5,
  });
  assert.equal(d.kind, "reject");
});

console.log("\n─── refundableAmount: 남은 환불 가능액 ───");

test("승인액에서 환불액을 뺀다", () => {
  assert.equal(refundableAmount(TUITION, 70_000), 200_000);
});

test("★ 과환불이 이미 기록돼 있어도 음수를 돌려주지 않는다", () => {
  // 사람 + 웹훅이 겹쳐 이미 27만원 결제에 30만원이 환불된 최악의 상황.
  // 화면에 "-30,000원 환불 가능"이 뜨면 안 된다.
  assert.equal(refundableAmount(TUITION, 300_000), 0);
});

console.log("\n─── webhookCancelAmount: 웹훅이 이중 계상하지 않는다 ───");

test("★ 원장이 이미 전액 환불했으면 웹훅은 0원 — 아무것도 적지 않는다", () => {
  assert.equal(webhookCancelAmount(TUITION, TUITION), 0);
});

test("★ 원장이 7만원만 환불했으면 웹훅은 남은 20만원만 적는다", () => {
  assert.equal(webhookCancelAmount(TUITION, 70_000), 200_000);
});

test("아무도 환불한 적 없으면 웹훅이 전액을 적는다 (기존 동작 유지)", () => {
  assert.equal(webhookCancelAmount(TUITION, 0), TUITION);
});

console.log(`\n${failed === 0 ? "✅" : "❌"} 통과 ${passed} · 실패 ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
