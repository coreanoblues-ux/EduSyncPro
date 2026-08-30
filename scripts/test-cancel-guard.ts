/**
 * 큰 금액 취소 잠금장치.
 *
 * ══ 이 장치가 막으려는 단 하나의 사고 ══
 *
 *   수납 목록에서 취소 버튼은 줄마다 똑같이 생겼다. 지금 화면에는 시험용
 *   1,000원 결제들 **사이에 269,000원 한 건이 끼어 있다.** 손가락이 한 줄
 *   미끄러지면 원비 전액이 학부모 카드로 돌아가고, 되돌릴 방법이 없다.
 *
 *   결제 실수는 취소하면 된다. 취소 실수는 되돌릴 수 없다. 두 방향의 위험이
 *   대칭이 아니라서 취소 쪽에만 문턱을 둔다.
 *
 * ══ 두 방향의 실패 ══
 *
 *   너무 관대하면 → 269001 같은 오타가 통과한다. 장치가 있으나 마나 해진다.
 *   너무 엄격하면 → 쉼표 하나에 막혀 원장이 정당한 환불을 못 한다.
 *
 *   그래서 표기 흔들림("269,000" · " 269000원")은 받아주되 숫자 자체는
 *   정확히 같아야 한다.
 *
 * 실행: npx tsx scripts/test-cancel-guard.ts
 */

import assert from "node:assert/strict";
import {
  AMOUNT_TYPING_THRESHOLD,
  amountTypingMatches,
  canSubmitCancel,
  requiresAmountTyping,
} from "../shared/cancelGuard";

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

console.log("─── 1. ★ 실제 화면에 나란히 있는 두 줄 ───");

test("★ 1,000원 시험 결제는 막지 않는다 (원장 시험이 번거로워지면 안 된다)", () => {
  assert.equal(requiresAmountTyping(1000), false);
  assert.equal(canSubmitCancel(1000, ""), true, "★ 빈 칸으로도 바로 눌려야 한다");
});

test("★ 269,000원 원비는 금액을 쳐야만 열린다 (줄 잘못 짚기 방지)", () => {
  assert.equal(requiresAmountTyping(269000), true);
  assert.equal(canSubmitCancel(269000, ""), false, "★ 빈 칸인데 열렸다");
  assert.equal(canSubmitCancel(269000, "269000"), true);
});

test("★ 1,000원 줄을 누른 줄 알고 1000 을 쳤다면 269,000원은 열리지 않는다", () => {
  assert.equal(canSubmitCancel(269000, "1000"), false, "★ 바로 이 사고를 막으려는 것이다");
});

console.log("\n─── 2. 문턱 ───");

test("문턱 위아래", () => {
  assert.equal(requiresAmountTyping(AMOUNT_TYPING_THRESHOLD - 1), false);
  assert.equal(requiresAmountTyping(AMOUNT_TYPING_THRESHOLD), true, "10만원 정확히는 막는 쪽");
  assert.equal(requiresAmountTyping(AMOUNT_TYPING_THRESHOLD + 1), true);
});

test("금액을 알 수 없으면 막는 쪽으로 튼다", () => {
  for (const v of [NaN, Infinity, -Infinity]) {
    assert.equal(requiresAmountTyping(v), true, `${v} 를 통과시켰다`);
  }
});

console.log("\n─── 3. 표기 흔들림은 받아준다 (정당한 환불을 막지 않는 쪽) ───");

test("쉼표·공백·'원' 은 무시한다", () => {
  for (const s of ["269000", "269,000", " 269000 ", "269,000원", "269000원"]) {
    assert.equal(amountTypingMatches(s, 269000), true, `"${s}" 를 거부했다`);
  }
});

console.log("\n─── 4. ★ 그러나 숫자는 정확해야 한다 ───");

test("★ 한 자리라도 다르면 열리지 않는다", () => {
  for (const s of ["269001", "26900", "2690000", "268999", "270000"]) {
    assert.equal(amountTypingMatches(s, 269000), false, `★ "${s}" 가 통과했다`);
  }
});

test("★ 숫자가 아닌 것으로는 열 수 없다", () => {
  for (const s of ["", "   ", "abc", "26a000", "-269000", "269000.0", "２６９０００"]) {
    assert.equal(amountTypingMatches(s, 269000), false, `★ "${s}" 가 통과했다`);
  }
});

test("문자열이 아닌 값은 조용히 거짓", () => {
  for (const v of [null, undefined, 269000, {}, []]) {
    assert.equal(amountTypingMatches(v as any, 269000), false);
  }
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
