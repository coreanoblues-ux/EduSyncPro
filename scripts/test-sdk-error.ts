/**
 * SDK 오류 코드 판별. 자동 대사가 결론을 내릴 수 있는지를 정하는 규칙이다.
 *
 * ══ 왜 이 파일이 생겼나 (2026-08-30) ══
 *
 *   카드취소가 왜 조용한지 보려고 단말기 로그를 열었더니, 초당 한 줄씩 이것만
 *   쌓이고 있었다:
 *
 *     ERROR 자동 대사 확인 실패 — TossFrontSDKError: PAYMENT_NOT_FOUND
 *           paymentKey=tf_da59f5bc… — 판단을 보류하고 다음 폴링에서 다시 확인합니다.
 *
 *   메시지에 PAYMENT_NOT_FOUND 라고 대놓고 적혀 있는데 "판단 보류" 로 갔다.
 *   원인은 코드를 꺼내는 한 줄이었다:
 *
 *     err.code ?? err.errorCode ?? err.type ?? err.name      ← err.name 이 먼저 잡힌다
 *
 *   현장 오류는 name 이 "TossFrontSDKError" 이고 진짜 코드는 message 에 있다.
 *   그래서 코드가 늘 "TossFrontSDKError" 로 나왔고, PAYMENT_NOT_FOUND 비교는
 *   **한 번도 참이 된 적이 없었다.** 자동 대사는 영원히 결론을 못 냈고, 로그는
 *   영원히 덮였다. 조용한 실패가 조용한 실패를 가렸다.
 *
 * ══ 이 테스트가 지키는 두 방향 ══
 *
 *   너무 좁으면 → 결론을 못 내고 무한 재시도. 로그가 덮인다. (위 사고)
 *   너무 넓으면 → 네트워크 오류를 "승인 없음" 으로 오인해 멀쩡한 결제에 표식을
 *                 찍는다. 돈이 걸린 쪽이라 이게 더 나쁘다.
 *
 *   그래서 아래는 "잡아야 하는 것" 과 "절대 잡으면 안 되는 것" 을 같은 수만큼 건다.
 *
 * 실행: npx tsx scripts/test-sdk-error.ts
 */

import assert from "node:assert/strict";
import {
  MAX_REASON_LEN,
  PAYMENT_NOT_FOUND,
  describeFailure,
  errCode,
  errCodeCandidates,
  isPaymentNotFound,
  safeRawSummary,
} from "../plugins/toss-front/src/sdkError";

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

/** 현장 단말기가 실제로 던진 모양. 이 테스트 파일의 존재 이유다. */
function 현장오류(): Error {
  const e = new Error("PAYMENT_NOT_FOUND");
  e.name = "TossFrontSDKError";
  return e;
}

console.log("─── 1. ★ 현장에서 놓쳤던 바로 그 오류 ───");

test("★ name 이 TossFrontSDKError 이고 code 가 message 에 있어도 잡아낸다", () => {
  assert.equal(isPaymentNotFound(현장오류()), true, "★ 이걸 놓쳐서 무한 재시도가 났다");
});

test("★ 옛 구현(?? 사슬)이 왜 틀렸는지 — name 이 먼저 잡혔다", () => {
  const err = 현장오류();
  const 옛코드 = (err as any).code ?? (err as any).errorCode ?? (err as any).type ?? err.name;
  assert.equal(옛코드, "TossFrontSDKError", "버그 재현: 진짜 코드가 아니라 클래스 이름이 나왔다");
  assert.notEqual(옛코드, PAYMENT_NOT_FOUND);
  // 새 구현은 아는 코드를 우선한다.
  assert.equal(errCode(err), PAYMENT_NOT_FOUND, "★ 감사 기록에도 진짜 코드가 남아야 한다");
});

test("후보를 순서가 아니라 전부 모아서 본다", () => {
  const cands = errCodeCandidates(현장오류());
  assert.ok(cands.includes("TossFrontSDKError"));
  assert.ok(cands.includes(PAYMENT_NOT_FOUND));
});

