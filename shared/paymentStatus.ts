/**
 * 한 달치 납부 상태 판정 (순수 함수, 클라이언트·서버 공용).
 *
 * 왜 생겼나 (2026-08-29 원장 지적):
 *   수납 화면은 "그 달에 순액 > 0 이면 납부 완료"로 판정하고 있었다. 그래서
 *   27만원짜리 수강료에 269,000원만 낸 달이 완납으로 잡혔다. 1,000원이 남았는데
 *   화면에는 초록색 "납부완료"가 뜬다. 반대로 한 푼도 안 내면 미납으로 잡히니,
 *   원장 눈에는 "다 냈다" 아니면 "안 냈다" 둘뿐이고 중간이 사라진다.
 *
 *   실제 현장은 중간이 흔하다. 고건 학생의 경우:
 *     2026-08  270,000원 중 269,000원 납부 →   1,000원 남음
 *     2026-09  270,000원 중   1,000원 납부 → 269,000원 남음
 *   이걸 "완납"으로 보여 주면 남은 돈을 영영 못 받는다.
 *
 * 부호 규칙:
 *   payments.amount 는 원비 양수, 환불·지출 음수다. 그대로 SUM 하면 순액이 되고
 *   "35만 수납 + 35만 환불 = 0원" 같은 경우가 자연히 미납으로 돌아온다.
 *
 * 서버의 toss-front/invoicesHelper.ts 와 같은 판정을 한다. 두 곳이 다르면
 * 태블릿과 원장 화면이 서로 다른 말을 하게 되므로 규칙을 여기 한 벌만 둔다.
 */

export type MonthPaymentStatus = "미납" | "부분납" | "완납";

export interface MonthPayment {
  /** YYYY-MM */
  month: string;
  /** 이 달의 청구액 (분모). "27만원 중 1천원"을 그리려면 분모가 필요하다. */
  tuition: number;
  /** 이 달에 실제로 들어온 순액. 환불이 상계된 값이라 음수가 될 수도 있다. */
  paid: number;
  /** 아직 받아야 할 돈. 초과 납부를 음수로 흘리지 않도록 0 에서 자른다. */
  remaining: number;
  status: MonthPaymentStatus;
}

/**
 * 한 달치 상태를 만든다.
 *
 * tuition 이 0 이하인 경우(수강료 미설정 등)는 청구할 게 없으므로 완납으로 본다.
 * 그렇게 하지 않으면 수강료를 안 적어 둔 반이 전부 미납으로 뜬다.
 */
export function computeMonthStatus(month: string, tuition: number, paid: number): MonthPayment {
  // paid 를 0 에서 한 번 자르고 뺀다. 그래서 남은 금액이 그 달 수강료를 절대 넘지 않는다.
  //
  // 왜 자르나: 환불이 원비보다 큰 달이 생길 수 있다. 8월에 낸 돈을 9월에 환불하면
  // (payment_month 를 9월로 적은 경우) 9월 순액이 음수가 된다. 자르지 않으면
  // 27만원짜리 달에 "32만원 남음"이 뜬다. 원장이 화면을 못 믿게 되는 종류의 숫자다.
  // 넘친 환불액은 그 달에 매달지 않고 결제 내역 원본에 남겨 둔다.
  const effectivePaid = Math.max(0, paid);
  const remaining = Math.max(0, tuition - effectivePaid);

  let status: MonthPaymentStatus;
  if (tuition <= 0 || remaining <= 0) {
    status = "완납";
  } else if (paid > 0) {
    status = "부분납";
  } else {
    // paid 가 0 이거나, 환불이 더 커서 음수인 경우도 미납이다.
    status = "미납";
  }

  return { month, tuition, paid, remaining, status };
}

/** 아직 돈을 더 받아야 하는 달인가. 미납과 부분납이 모두 해당한다. */
export function isOutstanding(m: MonthPayment): boolean {
  return m.remaining > 0;
}

/**
 * 남은 금액의 합계.
 *
 * 예전에는 "미납 개월 수 × 수강료"로 총액을 냈다. 부분납이 생기면 그 방식은
 * 이미 받은 269,000원까지 미납으로 세어 총액을 크게 부풀린다.
 */
export function totalOutstanding(months: MonthPayment[]): number {
  return months.reduce((sum, m) => sum + m.remaining, 0);
}
