/**
 * 승인 응답에서 원거래 조회 키를 꺼내는 규칙.
 *
 * ══ 이 테스트가 생긴 이유 (2026-08-31) ══
 *
 *   "원거래 없음" 을 세 번 만났다. 두 번은 형식을 고쳤다 (ISO→밀리초, string→number).
 *   세 번째에 공식 문서와 대조하고서야 알았다. 틀린 것은 형식이 아니라 **값**이었다.
 *
 *   공식 CARD 승인 응답은 `response.card.approvalNumber` · `response.card.timestamp`
 *   인데, 우리는 `response.approvalNumber` · `response.approvedAt` 을 읽고 있었다.
 *   존재하지 않는 필드다. 그래서 승인번호 자리에 "복구" 가, 승인 시각 자리에
 *   **그 결제와 아무 상관 없는 우리 시계**가 들어갔다. 취소는 그 둘을 조회 키로
 *   보냈고, 그런 거래는 세상에 없으므로 결과는 언제나 "원거래 없음" 이었다.
 *
 *   컴파일러가 못 잡은 이유: sdk.ts 의 타입 선언을 우리가 직접, 틀리게 썼다.
 *   **틀린 타입 선언은 방어가 아니라 위장이다.**
 *
 * ══ 그래서 이 파일이 고정하는 것 ══
 *   1. 공식 필드에서 값을 읽는다.
 *   2. 모르면 **만들어 내지 않는다** (null). 특히 시각을 지금 시각으로 채우지 않는다.
 *   3. 승인번호는 문자열 그대로 — 앞자리 0 이 사라지면 그것도 "원거래 없음" 이다.
 *   4. 플러그인의 표식과 서버의 거절 목록이 **같은 문자열**이다.
 *
 * 실행: npx tsx scripts/test-approval.ts
 */

import assert from "node:assert/strict";
import {
  UNKNOWN_APPROVAL_NUMBER,
  describeResponseShape,
  extractApproval,
  formatCancelDiag,
} from "../plugins/toss-front/src/approval";
import { UNRESOLVABLE_APPROVAL_NUMBERS } from "../server/toss-front/cardCancel";

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

/** 2026-08-30 12:05:55 KST 즈음. 단말기가 승인 시각으로 주는 모양이다. */
const MS = 1756555555000;
const SENT = { paymentKey: "pk_test_0001" } as const;

/** 공식 문서에 적힌 CARD 승인 성공 응답 그대로. */
const OFFICIAL = {
  paymentMethod: "CARD",
  tid: "A1234567",
  vanTransactionKey: "vtk_9999",
  card: {
    timestamp: MS,
    approvalNumber: "01234567",
    installment: 0,
    van: "KSNET",
    shopCode: "SHOP01",
    number: "1234-****-****-5678",
    issuerName: "신한",
    acquirerName: "신한",
    cardType: "신용",
  },
};

console.log("─── 1. ★ 공식 응답 구조를 읽는다 ───");

test("★ card.timestamp 를 승인 시각으로 읽는다", () => {
  const a = extractApproval(OFFICIAL, SENT);
  assert.equal(a.timestamp, MS);
  assert.equal(a.timestampSource, "card.timestamp");
});

test("★ card.approvalNumber 를 승인번호로 읽는다", () => {
  const a = extractApproval(OFFICIAL, SENT);
  assert.equal(a.approvalNumber, "01234567");
  assert.equal(a.approvalNumberSource, "card.approvalNumber");
});

test("★ 승인번호의 앞자리 0 이 살아 있다 (숫자로 바꾸면 원거래를 못 찾는다)", () => {
  const a = extractApproval(OFFICIAL, SENT);
  assert.equal(a.approvalNumber, "01234567", "★ '1234567' 이 되면 안 된다");
});

test("tid·vanTransactionKey·van·shopCode 를 읽는다", () => {
  const a = extractApproval(OFFICIAL, SENT);
  assert.equal(a.tid, "A1234567");
  assert.equal(a.vanTransactionKey, "vtk_9999");
  assert.equal(a.van, "KSNET");
  assert.equal(a.shopCode, "SHOP01");
});

test("★ paymentKey 는 우리가 보낸 값이다 (응답에서 새로 얻지 않는다)", () => {
  // 응답에 엉뚱한 paymentKey 가 섞여 있어도 우리가 보낸 값을 쓴다.
  const a = extractApproval({ ...OFFICIAL, paymentKey: "pk_WRONG" }, SENT);
  assert.equal(a.paymentKey, "pk_test_0001");
});

test("공식 응답이면 부족한 조회 키가 없다", () => {
  assert.deepEqual(extractApproval(OFFICIAL, SENT).missing, []);
});

console.log("\n─── 2. ★ 0.3.18 까지의 그 응답을 넣어 본다 (회귀 방지) ───");
//
// 이것이 실제로 우리가 받던 응답이다. 예전 코드는 여기서 "복구" 와 현재 시각을
// 만들어 냈다. 지금은 **모른다고 말해야** 한다.