console.log("\n─── 2. 펌웨어마다 코드를 다른 자리에 넣는다 ───");

test("err.code 에 있는 경우", () => {
  assert.equal(isPaymentNotFound({ code: PAYMENT_NOT_FOUND }), true);
});

test("err.errorCode 에 있는 경우", () => {
  assert.equal(isPaymentNotFound({ errorCode: PAYMENT_NOT_FOUND }), true);
});

test("err.type 에 있는 경우", () => {
  assert.equal(isPaymentNotFound({ type: PAYMENT_NOT_FOUND }), true);
});

test("문자열 하나만 던지는 경우", () => {
  assert.equal(isPaymentNotFound(PAYMENT_NOT_FOUND), true);
});

test("긴 문장 안에 섞여 있어도 단어로 잡는다", () => {
  assert.equal(
    isPaymentNotFound(new Error("TossFrontSDKError: PAYMENT_NOT_FOUND | at Function.value")),
    true,
  );
});

console.log("\n─── 3. ★ 절대 잡으면 안 되는 것들 (멀쩡한 결제를 지키는 쪽) ───");
//
// 여기서 참이 나오면 승인된 결제에 "승인 없음" 표식이 찍힌다.
// 위쪽 실패는 로그가 지저분해지는 것이고, 이쪽 실패는 돈 문제다.

test("★ 네트워크 오류를 승인 없음으로 오인하지 않는다", () => {
  for (const err of [
    new Error("Failed to fetch"),
    new Error("Network request failed"),
    new Error("timeout of 5000ms exceeded"),
    { code: "ECONNRESET" },
    { code: "ETIMEDOUT" },
  ]) {
    assert.equal(isPaymentNotFound(err), false, `★ ${JSON.stringify(String(err))} 를 잡아버렸다`);
  }
});

test("★ 'not found' 같은 느슨한 문구로는 잡지 않는다", () => {
  for (const msg of [
    "not found",
    "404 Not Found",
    "resource not found",
    "PAYMENT not found",
    "payment_not_found", // 소문자는 다른 코드다. 추측하지 않는다.
  ]) {
    assert.equal(isPaymentNotFound(new Error(msg)), false, `★ "${msg}" 를 잡아버렸다`);
  }
});

test("★ 비슷하지만 다른 코드를 잡지 않는다", () => {
  for (const code of [
    "PAYMENT_NOT_FOUNDED",
    "XPAYMENT_NOT_FOUND",
    "PAYMENT_NOT_FOUND_ERROR_V2",
    "CARD_NOT_FOUND",
    "PAYMENT_CANCELED",
  ]) {
    assert.equal(isPaymentNotFound({ code }), false, `★ "${code}" 를 잡아버렸다`);
  }
});

test("빈 값들은 조용히 거짓", () => {
  for (const err of [null, undefined, "", "   ", {}, { code: "" }, { code: null }]) {
    assert.equal(isPaymentNotFound(err as any), false);
    assert.equal(errCode(err as any), null);
  }
});

console.log("\n─── 4. 감사 기록용 대표 코드 ───");

test("아는 코드가 없으면 첫 후보를 그대로 남긴다", () => {
  assert.equal(errCode({ code: "SOME_OTHER" }), "SOME_OTHER");
  assert.equal(errCode(new Error("boom")), "Error");
});

test("공백은 정리한다", () => {
  assert.equal(errCode({ code: "  TRIMMED  " }), "TRIMMED");
});

console.log("\n─── 5. 취소 실패 진단 — 한 번뿐인 시험에서 최대한 건진다 ───");
//
// 원장님께 시험용 결제는 1,000원 한 건뿐이다. 그 한 번이 실패했을 때
// "사유를 알리지 않았습니다" 만 남으면 다음에 무엇을 고쳐야 할지 알 수 없다.

