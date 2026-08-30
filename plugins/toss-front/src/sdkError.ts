/**
 * SDK 오류에서 "무슨 일이 났는지" 를 읽어 내는 규칙.
 *
 * ── 왜 별도 파일인가 ──
 *   index.ts 안에 있을 때 이 규칙이 조용히 틀린 채로 몇 주를 갔다. 파일이 크고
 *   부작용투성이라 테스트에서 불러올 수가 없었기 때문이다. 판단하는 코드는
 *   판단만 하는 자리에 있어야 시험할 수 있다.
 *
 * ── 여기서 틀리면 무슨 일이 나나 ──
 *   이 판단은 "이 결제는 승인된 적이 없다" 를 서버에 보고할지 말지를 정한다.
 *     · 너무 좁으면 → 결론을 못 내고 매 폴링(1초)마다 같은 걸 다시 묻는다.
 *                     로그가 덮여 정작 봐야 할 사고 기록이 파묻힌다.
 *     · 너무 넓으면 → 네트워크 오류를 "승인 없음" 으로 오인해 멀쩡한 결제에
 *                     표식을 찍는다. 이쪽이 훨씬 나쁘다.
 *   그래서 정확한 토큰이 있을 때만 참이라고 답한다.
 */

/** 단말기에 그 승인 기록이 없을 때 SDK 가 쓰는 코드. */
export const PAYMENT_NOT_FOUND = "PAYMENT_NOT_FOUND";

/**
 * 오류 객체에서 코드로 쓸 만한 문자열 후보를 전부 꺼낸다.
 *
 * ⚠️ 예전 구현은 `err.code ?? err.errorCode ?? err.type ?? err.name` 이었다.
 *    현장 단말기가 던지는 것은 **name 이 "TossFrontSDKError" 이고 진짜 코드는
 *    message 에 들어 있는** 오류다. name 이 먼저 잡히는 바람에 코드가 늘
 *    "TossFrontSDKError" 로 나왔고, PAYMENT_NOT_FOUND 판정이 한 번도 참이 된 적이
 *    없었다. 2026-08-30 에 단말기 로그를 읽다가 발견했다.
 *
 *    교훈은 ?? 사슬이 아니라 **후보를 다 모아서 본다** 는 것이다. 펌웨어마다
 *    어디에 코드를 넣는지 다르고, 우리는 그 순서를 미리 알 수 없다.
 */
export function errCodeCandidates(err: any): string[] {
  if (err == null) return [];
  if (typeof err === "string") {
    const s = err.trim();
    return s === "" ? [] : [s];
  }
  const out: string[] = [];
  for (const v of [err.code, err.errorCode, err.type, err.name, err.message]) {
    if (typeof v === "string" && v.trim() !== "") out.push(v.trim());
  }
  return out;
}

/**
 * 감사 기록에 남길 대표 코드 하나.
 * 아는 코드가 후보에 있으면 그것을 우선한다 — 그래야 서버 기록이 읽을 만해진다.
 */
export function errCode(err: any): string | null {
  const cands = errCodeCandidates(err);
  if (cands.length === 0) return null;
  return cands.find((c) => c === PAYMENT_NOT_FOUND) ?? cands[0];
}

/**
 * 이 오류가 "이 단말기에 그 승인 기록이 없다" 를 뜻하는가.
 *
 * 단어 경계로 본다. "not found" 같은 느슨한 부분일치로 넓히지 않는다 —
 * 네트워크 오류 문구에도 흔히 들어가는 말이라, 넓히는 순간 멀쩡한 결제에
 * "승인 없음" 을 찍게 된다.
 */
export function isPaymentNotFound(err: any): boolean {
  const re = new RegExp(`\\b${PAYMENT_NOT_FOUND}\\b`);
  return errCodeCandidates(err).some((c) => c === PAYMENT_NOT_FOUND || re.test(c));
}

