/**
 * requestPaymentCancel 에 넘길 값을 SDK 가 요구하는 타입으로 맞춘다.
 *
 * ══ 왜 이 파일이 생겼나 (2026-08-31) ══
 *
 *   원장님이 0.3.17 을 올리고 취소를 진행했더니 단말기가 이렇게 던졌다:
 *
 *     TossFrontSDKError: 원거래 없음
 *       at Function.value (cdn.tossplace.com/toss-front-sdk/v0/index.js:1:16961)
 *
 *   전날 고친 것은 **형식**이었다. ISO 문자열("2026-08-30T…")을 보내던 것을
 *   밀리초로 바꿨다. 그런데 여전히 원거래를 못 찾았다.
 *
 *   공식 문서(docs.tossplace.com · Front SDK · payment)를 직접 확인하니
 *   파라미터 표에 이렇게 적혀 있었다:
 *
 *     timestamp | number | 필수 | 원본 결제의 승인 시간     예) 1723628943812
 *
 *   **number 다.** 우리는 "1756555555000" 이라는 **문자열**을 보내고 있었다.
 *   값은 맞고 타입이 틀렸다. 조회 키가 타입까지 같아야 맞는 것이라면
 *   문자열은 영원히 어떤 거래와도 일치하지 않는다.
 *
 *   왜 컴파일러가 안 잡았나: sdk.ts 의 우리 선언이 `timestamp: string` 이었다.
 *   **우리가 직접 쓴 틀린 선언이 우리를 지켜 주지 못했다.** 이 저장소에서
 *   같은 일이 세 번째다 — renderIdlePage 를 인자 없는 함수로 잘못 선언해
 *   대기화면 기능을 통째로 없앴고, requestPaymentCancel 선언이 아예 없어서
 *   "Front SDK 로는 취소가 불가능하다"고 잘못 결론 냈었다.
 *   타입 선언은 사실이 아니라 **주장**이다. 문서와 대조해야 사실이 된다.
 */

/**
 * 저장된 승인 시각을 SDK 가 받는 밀리초 **숫자**로 바꾼다.
 *
 * 서버가 이미 밀리초 문자열로 정규화해서 내려보내지만(cardCancel.normalizeApprovedTimestamp),
 * 여기서 한 번 더 확인한다. 이 값이 틀리면 조용히 "원거래 없음" 이 되기 때문에,
 * 틀린 채로 SDK 를 부르느니 부르지 않는 편이 낫다.
 *
 * 판단하지 못하면 null 을 준다. 호출부는 null 이면 SDK 를 부르지 않는다 —
 * 카드를 건드리지 않은 것이 확실해야 재시도를 허용할 수 있다.
 */
export function toEpochMillis(raw: unknown): number | null {
  let ms: number;
  if (typeof raw === "number") {
    ms = raw;
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (s === "" || !/^\d+$/.test(s)) return null; // 소수점·부호·ISO 문자열은 여기서 걸린다
    ms = Number(s);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(ms)) return null;
  // 1990-01-01 ~ 2100-01-01. 초 단위(10자리)를 밀리초로 착각해 보내는 것을 막는다.
  if (ms < 631_152_000_000 || ms > 4_102_444_800_000) return null;
  return ms;
}