test("★ code 와 message 가 같이 오면 둘 다 남긴다 (?? 사슬이면 code 를 잃는다)", () => {
  const r = { type: "FAILED", code: "CANCEL_NOT_ALLOWED", message: "취소 실패" };
  const 옛방식 = (r as any).message ?? (r as any).reason ?? (r as any).code;
  assert.equal(옛방식, "취소 실패", "버그 재현: 쓸모없는 message 만 남고 code 가 사라진다");

  const d = describeFailure(r);
  assert.ok(d.includes("CANCEL_NOT_ALLOWED"), `★ 결정적 단서인 code 가 빠졌다: ${d}`);
  assert.ok(d.includes("취소 실패"));
});

test("사유가 하나도 없으면 사람이 읽을 문장을 남긴다", () => {
  assert.equal(describeFailure({ type: "CANCELED" }), "단말기가 사유를 알리지 않았습니다.");
  assert.equal(describeFailure(null), "단말기가 사유를 알리지 않았습니다.");
});

test("같은 문자열이 code 와 message 에 겹쳐도 한 번만 적는다", () => {
  const d = describeFailure({ code: "E1", message: "E1" });
  assert.equal(d, "code=E1");
});

test("★ reason 은 서버 상한(300자)을 넘지 않는다 — 넘으면 400 → 무한 재전송", () => {
  const d = describeFailure({ code: "X".repeat(400), message: "Y".repeat(400) });
  assert.ok(d.length <= MAX_REASON_LEN, `${d.length}자나 된다`);
});

console.log("\n─── 6. ★ 감사 기록에 카드번호가 새지 않는가 ───");

test("★ card.number 는 절대 통과하지 못한다", () => {
  const r = {
    type: "SUCCESS",
    response: {
      paymentKey: "pk_1", amount: 1000, approvalNumber: "12345678", tid: "TID-1",
      card: { number: "1234-56**-****-7890", issuerName: "신한", cardType: "체크" },
    },
  };
  const safe = safeRawSummary(r)!;
  const json = JSON.stringify(safe);
  assert.ok(!json.includes("1234-56"), `★ 카드번호가 새어 나갔다: ${json}`);
  assert.ok(!json.includes("number"), `★ number 필드가 통과했다: ${json}`);
  // 대조할 때 필요한 것들은 남아 있어야 한다.
  assert.equal((safe.response as any).approvalNumber, "12345678");
  assert.equal((safe.response as any).card.issuerName, "신한");
});

test("★ 정체불명의 raw 는 통째로 버린다 (허용목록에 없다)", () => {
  const safe = safeRawSummary({
    type: "FAILED", code: "E9",
    raw: { pan: "4111111111111111", track2: "위험한것" },
  })!;
  const json = JSON.stringify(safe);
  assert.ok(!json.includes("4111"), `★ raw 안의 카드번호가 새어 나갔다: ${json}`);
  assert.ok(!json.includes("track2"));
  assert.equal(safe.code, "E9", "진단에 필요한 code 는 남아야 한다");
});

test("새 펌웨어가 모르는 필드를 늘려도 자동으로 걸러진다", () => {
  const safe = safeRawSummary({ type: "FAILED", code: "E1", 새필드: "몰라도되는값" })!;
  assert.equal(safe.code, "E1");
  assert.ok(!Object.keys(safe).includes("새필드"));
});

test("객체가 아니거나 건질 게 없으면 null", () => {
  for (const v of [null, undefined, "문자열", 123, {}]) {
    assert.equal(safeRawSummary(v as any), null);
  }
});

test("중첩 객체·함수 같은 건 값으로 받지 않는다 (스칼라만)", () => {
  const safe = safeRawSummary({ type: "FAILED", code: { nested: "x" }, message: "진짜사유" })!;
  assert.equal(safe.code, undefined, "객체인 code 는 버린다");
  assert.equal(safe.message, "진짜사유");
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
