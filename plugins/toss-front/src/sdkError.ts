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
