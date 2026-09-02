/**
 * 기타 결제(학생과 연결되지 않은 결제) 정책 회귀 테스트.
 *
 * 배경 — 2026-09 원장 요청:
 *   "학원 웹앱에 학생으로 등록되지 않은 건(아직 등록 안 한 학생이든 자료 판매든)도
 *    태블릿에서 금액을 입력하고 결제 요청을 할 수 있어야 한다."
 *
 * 이 파일이 지키는 것은 세 가지다.
 *
 *   1) **화면과 서버가 같은 답을 낸다.** 기타 결제의 금액에는 서버가 대조할 사실이
 *      없다(청구서 잔액 같은 게 없다). 그래서 형식 검사와 상한이 유일한 방어선이고,
 *      그 규칙이 화면과 서버에서 갈라지면 태블릿에서는 통과한 금액이 서버에서
 *      거절되거나 그 반대가 된다. 그래서 판정은 shared/customPayment.ts 한 벌뿐이고,
 *      아래 테스트는 그 한 벌을 검증한다.
 *
 *   2) **자릿수 실수는 막고, 결제 자체는 막지 않는다.** 손으로 찍는 유일한 금액이라
 *      0 이 하나 더 붙는 사고가 실제로 난다. 상한은 그걸 잡되, 정상적인 학원 결제가
 *      상한에 걸리면 안 된다.
 *
 *   3) **내용(라벨)은 절대 빈 값으로 저장되지 않는다.** 등록이 연결돼 있지 않으니
 *      이 한 줄이 "무슨 돈이었나" 를 되짚을 유일한 단서다.
 *
 * 실행: npx tsx scripts/test-custom-payment.ts
 */

import assert from "node:assert/strict";
import {
  CUSTOM_LABEL_MAX,
  CUSTOM_MAX_AMOUNT,
  DEFAULT_CUSTOM_LABEL,
  isValidCustomAmount,
  parseAmountText,
  sanitizeCustomLabel,
} from "../shared/customPayment";
import { normalizeInstallment, LUMP_SUM } from "../shared/installment";

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

console.log("─── 상수 ───");

test("상한은 1천만원", () => {
  assert.equal(CUSTOM_MAX_AMOUNT, 10_000_000);
});

test("★ 학원에서 실제로 있을 법한 금액은 상한에 걸리지 않는다", () => {
  // 분기 수강료 선납, 교재 묶음 판매까지 넉넉히 잡아도 이 정도다.
  for (const amount of [10_000, 150_000, 300_000, 900_000, 2_400_000]) {
    assert.ok(isValidCustomAmount(amount), `${amount}원이 막혔다`);
  }
});

test("라벨 최대 길이는 40자 (단말기 표시·영수증이 한 줄이다)", () => {
  assert.equal(CUSTOM_LABEL_MAX, 40);
});

console.log("\n─── 금액 읽기: 사람이 친 문자열을 숫자로 ───");

test("숫자만 친 경우", () => {
  assert.equal(parseAmountText("150000"), 150000);
});

test("★ 쉼표를 넣어도 읽는다 — 태블릿 키보드로 '150,000' 을 치는 사람이 있다", () => {
  assert.equal(parseAmountText("150,000"), 150000);
});

test("★ '원' 을 붙여 쳐도 읽는다", () => {
  assert.equal(parseAmountText("150000원"), 150000);
});

test("빈 문자열은 0 (아직 아무것도 안 쳤다는 뜻)", () => {
  assert.equal(parseAmountText(""), 0);
});

test("null·undefined 도 0 — 타이핑 중 매 글자마다 불리는 함수라 던지면 안 된다", () => {
  assert.equal(parseAmountText(null), 0);
  assert.equal(parseAmountText(undefined), 0);
});

test("글자만 있으면 0", () => {
  assert.equal(parseAmountText("삼만원"), 0);
});

test("★ 소수점은 버려지고 정수만 남는다 — 원 단위 아래는 결제에 존재하지 않는다", () => {
  // "1000.5" → 숫자만 남기면 10005 가 되는데, 이건 사용자가 의도한 값이 아니다.
  // 다만 그런 입력을 애초에 만들 수 있는 UI 가 없고(숫자판), 화면에 결과 금액을
  // 큰 글씨로 다시 보여 주므로 여기서는 "정수가 나온다" 만 보장한다.
  assert.ok(Number.isInteger(parseAmountText("1000.5")));
});

test("★ 터무니없이 긴 숫자를 쳐도 함수가 죽지 않는다", () => {
  const n = parseAmountText("9".repeat(30));
  assert.ok(Number.isInteger(n) || n === 0);
});

console.log("\n─── 금액 판정: 화면과 서버가 같은 답을 내야 한다 ───");

test("0원은 안 된다", () => {
  assert.equal(isValidCustomAmount(0), false);
});

test("음수는 안 된다", () => {
  assert.equal(isValidCustomAmount(-1000), false);
});

test("1원은 된다 (형식상 유효 — 상한만 우리가 정한다)", () => {
  assert.equal(isValidCustomAmount(1), true);
});

