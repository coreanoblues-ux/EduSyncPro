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
  PARTIAL_PAYMENT_SINCE,
  isOutstanding,
  totalOutstanding,
  withPrepaidMonths,
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

console.log("\n─── 경계(PARTIAL_PAYMENT_SINCE): 과거를 현재 가격으로 심판하지 않는다 ───");

// 2026-08-29 사고. 부분납 판정을 넣자마자 결제 시도조차 없던 학생들의 과거가
// 전부 부분납으로 뒤집혔다. 김예진 학생은 등록상 300,000원인데 실제로는 매달
// 280,000원을 낸다(인상 전 가격 또는 할인). 그 달의 진짜 청구액은 어디에도
// 저장돼 있지 않으므로, 경계 이전은 판정하지 않고 예전 규칙을 쓴다.

test("★ 김예진 2025-09 — 300,000 등록 / 280,000 납부, 경계 이전이므로 완납", () => {
  const m = computeMonthStatus("2025-09", 300000, 280000, PARTIAL_PAYMENT_SINCE);
  assert.equal(m.status, "완납");
  assert.equal(m.remaining, 0, "경계 이전 달에 '20,000원 남음'이 뜨면 안 된다");
});

test("★ 김예진 6개월치 미수금 합계는 0원이다 (사고 전에는 120,000원이 떴다)", () => {
  const months = ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"].map(
    m => computeMonthStatus(m, 300000, 280000, PARTIAL_PAYMENT_SINCE)
  );
  assert.equal(totalOutstanding(months), 0);
  assert.equal(months.filter(m => m.status === "부분납").length, 0);
});

test("★ 경계 이전이라도 한 푼도 안 낸 달은 여전히 미납이다 (체납이 숨으면 안 된다)", () => {
  const m = computeMonthStatus("2025-09", 300000, 0, PARTIAL_PAYMENT_SINCE);
  assert.equal(m.status, "미납");
  assert.equal(m.remaining, 300000, "경계 이전 미납액은 그대로 청구돼야 한다");
});

test("★ 경계 이전 환불로 순액이 음수인 달도 미납으로 남는다", () => {
  const m = computeMonthStatus("2025-09", 300000, -50000, PARTIAL_PAYMENT_SINCE);
  assert.equal(m.status, "미납");
  assert.equal(m.remaining, 300000);
});

test("★ 경계 당월(2026-08)은 부분납이 살아 있다 — 고건 1,000원이 사라지면 안 된다", () => {
  const m = computeMonthStatus("2026-08", 270000, 269000, PARTIAL_PAYMENT_SINCE);
  assert.equal(m.status, "부분납");
  assert.equal(m.remaining, 1000);
});

test("★ 경계 이후(2026-09)도 부분납 유지 — 고건 269,000원", () => {
  const m = computeMonthStatus("2026-09", 270000, 1000, PARTIAL_PAYMENT_SINCE);
  assert.equal(m.status, "부분납");
  assert.equal(m.remaining, 269000);
});

test("★ 고건 두 달 합계는 경계를 넣어도 270,000원 그대로", () => {
  const months = [
    computeMonthStatus("2026-08", 270000, 269000, PARTIAL_PAYMENT_SINCE),
    computeMonthStatus("2026-09", 270000, 1000, PARTIAL_PAYMENT_SINCE),
  ];
  assert.equal(totalOutstanding(months), 270000);
});

test("경계를 안 넘기면(서버 invoicesHelper) 예전처럼 모든 달에 부분납을 적용한다", () => {
  const m = computeMonthStatus("2025-09", 300000, 280000);
  assert.equal(m.status, "부분납");
  assert.equal(m.remaining, 20000);
});

test("경계는 고정 날짜다 — 달이 바뀌어도 움직이지 않는다", () => {
  assert.equal(PARTIAL_PAYMENT_SINCE, "2026-08");
});

test("YYYY-MM 문자열 비교가 연도를 넘어서도 순서를 지킨다", () => {
  // 2025-12 < 2026-08 이어야 한다. zero-pad 라 사전순 = 시간순.
  assert.equal(computeMonthStatus("2025-12", 300000, 1, PARTIAL_PAYMENT_SINCE).status, "완납");
  assert.equal(computeMonthStatus("2026-08", 300000, 1, PARTIAL_PAYMENT_SINCE).status, "부분납");
});

test("경계 이전 초과 납부도 남은 금액 0", () => {
  const m = computeMonthStatus("2025-09", 300000, 350000, PARTIAL_PAYMENT_SINCE);
  assert.equal(m.status, "완납");
  assert.equal(m.remaining, 0);
});

