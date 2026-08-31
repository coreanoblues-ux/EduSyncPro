/**
 * 카드 할부 정책 회귀 테스트.
 *
 * 배경 — 2026-08-31 원장 요청:
 *   "5만원 이상 결제일 때만 할부를 고를 수 있게 하고, 기본은 일시불로 해라."
 *
 * 이 파일이 지키는 것은 두 가지다.
 *
 *   1) **일시불은 언제나 0이다.** Toss Front SDK 의 `installment` 기본값이 0 이고,
 *      1 이라는 값은 문서에 정의돼 있지 않다. 화면·서버·플러그인 어디서든
 *      "일시불" 이 1 로 새어 나가면 카드사에서 무슨 일이 벌어질지 우리가 모른다.
 *
 *   2) **이상한 값은 결제를 막지 않고 일시불로 떨어진다.** 할부는 편의 기능이다.
 *      개월수가 이상하다고 수납 자체가 실패하면, 학부모는 카드를 댄 채로
 *      영문 모를 오류를 보게 된다. 그건 할부를 못 고르는 것보다 훨씬 나쁘다.
 *
 * 실행: npx tsx scripts/test-installment.ts
 */

import assert from "node:assert/strict";
import {
  INSTALLMENT_MIN_AMOUNT,
  INSTALLMENT_OPTIONS,
  LUMP_SUM,
  canChooseInstallment,
  installmentLabel,
  normalizeInstallment,
} from "../shared/installment";

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

console.log("─── 상수: SDK 문서와 어긋나면 안 된다 ───");

test("★ 일시불은 0이다 — SDK 기본값과 같은 값이어야 한다", () => {
  assert.equal(LUMP_SUM, 0);
});

test("최소 금액은 50,000원 (카드업계 관행값)", () => {
  assert.equal(INSTALLMENT_MIN_AMOUNT, 50000);
});

test("★ 후보에 1이 없다 — '1개월 할부' 라는 상품은 없다", () => {
  assert.ok(!(INSTALLMENT_OPTIONS as readonly number[]).includes(1));
});

test("★ 후보에 0이 없다 — 일시불은 후보가 아니라 기본값이다", () => {
  assert.ok(!(INSTALLMENT_OPTIONS as readonly number[]).includes(0));
});

test("원장이 요청한 후보 그대로: 2·3·4·5·6·12", () => {
  assert.deepEqual([...INSTALLMENT_OPTIONS], [2, 3, 4, 5, 6, 12]);
});

console.log("\n─── canChooseInstallment: 5만원 경계 ───");

test("★ 정확히 50,000원이면 고를 수 있다 (경계 포함)", () => {
  assert.equal(canChooseInstallment(50000), true);
});

test("★ 49,999원이면 못 고른다 — 1원 차이로 갈린다", () => {
  assert.equal(canChooseInstallment(49999), false);
});

test("28만원짜리 수강료는 고를 수 있다", () => {
  assert.equal(canChooseInstallment(280000), true);
});

test("0원·음수는 못 고른다", () => {
  assert.equal(canChooseInstallment(0), false);
  assert.equal(canChooseInstallment(-100000), false);
});

test("NaN·Infinity 는 못 고른다 — 숫자처럼 생겼다고 통과시키지 않는다", () => {
  assert.equal(canChooseInstallment(NaN), false);
  assert.equal(canChooseInstallment(Infinity), false);
});

console.log("\n─── normalizeInstallment: 어떤 입력이든 안전한 값으로 떨어진다 ───");

test("★ 3개월 요청 + 28만원 → 3개월 그대로 (정상 경로)", () => {
  assert.equal(normalizeInstallment(3, 280000), 3);
});

test("★ 6개월 요청 + 28만원 → 6개월", () => {
  assert.equal(normalizeInstallment(6, 280000), 6);
});

test("12개월 요청 + 28만원 → 12개월", () => {
  assert.equal(normalizeInstallment(12, 280000), 12);
});

