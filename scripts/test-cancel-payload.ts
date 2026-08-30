/**
 * 원거래 조회 키를 SDK 타입으로 맞추는 규칙.
 *
 * ══ 이 테스트가 생긴 이유 (2026-08-31) ══
 *
 *   단말기가 "원거래 없음" 을 던졌다. 하루 전에 고친 것은 형식이었다 —
 *   ISO 문자열을 밀리초로 바꿨다. 그런데도 못 찾았다.
 *
 *   공식 문서 파라미터 표에는 `timestamp | number | 필수` 라고 적혀 있었다.
 *   우리는 "1756555555000" 이라는 **문자열**을 보내고 있었다. 값은 맞고
 *   타입이 틀렸다. 우리가 직접 쓴 sdk.ts 선언이 `string` 이어서 컴파일러도
 *   잡아 주지 못했다 — 틀린 타입 선언은 방어가 아니라 위장이었다.
 *
 * ══ 두 방향 ══
 *   못 바꾸는데 보내면 → "원거래 없음". 그때 카드 상태를 확신할 수 없다.
 *   그래서 애매하면 null 을 주고, 호출부는 SDK 를 아예 부르지 않는다.
 *   부르지 않았다는 확신이 있어야 재시도를 허용할 수 있다.
 *
 * 실행: npx tsx scripts/test-cancel-payload.ts
 */

import assert from "node:assert/strict";
import { toEpochMillis } from "../plugins/toss-front/src/cancelPayload";

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

/** 2026-08-30 12:05:55 KST 즈음. 서버가 내려보내는 모양이다. */
const MS = 1756555555000;

console.log("─── 1. ★ 현장에서 틀렸던 그 지점 ───");

test("★ 밀리초 문자열을 숫자로 바꾼다 (문자열로 보내서 원거래를 못 찾았다)", () => {
  const out = toEpochMillis(String(MS));
  assert.equal(out, MS);
  assert.equal(typeof out, "number", "★ 타입이 number 여야 한다. 이게 이번 버그의 전부였다");
});

test("이미 숫자면 그대로 쓴다", () => {
  assert.equal(toEpochMillis(MS), MS);
});

console.log("\n─── 2. ★ 해석 못 하면 부르지 않는다 (null) ───");
//
// null 이 나오면 호출부는 SDK 를 부르지 않고 FAILED 로 보고한다.
// 카드를 건드리지 않은 것이 확실해야 다시 시도할 수 있다.

test("★ ISO 문자열은 거부한다 — 이전 버전이 보내던 바로 그 값", () => {
  assert.equal(toEpochMillis("2026-08-30T12:05:55.000Z"), null);
});

test("★ 초 단위(10자리)를 밀리초로 착각하지 않는다", () => {
  assert.equal(toEpochMillis(1756555555), null, "★ 1970년대로 해석돼 원거래를 못 찾는다");
});

test("숫자가 아닌 문자열·빈 값은 거부한다", () => {
  for (const v of ["", "   ", "abc", "17565a55000", "1756555555000.5", "-1756555555000"]) {
    assert.equal(toEpochMillis(v), null, `"${v}" 를 통과시켰다`);
  }
});

test("null·undefined·객체는 거부한다", () => {
  for (const v of [null, undefined, {}, [], true, NaN, Infinity]) {
    assert.equal(toEpochMillis(v as any), null, `${String(v)} 를 통과시켰다`);
  }
});

console.log("\n─── 3. 상식적인 범위 밖은 거부한다 ───");

test("1990년 이전 / 2100년 이후는 거부한다", () => {
  assert.equal(toEpochMillis(0), null);
  assert.equal(toEpochMillis(631_151_999_999), null);
  assert.equal(toEpochMillis(4_102_444_800_001), null);
});

test("경계값은 받아들인다", () => {
  assert.equal(toEpochMillis(631_152_000_000), 631_152_000_000);
  assert.equal(toEpochMillis(4_102_444_800_000), 4_102_444_800_000);
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
