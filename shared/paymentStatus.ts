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
 * 부분납 판정을 적용하기 시작하는 달 (YYYY-MM, 이 달 포함).
 *
 * 왜 경계가 필요한가 (2026-08-29, 김예진 학생 사고):
 *   부분납 판정을 넣자마자 결제 시도조차 없던 학생들의 과거 기록이 전부
 *   부분납으로 뒤집혔다. 김예진 학생은 2025-09 ~ 2026-02 모든 달이
 *   "부분납 · 280,000 납부 · 20,000 남음"으로 떴다.
 *
 *   원인은 판정식이 아니라 데이터다. enrollments.tuition 은 "지금 가격" 한 개만
 *   저장한다. 그 달에 실제로 얼마를 청구했는지는 어디에도 남아 있지 않다.
 *   김예진 학생은 등록상 300,000원인데 실제로는 매달 280,000원을 낸다
 *   (인상 전 가격이거나 할인). 과거를 현재 가격으로 심판하면 원비를 올린 학생,
 *   할인을 주는 학생이 전부 한꺼번에 체납자가 된다.
 *
 *   과거 달의 실제 청구액을 복원할 방법이 없으므로 추측하지 않는다. 대신
 *   경계 이전 달은 예전 규칙(순액이 양수면 완납)을 그대로 쓴다. 경계 이후로는
 *   결제 시점부터 청구액과 납부액이 함께 기록되므로 부분납을 신뢰할 수 있다.
 *
 * 고정 날짜인 이유: "이번 달 기준"으로 하면 달이 바뀔 때 고건 학생의 1,000원
 * 미수금이 소리 없이 사라진다. 경계는 움직이면 안 된다.
 */
export const PARTIAL_PAYMENT_SINCE = "2026-08";

/**
 * 한 달치 상태를 만든다.
 *
 * tuition 이 0 이하인 경우(수강료 미설정 등)는 청구할 게 없으므로 완납으로 본다.
 * 그렇게 하지 않으면 수강료를 안 적어 둔 반이 전부 미납으로 뜬다.
 *
 * @param partialSince 이 달(YYYY-MM) 이전은 부분납으로 보지 않고, 조금이라도
 *   냈으면 완납으로 처리한다. 생략하면 경계 없이 모든 달에 부분납을 적용한다
 *   (서버 invoicesHelper 처럼 최근 달만 보는 곳은 경계가 필요 없다).
 */
export function computeMonthStatus(
  month: string,
  tuition: number,
  paid: number,
  partialSince?: string,
): MonthPayment {
  // paid 를 0 에서 한 번 자르고 뺀다. 그래서 남은 금액이 그 달 수강료를 절대 넘지 않는다.
  //
  // 왜 자르나: 환불이 원비보다 큰 달이 생길 수 있다. 8월에 낸 돈을 9월에 환불하면
  // (payment_month 를 9월로 적은 경우) 9월 순액이 음수가 된다. 자르지 않으면
  // 27만원짜리 달에 "32만원 남음"이 뜬다. 원장이 화면을 못 믿게 되는 종류의 숫자다.
  // 넘친 환불액은 그 달에 매달지 않고 결제 내역 원본에 남겨 둔다.
  const effectivePaid = Math.max(0, paid);

  // 경계 이전 달: 그 달의 진짜 청구액을 모르므로 모자란 금액을 계산하지 않는다.
  // 조금이라도 들어왔으면 완납으로 두고 남은 금액은 0 으로 못 박는다.
  // (YYYY-MM 은 zero-padded 라 문자열 비교로 시간 순서가 그대로 나온다.)
  const grandfathered = partialSince !== undefined && month < partialSince;
  if (grandfathered && effectivePaid > 0) {
    return { month, tuition, paid, remaining: 0, status: "완납" };
  }

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

/**
 * 기본 달 목록에 "미리 낸 미래 달"을 끼워 넣는다.
 *
 * ── 왜 필요한가 (2026-08-30, 원장 실험) ──
 *   원장이 8월에 어떤 학생의 **9월** 수강료로 1,000원을 결제해 봤다. 학생 태블릿에는
 *   제대로 반영됐는데 수납 화면에는 아무 데도 안 나왔다. 돈은 들어왔는데 원장이
 *   그걸 볼 방법이 없었다.
 *
 *   원인은 수납 화면이 달 목록을 "등록일 ~ 오늘" 로만 만들었다는 것이다. 9월은
 *   아직 오지 않았으므로 목록에 없고, 목록에 없으면 9월에 들어온 돈은 계산에서
 *   통째로 빠진다. 반면 태블릿(invoicesHelper)은 앞으로 6개월을 함께 보므로
 *   같은 결제가 거기서는 보였다. 같은 데이터를 두 화면이 다르게 그린 것이다.
 *
 * ── 왜 "돈이 들어온 달만" 넣나 ──
 *   태블릿처럼 미래 6개월을 무조건 펼치면 안 된다. 태블릿은 "낼 수 있는 달"을
 *   보여 주는 화면이지만, 수납은 "받아야 할 돈"을 보여 주는 화면이다. 미래
 *   6개월을 그냥 펼치면 전교생이 앞으로 6달치 미납으로 뜨고, 미납 합계가
 *   실제의 몇 배로 부풀어 원장이 화면을 못 믿게 된다.
 *
 *   그래서 미래 달은 **실제로 돈이 들어온 달만** 넣는다. 선납은 보이고,
 *   아직 청구할 때가 안 된 달은 조용하다.
 *
 * @param baseMonths 등록일 ~ 오늘로 만든 기본 달 목록 (YYYY-MM, 오름차순)
 * @param netByMonth 달별 순액 (원비 - 환불)
 */
export function withPrepaidMonths(
  baseMonths: string[],
  netByMonth: Map<string, number>,
): string[] {
  // 기본 목록의 마지막 달. 이보다 뒤에 있는 달만 "미래" 다.
  // 목록이 비어 있으면(등록일이 미래인 신규생) 모든 납부 달이 미래다.
  const lastBase = baseMonths.length > 0 ? baseMonths[baseMonths.length - 1] : "";

  // forEach 로 도는 이유: 이 파일은 클라이언트·서버가 함께 쓰고 tsconfig target 이
  // 낮아서 Map 을 for...of 로 돌면 downlevelIteration 오류가 난다. 빌드 설정을
  // 바꾸는 것보다 여기서 피하는 쪽이 파급이 작다.
  const extra: string[] = [];
  netByMonth.forEach((net, month) => {
    if (month <= lastBase) return;        // 이미 기본 목록에 있다
    if (net <= 0) return;                 // 냈다가 전액 환불된 달은 만들지 않는다
    extra.push(month);
  });
  if (extra.length === 0) return baseMonths;

  // YYYY-MM 은 zero-padded 라 문자열 정렬이 곧 시간 순서다.
  extra.sort();
  return [...baseMonths, ...extra];
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
