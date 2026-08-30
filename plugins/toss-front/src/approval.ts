/**
 * 카드 승인 응답에서 **원거래 조회 키**를 꺼낸다.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  왜 이 파일이 생겼나 — "원거래 없음" 의 진짜 원인 (2026-08-31)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  0.3.17 에서 timestamp 형식(ISO→밀리초)을 고쳤다. 또 났다.
 *  0.3.18 에서 timestamp 타입(string→number)을 고쳤다. 또 났다.
 *  둘 다 **형식**을 고친 것이었다. 틀린 것은 형식이 아니라 **값** 이었다.
 *
 *  공식 문서의 CARD 승인 성공 응답은 이렇게 생겼다:
 *
 *      result.response.paymentMethod
 *      result.response.tid
 *      result.response.vanTransactionKey
 *      result.response.card.timestamp        ← 승인 시각
 *      result.response.card.approvalNumber   ← 승인번호
 *      result.response.card.installment
 *      result.response.card.van
 *      result.response.card.shopCode
 *
 *  그런데 우리 코드는 이렇게 읽고 있었다 (index.ts confirmPaymentFromSdk):
 *
 *      approvalNumber:    r.approvalNumber ?? r.card?.approveNo ?? "복구"
 *      approvedTimestamp: r.approvedAt || new Date().toISOString()
 *      installment:       r.card?.installmentMonths ?? 0
 *      van:               r.van
 *
 *  `r.approvalNumber` · `r.card.approveNo` · `r.approvedAt` ·
 *  `r.card.installmentMonths` · `r.van` — **다섯 개 전부 존재하지 않는 필드다.**
 *  우리가 sdk.ts 에 직접 써 넣은 타입 선언이 그렇게 생겼을 뿐이다.
 *
 *  그래서 실제로 저장된 값은 이랬다:
 *
 *      approvalNumber    = "복구"                    (승인번호가 아니다)
 *      approvedTimestamp = 승인 시각이 아니라 **서버로 보내던 순간의 우리 시계**
 *      installment       = 0
 *
 *  취소는 이 두 값을 조회 키로 단말기에 보낸다. 단말기 입장에서는
 *  "승인번호 '복구', 승인시각 (그 결제와 무관한 시각)" 인 거래를 찾으라는 요청이다.
 *  그런 거래는 없다. **원거래 없음.** 몇 번을 다시 눌러도 결과는 같다.
 *
 *  카드 결제 자체는 멀쩡히 돌아갔다. 금액·paymentKey·주문번호는 서버가 확정한
 *  값으로 채워 넣고 있었기 때문이다(0.3.13). 그때 "응답에 없는 필드가 있다" 는
 *  사실까지는 알아냈는데, 세 개만 서버 값으로 메우고 나머지 두 개는 가짜
 *  기본값으로 덮어 버렸다. 장부는 맞았고, 취소만 조용히 불가능해졌다.
 *
 * ══════════════════════════════════════════════════════════════════════
 *  이 파일의 규칙
 * ══════════════════════════════════════════════════════════════════════
 *
 *  1. **없는 값을 만들어 내지 않는다.** 승인 시각을 모르면 null 이다.
 *     `new Date()` 는 이 파일에 등장하지 않는다. 그것이 이번 사고의 전부였다.
 *
 *  2. **공식 필드를 먼저 본다.** 대체 이름들은 그 다음에만 본다.
 *     펌웨어마다 다를 수 있다는 가정은 유지하되, 순서를 문서가 정한다.
 *
 *  3. **숫자로 바꾸지 않는다 (승인번호).** 승인번호는 앞자리 0 이 의미를 갖는
 *     문자열이다. Number() 를 한 번 통과하면 "012345" 가 "12345" 가 되고,
 *     그 순간 다시 "원거래 없음" 이다.
 *
 *  4. 판단은 전부 여기 있다. 시험할 수 있는 자리에 두기 위해서다.
 */