test("★ 공식 필드가 없으면 timestamp 는 null 이다 (현재 시각으로 채우지 않는다)", () => {
  const before = Date.now();
  const a = extractApproval({ paymentMethod: "CARD", card: {} }, SENT);
  assert.equal(a.timestamp, null, "★ 여기서 지금 시각을 만들어 내면 그게 그 버그다");
  assert.ok(a.timestamp === null || (a.timestamp as number) < before - 1, "시계를 읽지 않는다");
});

test("★ 공식 필드가 없으면 approvalNumber 는 null 이다 ('복구' 를 만들지 않는다)", () => {
  const a = extractApproval({ paymentMethod: "CARD", card: {} }, SENT);
  assert.equal(a.approvalNumber, null);
});

test("★ 없는 조회 키의 이름이 missing 에 남는다", () => {
  const a = extractApproval({ paymentMethod: "CARD", card: {} }, SENT);
  assert.deepEqual(a.missing, ["card.timestamp", "card.approvalNumber", "response.tid"]);
});

test("응답이 null·문자열·숫자여도 죽지 않는다", () => {
  for (const v of [null, undefined, "", 0, [], true]) {
    const a = extractApproval(v as any, SENT);
    assert.equal(a.paymentKey, "pk_test_0001");
    assert.equal(a.timestamp, null);
    assert.equal(a.approvalNumber, null);
  }
});

console.log("\n─── 3. 값 해석 규칙 ───");

test("초 단위(10자리) 승인 시각은 밀리초로 올려 읽는다", () => {
  assert.equal(extractApproval({ card: { timestamp: 1756555555 } }, SENT).timestamp, MS);
});

test("숫자 문자열로 온 승인 시각도 읽는다", () => {
  assert.equal(extractApproval({ card: { timestamp: String(MS) } }, SENT).timestamp, MS);
});

test("상식 밖 시각(1990 이전·2100 이후)은 읽지 않는다", () => {
  assert.equal(extractApproval({ card: { timestamp: 0 } }, SENT).timestamp, null);
  assert.equal(extractApproval({ card: { timestamp: 99_999_999_999_999 } }, SENT).timestamp, null);
});

test("할부는 0 이상 정수만, 없으면 0", () => {
  assert.equal(extractApproval({ card: { installment: 3 } }, SENT).installment, 3);
  assert.equal(extractApproval({ card: {} }, SENT).installment, 0);
  assert.equal(extractApproval({ card: { installment: -1 } }, SENT).installment, 0);
  assert.equal(extractApproval({ card: { installment: 1.5 } }, SENT).installment, 0);
});

test("빈 문자열은 값이 아니라 없음이다", () => {
  const a = extractApproval({ tid: "   ", card: { approvalNumber: "" } }, SENT);
  assert.equal(a.tid, null);
  assert.equal(a.approvalNumber, null);
});

test("paymentMethod 는 응답 → 우리가 보낸 값 → CARD 순서로 정한다", () => {
  assert.equal(extractApproval({ paymentMethod: "CASH" }, SENT).paymentMethod, "CASH");
  assert.equal(
    extractApproval({}, { paymentKey: "pk", paymentMethod: "BARCODE" }).paymentMethod,
    "BARCODE",
  );
  assert.equal(extractApproval({}, SENT).paymentMethod, "CARD");
});

console.log("\n─── 4. 대체 이름은 공식 필드 **다음에만** 본다 ───");

test("공식 필드가 있으면 대체 이름을 보지 않는다", () => {
  const a = extractApproval(
    { card: { timestamp: MS, approvalNumber: "OFFICIAL", approveNo: "LEGACY" }, approvalNumber: "TOP" },
    SENT,
  );
  assert.equal(a.approvalNumber, "OFFICIAL");
  assert.equal(a.approvalNumberSource, "card.approvalNumber");
});

test("공식 필드가 없을 때만 대체 이름을 쓰고, 어디서 읽었는지 남긴다", () => {
  const a = extractApproval({ card: { approveNo: "LEGACY" } }, SENT);
  assert.equal(a.approvalNumber, "LEGACY");
  assert.equal(a.approvalNumberSource, "card.approveNo");
});

console.log("\n─── 5. ★ 로그에 카드번호가 새지 않는다 ───");

test("★ describeResponseShape 는 이름만 찍는다 (값은 한 개도 찍지 않는다)", () => {
  const s = describeResponseShape(OFFICIAL);
  assert.ok(s.includes("timestamp"), "필드 이름은 있어야 한다");
  assert.ok(!s.includes("1234-"), "★ 카드번호가 새면 안 된다");
  assert.ok(!s.includes("01234567"), "★ 승인번호 값도 여기 찍지 않는다");
  assert.ok(!s.includes(String(MS)));
});