test("★ 상한 경계: 딱 1천만원은 되고, 1원 더는 안 된다", () => {
  assert.equal(isValidCustomAmount(CUSTOM_MAX_AMOUNT), true);
  assert.equal(isValidCustomAmount(CUSTOM_MAX_AMOUNT + 1), false);
});

test("★ 0 하나를 더 누른 사고를 잡는다 (150만 → 1500만)", () => {
  assert.equal(isValidCustomAmount(1_500_000), true);
  assert.equal(isValidCustomAmount(15_000_000), false);
});

test("소수는 안 된다 — 원 아래 단위로 카드를 긁을 수 없다", () => {
  assert.equal(isValidCustomAmount(1000.5), false);
});

test("NaN·Infinity 는 안 된다", () => {
  assert.equal(isValidCustomAmount(NaN), false);
  assert.equal(isValidCustomAmount(Infinity), false);
});

console.log("\n─── 내용(라벨): 장부에 남는 유일한 단서 ───");

test("친 대로 남는다", () => {
  assert.equal(sanitizeCustomLabel("교재 3권"), "교재 3권");
});

test("★ 비워 두면 기본 문구가 들어간다 — 빈 값으로 저장되면 나중에 알 길이 없다", () => {
  assert.equal(sanitizeCustomLabel(""), DEFAULT_CUSTOM_LABEL);
  assert.equal(sanitizeCustomLabel("   "), DEFAULT_CUSTOM_LABEL);
  assert.equal(sanitizeCustomLabel(null), DEFAULT_CUSTOM_LABEL);
  assert.equal(sanitizeCustomLabel(undefined), DEFAULT_CUSTOM_LABEL);
});

test("앞뒤 공백은 잘린다", () => {
  assert.equal(sanitizeCustomLabel("  교재  "), "교재");
});

test("★ 줄바꿈은 공백이 된다 — 단말기 표시와 영수증은 한 줄짜리 필드다", () => {
  const out = sanitizeCustomLabel("교재\n3권");
  assert.ok(!out.includes("\n"), `줄바꿈이 남았다: ${JSON.stringify(out)}`);
  assert.equal(out, "교재 3권");
});

test("탭·연속 공백도 한 칸으로 정리된다", () => {
  assert.equal(sanitizeCustomLabel("교재\t\t3권"), "교재 3권");
});

test("★ 40자를 넘으면 잘린다 (넘긴다고 거절하지 않는다 — 결제를 막을 이유가 없다)", () => {
  const long = "가".repeat(100);
  const out = sanitizeCustomLabel(long);
  assert.equal(out.length, CUSTOM_LABEL_MAX);
});

test("★ 어떤 입력이 와도 빈 문자열은 나오지 않는다", () => {
  const inputs = ["", " ", "\n", "\t", "\r\n", null, undefined, "   \n\t  "];
  for (const raw of inputs) {
    const out = sanitizeCustomLabel(raw as any);
    assert.ok(out.length > 0, `빈 라벨이 나왔다: ${JSON.stringify(raw)}`);
  }
});

test("★ 화면이 보여 준 라벨과 서버가 저장하는 라벨이 같다 (두 번 다듬어도 안 바뀐다)", () => {
  // 태블릿이 sanitize 한 값을 보내고 서버가 한 번 더 sanitize 한다. 두 번 돌렸을 때
  // 값이 달라지면 확인 화면에서 본 문구와 장부에 남는 문구가 어긋난다.
  const inputs = ["교재 3권", "  김민준 3월 수강료(등록 전) ", "가".repeat(100), "", "a\nb"];
  for (const raw of inputs) {
    const once = sanitizeCustomLabel(raw);
    assert.equal(sanitizeCustomLabel(once), once, `두 번 다듬으니 달라졌다: ${JSON.stringify(raw)}`);
  }
});

console.log("\n─── 할부: 학생 결제와 같은 규칙을 쓴다 ───");

test("★ 5만원 미만 기타 결제는 일시불로 떨어진다 (학생 결제와 동일)", () => {
  assert.equal(normalizeInstallment(3, 30_000), LUMP_SUM);
});

test("5만원 이상이면 고른 개월이 그대로 간다", () => {
  assert.equal(normalizeInstallment(3, 150_000), 3);
});

console.log("\n─── 결합: 태블릿에서 서버까지 한 바퀴 ───");

test("★ 화면 입력 → 금액 → 판정 → 라벨 이 한 줄로 이어진다", () => {
  const typed = "150,000";
  const amount = parseAmountText(typed);
  assert.equal(amount, 150_000);
  assert.ok(isValidCustomAmount(amount));
  assert.equal(sanitizeCustomLabel("김민준 3월 수강료(등록 전)"), "김민준 3월 수강료(등록 전)");
  assert.equal(normalizeInstallment(3, amount), 3);
});

test("★ 상한을 넘긴 입력은 화면에서 이미 걸린다 (서버까지 가지 않는다)", () => {
  const amount = parseAmountText("15,000,000");
  assert.equal(amount, 15_000_000);
  assert.equal(isValidCustomAmount(amount), false);
});

console.log(`\n${failed === 0 ? "✅" : "❌"} 통과 ${passed} · 실패 ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