/**
 * 승인번호를 끝내 못 읽었을 때 서버로 보내는 표식.
 *
 * 서버 confirm 은 approvalNumber 를 필수(min 1)로 요구한다. 여기서 빈 값을 보내면
 * 400 이 나고, 그러면 **카드에서 나간 돈이 장부에 안 들어간다.** 그건 이 프로젝트가
 * 가장 피하려는 사고다. 그래서 장부에는 들어가되, 이 값이 조회 키로 쓰이는 일은
 * 없도록 서버가 이 표식을 보고 카드 취소를 거절한다.
 *
 * ⚠️ server/toss-front/cardCancel.ts 의 UNRESOLVABLE_APPROVAL_NUMBERS 와 **같은
 *    문자열이어야 한다.** 두 값이 어긋나면 가짜 승인번호로 단말기를 부르게 된다.
 *    scripts/test-approval.ts 가 두 파일의 값이 같은지 실제로 대조한다.
 */
export const UNKNOWN_APPROVAL_NUMBER = "UNKNOWN";

export interface OriginalApproval {
  /** 우리가 requestPayment 에 넘겼던 바로 그 paymentKey. 응답에서 새로 얻지 않는다. */
  paymentKey: string;
  paymentMethod: "CARD" | "CASH" | "BARCODE";
  /** card.timestamp. 원거래 조회 키. 모르면 null — 절대 지금 시각으로 채우지 않는다. */
  timestamp: number | null;
  /** card.approvalNumber. 문자열 그대로. 모르면 null. */
  approvalNumber: string | null;
  /** card.installment. 원 승인의 할부 개월. */
  installment: number;
  tid: string | null;
  vanTransactionKey: string | null;
  van: string | null;
  shopCode: string | null;
  /** 표시·감사용. 조회 키가 아니다. */
  maskedCardNumber: string | null;
  issuerName: string | null;
  acquirerName: string | null;
  cardType: string | null;
  /** 어느 필드에서 timestamp 를 읽었는지. 진단 로그용. */
  timestampSource: string | null;
  /** 어느 필드에서 approvalNumber 를 읽었는지. 진단 로그용. */
  approvalNumberSource: string | null;
  /** 취소에 반드시 필요한데 응답에 없었던 것들. 로그로 남긴다. */
  missing: string[];
}

/** 문자열로 쓸 수 있는 값만 문자열로. 숫자 변환은 하지 않는다 (앞자리 0 보존). */
function readString(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? null : s;
  }
  // 펌웨어가 숫자로 줄 수도 있다. 그 경우 앞자리 0 은 JSON 단계에서 이미 사라졌다.
  // 우리가 더 잃지 않도록 그대로 옮겨 적기만 한다.
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * 승인 시각 후보를 epoch 밀리초로 읽는다.
 *
 * 숫자(또는 숫자 문자열)만 받는다. 초 단위 10자리는 밀리초로 올린다.
 * 날짜 문자열은 여기서 받지 않는다 — 시간대가 빠진 문자열을 파싱하면 9시간이
 * 밀리고, 그 값은 "그럴듯하지만 틀린 조회 키" 가 된다. 틀린 키보다 없는 키가 낫다.
 */
function readEpochMillis(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") {
    n = v;
  } else if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || !/^\d+$/.test(s)) return null;
    n = Number(s);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  // 10자리는 초 단위다. 1990-01-01 ~ 2100-01-01 범위 밖은 받지 않는다.
  if (n < 100_000_000_000) n = n * 1000;
  if (n < 631_152_000_000 || n > 4_102_444_800_000) return null;
  return n;
}