test("★ 5만원 미만인데 3개월을 요청하면 일시불로 떨어진다 (태블릿이 우회해도 서버가 막는다)", () => {
  assert.equal(normalizeInstallment(3, 30000), LUMP_SUM);
});

test("★ 49,999원 + 2개월 → 일시불", () => {
  assert.equal(normalizeInstallment(2, 49999), LUMP_SUM);
});

test("★ 1 을 보내면 일시불(0)로 바꾼다 — 1이 SDK 로 새어 나가면 안 된다", () => {
  assert.equal(normalizeInstallment(1, 280000), LUMP_SUM);
});

test("★ 후보에 없는 7개월은 일시불로 떨어진다 — 결제를 막지는 않는다", () => {
  assert.equal(normalizeInstallment(7, 280000), LUMP_SUM);
});

test("후보에 없는 24개월도 일시불", () => {
  assert.equal(normalizeInstallment(24, 280000), LUMP_SUM);
});

test("★ null / undefined 는 일시불 — 옛날 태블릿이 이 값을 안 보낸다", () => {
  assert.equal(normalizeInstallment(null, 280000), LUMP_SUM);
  assert.equal(normalizeInstallment(undefined, 280000), LUMP_SUM);
});

test("0 을 보내면 그대로 일시불", () => {
  assert.equal(normalizeInstallment(0, 280000), LUMP_SUM);
});

test("음수는 일시불", () => {
  assert.equal(normalizeInstallment(-3, 280000), LUMP_SUM);
});

test("소수는 일시불 — 3.5개월 할부는 없다", () => {
  assert.equal(normalizeInstallment(3.5, 280000), LUMP_SUM);
});

test("NaN 은 일시불", () => {
  assert.equal(normalizeInstallment(NaN, 280000), LUMP_SUM);
});

test("★ 어떤 입력을 넣어도 던지지 않는다 — 할부 때문에 결제가 죽으면 안 된다", () => {
  const weird: any[] = [null, undefined, NaN, Infinity, -Infinity, 0, 1, 1.5, 99, -1];
  for (const w of weird) {
    for (const amt of [0, 49999, 50000, 280000, NaN]) {
      const r = normalizeInstallment(w, amt);
      assert.ok(
        r === 0 || (INSTALLMENT_OPTIONS as readonly number[]).includes(r),
        `normalizeInstallment(${String(w)}, ${amt}) = ${r} — 0도 후보도 아니다`
      );
    }
  }
});

test("★ 결과는 항상 0 이거나 후보 중 하나다 (단말기에 임의값이 가지 않는다)", () => {
  for (const opt of INSTALLMENT_OPTIONS) {
    assert.equal(normalizeInstallment(opt, 50000), opt);
  }
});

console.log("\n─── installmentLabel: 화면 문구 ───");

test("0 은 '일시불'", () => {
  assert.equal(installmentLabel(0), "일시불");
});

test("null / undefined 도 '일시불' — 옛 데이터는 일시불로 읽는다", () => {
  assert.equal(installmentLabel(null), "일시불");
  assert.equal(installmentLabel(undefined), "일시불");
});

test("1 도 '일시불' 로 읽는다", () => {
  assert.equal(installmentLabel(1), "일시불");
});

test("3 은 '3개월 할부'", () => {
  assert.equal(installmentLabel(3), "3개월 할부");
});

test("★ 어디에도 '무이자' 라는 말을 쓰지 않는다 — 이자 여부는 카드사 소관이다", () => {
  const all = [null, undefined, 0, 1, 2, 3, 4, 5, 6, 12, 99].map(installmentLabel);
  for (const label of all) {
    assert.ok(!label.includes("무이자"), `'${label}' 에 무이자가 들어 있다`);
  }
});

test("★ 월 납입액을 계산해서 보여 주지 않는다 — 수수료를 우리가 모른다", () => {
  // 라벨에 '원' 이 들어가면 금액을 계산해 붙였다는 뜻이다.
  assert.ok(!installmentLabel(3).includes("원"));
});

console.log(`\n${failed === 0 ? "✅" : "❌"} 통과 ${passed} · 실패 ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