/* ────────────────────────────────────────────────────────────────────────
 * withPrepaidMonths — 미리 낸 미래 달이 수납 화면에서 사라지지 않게 한다.
 *
 * 2026-08-30 원장 실험: 8월에 어떤 학생의 9월 수강료로 1,000원을 결제했더니
 * 태블릿에는 보이는데 수납 화면에는 아무 데도 안 나왔다. 달 목록을
 * "등록일 ~ 오늘" 로만 만들었기 때문이다.
 *
 * 반대 방향의 위험이 더 크다는 점이 이 규칙의 핵심이다 — 미래 달을 그냥
 * 펼치면 전교생이 앞으로 6달치 미납으로 뜬다. 그래서 "돈이 실제로 들어온
 * 미래 달만" 넣는다. 아래 테스트가 그 두 방향을 다 고정한다.
 * ──────────────────────────────────────────────────────────────────────── */

console.log("\n─── withPrepaidMonths: 선납한 미래 달만 끼워 넣는다 ───");

const base = ["2026-06", "2026-07", "2026-08"];

test("★ 9월에 1,000원을 미리 냈으면 9월이 목록에 들어온다 (원장이 겪은 그 건)", () => {
  const net = new Map([["2026-08", 300000], ["2026-09", 1000]]);
  assert.deepEqual(withPrepaidMonths(base, net), [...base, "2026-09"]);
});

test("★ 돈이 안 들어온 미래 달은 만들지 않는다 — 전교생이 미납으로 뜨면 안 된다", () => {
  const net = new Map([["2026-08", 300000]]);
  assert.deepEqual(withPrepaidMonths(base, net), base);
});

test("★ 냈다가 전액 환불된 미래 달은 만들지 않는다 (순액 0)", () => {
  const net = new Map([["2026-09", 0]]);
  assert.deepEqual(withPrepaidMonths(base, net), base);
});

test("환불이 더 커서 순액이 음수인 미래 달도 만들지 않는다", () => {
  const net = new Map([["2026-09", -5000]]);
  assert.deepEqual(withPrepaidMonths(base, net), base);
});

test("과거·현재 달은 이미 목록에 있으므로 중복해서 넣지 않는다", () => {
  const net = new Map([["2026-06", 300000], ["2026-07", 300000], ["2026-08", 300000]]);
  assert.deepEqual(withPrepaidMonths(base, net), base);
});

test("여러 달을 미리 냈으면 시간 순으로 붙는다", () => {
  const net = new Map([["2026-11", 1000], ["2026-09", 1000], ["2026-10", 1000]]);
  assert.deepEqual(withPrepaidMonths(base, net), [
    ...base, "2026-09", "2026-10", "2026-11",
  ]);
});

test("해를 넘겨도 순서가 맞는다 (2026-12 → 2027-01)", () => {
  const b = ["2026-12"];
  const net = new Map([["2027-01", 1000], ["2026-12", 300000]]);
  assert.deepEqual(withPrepaidMonths(b, net), ["2026-12", "2027-01"]);
});

test("기본 목록이 비어 있으면(등록일이 미래인 신규생) 낸 달이 그대로 목록이 된다", () => {
  const net = new Map([["2026-09", 1000]]);
  assert.deepEqual(withPrepaidMonths([], net), ["2026-09"]);
});

test("낸 게 하나도 없으면 기본 목록을 그대로 돌려준다", () => {
  assert.deepEqual(withPrepaidMonths(base, new Map()), base);
});

test("★ 선납한 9월은 부분납으로 판정된다 — 1,000원만 냈으니 나머지가 남는다", () => {
  const net = new Map([["2026-09", 1000]]);
  const months = withPrepaidMonths(base, net).map(m =>
    computeMonthStatus(m, 300000, net.get(m) || 0, PARTIAL_PAYMENT_SINCE)
  );
  const sep = months.find(m => m.month === "2026-09");
  assert.ok(sep, "9월이 목록에 없다");
  assert.equal(sep!.status, "부분납");
  assert.equal(sep!.remaining, 299000);
});

test("★ 9월을 완납했으면 완납으로 뜬다 (선납 완납도 보여야 한다)", () => {
  const net = new Map([["2026-09", 300000]]);
  const months = withPrepaidMonths(base, net).map(m =>
    computeMonthStatus(m, 300000, net.get(m) || 0, PARTIAL_PAYMENT_SINCE)
  );
  assert.equal(months.find(m => m.month === "2026-09")!.status, "완납");
});

console.log(`\n${failed === 0 ? "✅" : "❌"} 통과 ${passed} · 실패 ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