/** 0 이상의 정수만. 그 밖에는 0 (할부 없음). */
function readInstallment(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** 후보를 순서대로 보고, 처음으로 읽히는 값과 그 출처 이름을 돌려준다. */
function pick<T>(
  candidates: Array<[string, unknown]>,
  read: (v: unknown) => T | null,
): { value: T | null; source: string | null } {
  for (const [name, raw] of candidates) {
    const value = read(raw);
    if (value !== null) return { value, source: name };
  }
  return { value: null, source: null };
}

/**
 * 승인 응답(또는 getPayment 응답)에서 원거래 조회 키를 꺼낸다.
 *
 * @param response  result.response 그대로.
 * @param sent      우리가 SDK 에 **넘겼던** 값. paymentKey 는 반드시 이쪽이 원본이다 —
 *                  응답에서 다시 얻으려 하면 안 된다 (응답에는 없다).
 */
export function extractApproval(
  response: unknown,
  sent: { paymentKey: string; paymentMethod?: "CARD" | "CASH" | "BARCODE" },
): OriginalApproval {
  const r = (response ?? {}) as Record<string, any>;
  const card = (r.card ?? {}) as Record<string, any>;

  // 공식 필드가 먼저다. 뒤의 이름들은 펌웨어 차이를 위한 대비일 뿐이다.
  const ts = pick(
    [
      ["card.timestamp", card.timestamp],
      ["response.timestamp", r.timestamp],
      ["card.approvedTimestamp", card.approvedTimestamp],
      ["response.approvedTimestamp", r.approvedTimestamp],
    ],
    readEpochMillis,
  );

  const approval = pick(
    [
      ["card.approvalNumber", card.approvalNumber],
      ["response.approvalNumber", r.approvalNumber],
      ["card.approveNo", card.approveNo],
      ["card.approvalNo", card.approvalNo],
    ],
    readString,
  );

  const installment = pick(
    [
      ["card.installment", card.installment],
      ["response.installment", r.installment],
      ["card.installmentMonths", card.installmentMonths],
    ],
    readInstallment,
  );

  const tid = pick(
    [
      ["response.tid", r.tid],
      ["card.tid", card.tid],
    ],
    readString,
  );

  const vanTransactionKey = pick(
    [
      ["response.vanTransactionKey", r.vanTransactionKey],
      ["card.vanTransactionKey", card.vanTransactionKey],
    ],
    readString,
  );

  const van = pick(
    [
      ["card.van", card.van],
      ["response.van", r.van],
    ],
    readString,
  );

  const shopCode = pick(
    [
      ["card.shopCode", card.shopCode],
      ["response.shopCode", r.shopCode],
    ],
    readString,
  );

  // 취소를 걸려면 반드시 있어야 하는 것들. 없으면 이름을 남겨 둔다 —
  // 나중에 "왜 이 결제만 취소가 안 되나" 를 로그 한 줄로 알 수 있어야 한다.
  const missing: string[] = [];
  if (ts.value === null) missing.push("card.timestamp");
  if (approval.value === null) missing.push("card.approvalNumber");
  if (tid.value === null) missing.push("response.tid");

  return {
    paymentKey: sent.paymentKey,
    paymentMethod:
      (readString(r.paymentMethod) as "CARD" | "CASH" | "BARCODE" | null) ??
      sent.paymentMethod ??
      "CARD",
    timestamp: ts.value,
    approvalNumber: approval.value,
    installment: installment.value ?? 0,
    tid: tid.value,
    vanTransactionKey: vanTransactionKey.value,
    van: van.value,
    shopCode: shopCode.value,
    maskedCardNumber: readString(card.number),
    issuerName: readString(card.issuerName),
    acquirerName: readString(card.acquirerName),
    cardType: readString(card.cardType),
    timestampSource: ts.source,
    approvalNumberSource: approval.source,
    missing,
  };
}

/**
 * 승인 응답에 어떤 키들이 실제로 들어 있었는지 (값이 아니라 **이름만**).
 *
 * 값은 찍지 않는다 — 카드번호가 섞일 수 있다. 이름만 있어도 다음에 같은 일이
 * 났을 때 "우리가 읽으려던 필드가 응답에 있기는 했나" 를 즉시 알 수 있다.
 * 이번 사고에서 우리에게 없었던 것이 정확히 이 한 줄이다.
 */
export function describeResponseShape(response: unknown): string {
  const r = (response ?? {}) as Record<string, any>;
  const top = Object.keys(r).join(",");
  const card = r.card && typeof r.card === "object" ? Object.keys(r.card).join(",") : "(card 없음)";
  return `response=[${top}] card=[${card}]`;
}

// ═══════════════════════════════════════════════════════════════════════
//  취소 직전 진단 ([CANCEL-DIAG])
// ═══════════════════════════════════════════════════════════════════════

/** 취소 직전에 실제로 SDK 에 넘길 값들. 로그와 호출이 같은 객체를 본다. */
export interface CancelPayloadView {
  paymentKey: string;
  paymentMethod: string;
  tax: number;
  supplyValue: number;
  taxExemptValue: number;
  tip: number;
  timestamp: number;
  approvalNumber: string;
  installment: number;
  tid?: string;
}

/**
 * 단말기가 자기 기록으로 알고 있는 값 (getPayment 결과). 없으면 null.
 * **진단용이다.** 이 값으로 취소를 대신 수행하지 않는다.
 */
export interface TerminalKnownView {
  timestamp: number | null;
  approvalNumber: string | null;
  installment: number;
  tid: string | null;
  vanTransactionKey: string | null;
}

function matchLine(label: string, mine: unknown, theirs: unknown): string {
  const a = mine === null || mine === undefined || mine === "" ? "(없음)" : String(mine);
  const b = theirs === null || theirs === undefined || theirs === "" ? "(없음)" : String(theirs);
  if (b === "(없음)") return `  ${label}: ${a} / 단말기=(모름) → 비교불가`;
  return `  ${label}: ${a} / 단말기=${b} → ${a === b ? "MATCH" : "★ MISMATCH"}`;
}

/**
 * 취소 SDK 호출 **직전에** 한 번 찍는 진단 블록.
 *
 * 왜 한 덩어리로 찍나: 단말기 로그는 원장님이 사진으로 찍어서 보낸다. 값이 여러
 * 줄에 흩어져 있으면 한 장에 다 안 들어오고, 그러면 우리는 또 추측을 시작한다.
 *
 * 민감정보 규칙: 카드번호(마스킹 포함)·토큰은 넣지 않는다. 조회 키만 넣는다.
 */
export function formatCancelDiag(input: {
  cancelRequestId: string;
  originalPaymentKey: string;
  payload: CancelPayloadView;
  terminal: TerminalKnownView | null;
  van: string | null;
  vanTransactionKey: string | null;
  originalCreatedAt: string | null;
  rawStoredTimestamp: string;
}): string {
  const p = input.payload;
  const digits = String(p.timestamp).length;
  const lines = [
    "[CANCEL-DIAG]",
    `  cancelRequestId    = ${input.cancelRequestId}`,
    `  originalPaymentKey = ${input.originalPaymentKey}`,
    `  sdkCancelPaymentKey= ${p.paymentKey}`,
    // 이 한 줄이 "환불 요청 ID 를 paymentKey 자리에 넣었나" 를 즉시 가른다.
    `  paymentKey 일치     = ${input.originalPaymentKey === p.paymentKey ? "MATCH" : "★ MISMATCH"}`,
    `  paymentMethod      = ${p.paymentMethod}`,
    `  tax                = ${p.tax}`,
    `  supplyValue        = ${p.supplyValue}`,
    `  taxExemptValue     = ${p.taxExemptValue}`,
    `  tip                = ${p.tip}`,
    `  timestamp          = ${p.timestamp} (${digits}자리, 저장원문="${input.rawStoredTimestamp}")`,
    `  approvalNumber     = ${p.approvalNumber}`,
    `  installment        = ${p.installment}`,
    `  tid                = ${p.tid ?? "(보내지 않음)"}`,
    `  van                = ${input.van ?? "(없음)"}`,
    `  vanTransactionKey  = ${input.vanTransactionKey ?? "(없음)"}`,
    `  originalCreatedAt  = ${input.originalCreatedAt ?? "(없음)"}`,
    `  terminalNow        = ${new Date().toISOString()}`,
  ];

  if (input.terminal) {
    lines.push("  ── 단말기 기록과 대조 (getPayment · 진단 전용) ──");
    lines.push(matchLine("timestamp     ", p.timestamp, input.terminal.timestamp));
    lines.push(matchLine("approvalNumber", p.approvalNumber, input.terminal.approvalNumber));
    lines.push(matchLine("installment   ", p.installment, input.terminal.installment));
    lines.push(matchLine("tid           ", p.tid ?? null, input.terminal.tid));
  } else {
    lines.push("  ── 단말기 기록 없음 (getPayment 미지원·캐시 없음) → 대조 불가 ──");
  }
  return lines.join("\n");
}
