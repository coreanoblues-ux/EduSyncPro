/**
 * 카드 할부 정책 (순수 함수, 클라이언트·서버 공용).
 *
 * ── 값의 의미 ──
 *   0  = 일시불. Toss Front SDK 의 `installment` 기본값도 0 이다.
 *   2+ = 할부 개월수.
 *   1 은 쓰지 않는다. "1개월 할부" 라는 상품이 없기 때문이고, SDK 문서에도
 *   그런 값이 정의돼 있지 않다. 일시불은 반드시 0 으로 보낸다.
 *
 * ── 5만원 기준은 어디서 왔나 ──
 *   Toss Front SDK 문서에는 최소 금액 규정이 **없다**. 이건 토스의 규칙이 아니라
 *   국내 카드업계 관행이다(할부는 통상 5만원 이상부터 취급). 그래서 여기서
 *   막는 것은 "SDK 가 거부해서" 가 아니라 "카드사에서 어차피 거절되는 선택지를
 *   학부모에게 보여 주지 않기 위해서" 다. 이 구분을 적어 두는 이유는, 나중에
 *   누군가 "SDK 제약" 으로 오해하고 다른 곳에서도 같은 검사를 중복해 넣거나
 *   반대로 지워 버리는 일을 막기 위함이다.
 *
 * ── 개월수 후보는 왜 문서로 검증할 수 없나 ──
 *   공식 문서(docs.tossplace.com/reference/plugin-sdk/front/payment.html)는
 *   `installment: number — 할부 개월` 이라고만 적혀 있고 허용 목록이 없다.
 *   실제로 받아 주는 개월수는 카드사·VAN 이 정한다. 그래서 아래 목록은
 *   "화면에 보여 줄 후보" 이지 "반드시 승인되는 값" 이 아니다.
 *
 *   이래서 요청값과 승인값을 반드시 따로 저장한다:
 *     요청 → payment_intents.requested_installment
 *     승인 → toss_payment_transactions.installment  (단말기가 돌려준 실제 값)
 *   6개월로 요청했는데 3개월로 승인돼도 장부는 3개월을 적고, 취소도 3개월로 건다.
 *
 * ── 금지어 ──
 *   "무이자" 라는 말을 어디에도 쓰지 않는다. 무이자 여부는 카드사 프로모션이고
 *   우리는 알 방법이 없다. 화면에 그렇게 적었다가 학부모에게 이자가 청구되면
 *   그건 학원이 거짓말을 한 것이 된다.
 */

/** 할부를 고를 수 있는 최소 결제금액 (원). 카드업계 관행값. */
export const INSTALLMENT_MIN_AMOUNT = 50_000;

/** 일시불. SDK 에 그대로 넘어가는 값이다. */
export const LUMP_SUM = 0;

/**
 * 화면에 띄울 할부 개월 후보 (일시불 제외).
 *
 * 원장 요청 그대로다. 12를 넣고 7~11을 뺀 건 학원 수강료 규모에서 실제로
 * 쓰이는 구간이 짧은 할부와 1년뿐이기 때문이고, 선택지가 길어지면 태블릿에서
 * 학부모가 잘못 누른다.
 */
export const INSTALLMENT_OPTIONS = [2, 3, 4, 5, 6, 12] as const;

/** 이 금액에서 할부를 고를 수 있는가. */
export function canChooseInstallment(amount: number): boolean {
  return Number.isFinite(amount) && amount >= INSTALLMENT_MIN_AMOUNT;
}

/**
 * 요청받은 할부 개월을 실제로 보낼 값으로 정규화한다.
 *
 * 화면에서 이미 막고 있어도 서버가 다시 부른다. 태블릿이 보낸 값을 그대로 믿으면
 * 5만원 미만인데 6개월이 단말기까지 흘러가 카드사에서 거절되고, 학부모는
 * 카드를 댄 채로 영문 모를 실패를 본다. 판정을 한 벌만 두는 이유다.
 *
 * 아래 어느 경우든 조용히 0(일시불)으로 떨어진다 — 결제 자체를 막지는 않는다.
 * 할부는 편의 기능이고, 이것 때문에 수납이 실패하면 안 된다.
 */
export function normalizeInstallment(
  requested: number | null | undefined,
  amount: number
): number {
  if (requested === null || requested === undefined) return LUMP_SUM;
  if (!Number.isInteger(requested) || requested <= 1) return LUMP_SUM;
  if (!canChooseInstallment(amount)) return LUMP_SUM;
  if (!(INSTALLMENT_OPTIONS as readonly number[]).includes(requested)) return LUMP_SUM;
  return requested;
}

/**
 * 사람이 읽을 표기.
 *
 * "3개월 할부" 까지만 쓴다. 월 납입액을 계산해서 보여 주지 않는다 — 수수료·이자가
 * 카드사마다 달라서 우리가 낸 숫자는 실제 청구서와 반드시 어긋난다.
 */
export function installmentLabel(installment: number | null | undefined): string {
  const n = installment ?? 0;
  return n >= 2 ? `${n}개월 할부` : "일시불";
}
