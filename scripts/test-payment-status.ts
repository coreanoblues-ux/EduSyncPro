/**
 * 월별 납부 상태 판정 회귀 테스트.
 *
 * 배경 — 2026-08-29 원장 지적:
 *   "실제로는 고건 결제 했는데 안했다고 떠. 그리고 269,000원은 8월 일부 결제 했고
 *    1,000원은 9월 일부 결제 했는데 그런 부분이 안떠.
 *    사실 이렇게 떠야 하지 8월 부분결제: 269000원 남은금액 1000원 /
 *    9월 부분결제 1000원 남은 금액 269000원"
 *
 * 예전 규칙은 "그 달 순액 > 0 이면 납부완료"였다. 그래서 27만원 중 269,000원만
 * 낸 달이 초록색 완납으로 떴다. 1,000원이 영영 사라진다.
 *
 * 실행: npx tsx scripts/test-payment-status.ts
 */

import assert from "node:assert/strict";
import {
  computeMonthStatus,
  isOutstanding,
  totalOutstanding,
} from "../shared/paymentStatus";

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

console.log("─── computeMonthStatus: 중간(부분납)이 사라지지 않는다 ───");

test("★ 고건 8월 — 270,000원 중 269,000원 → 부분납, 1,000원 남음", () => {
  const m = computeMonthStatus("2026-08", 270000, 269000);
  assert.equal(m.status, "부분납");
  assert.equal(m.remaining, 1000);
  assert.equal(m.paid, 269000);
});

test("★ 고건 9월 — 270,000원 중 1,000원 → 부분납, 269,000원 남음", () => {
  const m = computeMonthStatus("2026-09", 270000, 1000);
  assert.equal(m.status, "부분납");
  assert.equal(m.remaining, 269000);
});

test("★ 예전 규칙이면 8월이 완납으로 떴다 — 순액>0 만으로 판정하지 않는다", () => {
  const m = computeMonthStatus("2026-08", 270000, 269000);
  assert.notEqual(m.status, "완납", "1,000원이 남았는데 완납으로 판정됐다");
});

test("한 푼도 안 낸 달은 미납", () => {
  const m = computeMonthStatus("2026-08", 270000, 0);
  assert.equal(m.status, "미납");
  assert.equal(m.remaining, 270000);
});

test("정확히 다 낸 달은 완납, 남은 금액 0", () => {
  const m = computeMonthStatus("2026-08", 270000, 270000);
  assert.equal(m.status, "완납");
  assert.equal(m.remaining, 0);
});

test("초과 납부해도 남은 금액은 음수로 흐르지 않는다", () => {
  const m = computeMonthStatus("2026-08", 270000, 300000);
  assert.equal(m.status, "완납");
  assert.equal(m.remaining, 0);
});

test("★ 35만 수납 + 35만 환불 = 순액 0 → 미납 (환불이 상계된다)", () => {
  const m = computeMonthStatus("2026-08", 350000, 0);
  assert.equal(m.status, "미납");
  assert.equal(m.remaining, 350000);
});

test("★ 환불이 더 커서 순액이 음수인 달도 미납 (부분납 아님)", () => {
  const m = computeMonthStatus("2026-08", 270000, -50000);
  assert.equal(m.status, "미납");
  assert.equal(m.remaining, 270000, "음수 납부가 남은 금액을 부풀리면 안 된다");
});

test("수강료가 0인 반(미설정)은 완납으로 본다 — 전부 미납으로 뜨면 안 된다", () => {
  assert.equal(computeMonthStatus("2026-08", 0, 0).status, "완납");
  assert.equal(computeMonthStatus("2026-08", 0, 0).remaining, 0);
});

test("수강료가 음수인 이상 데이터도 완납으로 흘려보낸다", () => {
  assert.equal(computeMonthStatus("2026-08", -1000, 0).status, "완납");
});

test("1원만 남아도 부분납이다 — 반올림으로 삼키지 않는다", () => {
  const m = computeMonthStatus("2026-08", 270000, 269999);
  assert.equal(m.status, "부분납");
  assert.equal(m.remaining, 1);
});

console.log("\n─── isOutstanding: 아직 받을 돈이 있는가 ───");

test("★ 부분납도 '받을 돈 있음'이다 (예전에는 완납이라 빠졌다)", () => {
  assert.equal(isOutstanding(computeMonthStatus("2026-08", 270000, 269000)), true);
});

test("미납은 받을 돈 있음", () => {
  assert.equal(isOutstanding(computeMonthStatus("2026-08", 270000, 0)), true);
});

test("완납은 받을 돈 없음", () => {
  assert.equal(isOutstanding(computeMonthStatus("2026-08", 270000, 270000)), false);
});

test("수강료 미설정 달은 받을 돈 없음", () => {
  assert.equal(isOutstanding(computeMonthStatus("2026-08", 0, 0)), false);
});

console.log("\n─── totalOutstanding: 총액을 부풀리지 않는다 ───");

test("★ 고건 두 달 합계 = 1,000 + 269,000 = 270,000원", () => {
  const months = [
    computeMonthStatus("2026-08", 270000, 269000),
    computeMonthStatus("2026-09", 270000, 1000),
  ];
  assert.equal(totalOutstanding(months), 270000);
});

test("★ 예전 방식(미납개월수 × 수강료)이면 540,000원으로 두 배가 됐다", () => {
  const months = [
    computeMonthStatus("2026-08", 270000, 269000),
    computeMonthStatus("2026-09", 270000, 1000),
  ];
  const old = months.length * 270000;
  assert.equal(old, 540000);
  assert.notEqual(totalOutstanding(months), old, "이미 받은 270,000원까지 미납으로 세고 있다");
});

test("완납 달은 합계에 0을 보탠다", () => {
  const months = [
    computeMonthStatus("2026-07", 270000, 270000),
    computeMonthStatus("2026-08", 270000, 269000),
  ];
  assert.equal(totalOutstanding(months), 1000);
});

test("빈 배열은 0원", () => {
  assert.equal(totalOutstanding([]), 0);
});

test("전부 미납이면 예전 방식과 같은 값이 나온다 (부분납이 없을 때는 회귀 없음)", () => {
  const months = [
    computeMonthStatus("2026-07", 270000, 0),
    computeMonthStatus("2026-08", 270000, 0),
  ];
  assert.equal(totalOutstanding(months), 540000);
});

console.log(`\n${failed === 0 ? "✅" : "❌"} 통과 ${passed} · 실패 ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