test("describeResponseShape 는 card 가 없어도 죽지 않는다", () => {
  assert.ok(describeResponseShape({}).includes("(card 없음)"));
  assert.ok(describeResponseShape(null).includes("(card 없음)"));
});

console.log("\n─── 6. ★ [CANCEL-DIAG] ───");

const PAYLOAD = {
  paymentKey: "pk_test_0001",
  paymentMethod: "CARD",
  tax: 0,
  supplyValue: 1000,
  taxExemptValue: 0,
  tip: 0,
  timestamp: MS,
  approvalNumber: "01234567",
  installment: 0,
  tid: "A1234567",
};

function diag(over: Partial<Parameters<typeof formatCancelDiag>[0]> = {}) {
  return formatCancelDiag({
    cancelRequestId: "cx_0001",
    originalPaymentKey: "pk_test_0001",
    payload: PAYLOAD,
    terminal: null,
    van: "KSNET",
    vanTransactionKey: "vtk_9999",
    originalCreatedAt: "2026-08-30T03:05:55.000Z",
    rawStoredTimestamp: String(MS),
    ...over,
  });
}

test("★ 환불 요청 ID 가 paymentKey 자리에 들어가면 MISMATCH 로 드러난다", () => {
  // 이것이 이 블록의 존재 이유 중 하나다. 사진 한 장으로 판별돼야 한다.
  const bad = diag({ payload: { ...PAYLOAD, paymentKey: "cx_0001" } });
  assert.ok(bad.includes("★ MISMATCH"), "★ 취소 ID 를 paymentKey 로 보내면 드러나야 한다");
  assert.ok(!diag().includes("★ MISMATCH"), "정상일 때는 MISMATCH 가 없어야 한다");
});

test("요구된 항목이 모두 한 블록에 있다", () => {
  const s = diag();
  for (const k of [
    "[CANCEL-DIAG]",
    "cancelRequestId",
    "originalPaymentKey",
    "sdkCancelPaymentKey",
    "paymentMethod",
    "tax",
    "supplyValue",
    "taxExemptValue",
    "tip",
    "timestamp",
    "approvalNumber",
    "installment",
    "tid",
    "van",
    "vanTransactionKey",
    "originalCreatedAt",
    "terminalNow",
  ]) {
    assert.ok(s.includes(k), `${k} 가 빠졌다`);
  }
});

test("승인 시각의 자릿수를 같이 찍는다 (10자리/13자리를 눈으로 가른다)", () => {
  assert.ok(diag().includes("13자리"));
});

test("단말기 기록과 대조해 어느 키가 틀렸는지 가린다", () => {
  const s = diag({
    terminal: {
      timestamp: MS,
      approvalNumber: "99999999", // 여기만 다르다
      installment: 0,
      tid: "A1234567",
      vanTransactionKey: "vtk_9999",
    },
  });
  assert.ok(s.includes("★ MISMATCH"), "다른 값이 있으면 표시돼야 한다");
  assert.ok(s.includes("99999999"));
});

test("단말기가 모르면 '비교불가' 이지 MISMATCH 가 아니다", () => {
  const s = diag({
    terminal: { timestamp: null, approvalNumber: null, installment: 0, tid: null, vanTransactionKey: null },
  });
  assert.ok(s.includes("비교불가"));
});

test("tid 를 안 보낼 때도 그 사실이 드러난다", () => {
  const { tid, ...noTid } = PAYLOAD;
  assert.ok(diag({ payload: noTid }).includes("(보내지 않음)"));
});

test("★ 진단 블록에 카드번호가 없다", () => {
  assert.ok(!diag().includes("1234-"));
});

console.log("\n─── 7. ★ 플러그인 표식과 서버 거절 목록이 같은 문자열 ───");
//
// 두 값이 어긋나면 가짜 승인번호를 그대로 단말기에 보내게 된다. 파일이 둘로
// 나뉘어 있어 눈으로는 어긋난 것을 못 본다. 그래서 여기서 실제로 대조한다.

test("★ UNKNOWN_APPROVAL_NUMBER 를 서버가 거절 목록에 갖고 있다", () => {
  assert.ok(
    (UNRESOLVABLE_APPROVAL_NUMBERS as readonly string[]).includes(UNKNOWN_APPROVAL_NUMBER),
    `★ 플러그인 표식 "${UNKNOWN_APPROVAL_NUMBER}" 를 서버가 모른다 — 가짜 승인번호로 단말기를 부르게 된다`,
  );
});

test("★ 예전 표식 '복구'·'WEBHOOK' 도 계속 거절한다 (이미 저장된 행이 있다)", () => {
  const list = UNRESOLVABLE_APPROVAL_NUMBERS as readonly string[];
  assert.ok(list.includes("복구"), "★ 0.3.18 까지 저장된 행의 값이다");
  assert.ok(list.includes("WEBHOOK"));
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