/* ───────────────────────── 취소 실패 진단 ─────────────────────────
 *
 * 카드 취소가 실패했을 때 단말기에서 서버로 넘어가는 정보는 실질적으로
 * failure_reason **한 줄뿐이다.** raw_response_json 컬럼은 있었지만 단말기가
 * 아무것도 보내지 않아 늘 null 이었다.
 *
 * 그 한 줄마저 이렇게 만들어지고 있었다:
 *
 *   result.message ?? result.reason ?? result.code ?? "사유를 알리지 않았습니다"
 *
 * 또 ?? 사슬이다. FAILED 가 { code: "...", message: "취소 실패" } 로 오면
 * 쓸모없는 message 가 먼저 잡히고 **정작 필요한 code 는 버려진다.**
 * errCode 에서 고친 것과 같은 실수를, 하필 진단 정보를 만드는 자리에서
 * 한 번 더 하고 있었다.
 *
 * 이게 왜 급한가: 원장님께는 시험용 1,000원 결제가 **하나뿐이다.** 그 한 번의
 * 취소가 실패했을 때 "사유를 알리지 않았습니다" 만 남으면 다음에 무엇을 고쳐야
 * 할지 알 수 없고, 시험할 결제도 더 없다. 한 번의 실패에서 최대한 건져야 한다.
 */

/** 서버 cancelResultSchema 의 reason 제한. 넘기면 400 → 단말기가 영원히 재전송한다. */
export const MAX_REASON_LEN = 300;

/**
 * 실패 결과에서 사람이 읽을 진단 한 줄을 만든다.
 * 하나를 고르지 않고 **있는 것을 전부 붙인다.** 무엇이 결정적 단서인지
 * 지금은 알 수 없기 때문이다.
 */
export function describeFailure(result: any): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const key of ["code", "errorCode", "message", "reason"] as const) {
    const v = result?.[key];
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s === "" || seen.has(s)) continue;   // 같은 문자열이 code 와 message 에 겹쳐 오는 펌웨어가 있다
    seen.add(s);
    parts.push(`${key}=${s}`);
  }
  if (parts.length === 0) return "단말기가 사유를 알리지 않았습니다.";
  return parts.join(" | ").slice(0, MAX_REASON_LEN);
}

/**
 * 감사 기록으로 보낼 응답 요약.
 *
 * ⚠️ **허용목록으로만 고른다.** 금지목록이 아니다.
 *    PaymentResponseSuccess 에는 `card.number`(마스킹됐다지만 카드번호 자리다) 와
 *    무엇이 들었는지 알 수 없는 `raw?: any` 가 있다. 통째로 보내면 그게 그대로
 *    우리 DB 에 박힌다. 그래서 "아는 안전한 것만" 통과시킨다. 새 펌웨어가 필드를
 *    늘려도 이 목록에 없으면 자동으로 걸러진다 — 안전한 쪽으로 틀리게 만든다.
 */
const SAFE_KEYS = [
  "type", "code", "errorCode", "message", "reason",
  "paymentKey", "orderId", "amount", "paymentMethod",
  "approvalNumber", "approvedAt", "tid", "van", "vanTransactionKey",
] as const;
const SAFE_CARD_KEYS = ["issuerName", "acquirerName", "cardType", "installmentMonths"] as const;

export function safeRawSummary(result: any): Record<string, unknown> | null {
  if (result == null || typeof result !== "object") return null;
  const out: Record<string, unknown> = {};
  const take = (src: any, keys: readonly string[], into: Record<string, unknown>) => {
    for (const k of keys) {
      const v = src?.[k];
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") into[k] = v;
    }
  };
  take(result, SAFE_KEYS, out);
  const resp = result.response;
  if (resp && typeof resp === "object") {
    const r: Record<string, unknown> = {};
    take(resp, SAFE_KEYS, r);
    if (resp.card && typeof resp.card === "object") {
      const c: Record<string, unknown> = {};
      take(resp.card, SAFE_CARD_KEYS, c);   // card.number 는 목록에 없다. 의도적이다.
      if (Object.keys(c).length > 0) r.card = c;
    }
    if (Object.keys(r).length > 0) out.response = r;
  }
  return Object.keys(out).length > 0 ? out : null;
}
