/**
 * 환불 판정 규칙 (순수 함수).
 *
 * 왜 별도 모듈인가:
 *   환불은 돈을 되돌리는 동작이라 "두 번 눌렀더니 두 번 나갔다"가 그대로 사고가 된다.
 *   DB·HTTP 를 섞어 두면 그 경계 조건을 테스트로 고정할 수 없다. lifecycle.ts 와 같은
 *   방침으로, 판정은 여기에 모으고 라우터는 이 판정을 집행만 한다.
 *
 * ⚠️ 이 모듈이 판정하는 것은 "우리 장부에 환불을 얼마나 적을 수 있나"이지
 *    "카드사에서 돈이 나갔나"가 아니다. 실제 카드 취소는 Toss Open API
 *    서버-대-서버 호출이 필요한데 지금 이 서버에는 그 시크릿 키가 없다
 *    (TOSS_MERCHANT_ID·웹훅 시크릿·단말기 시크릿만 있다). 그래서 현재 구조는:
 *
 *      실제 카드 취소  →  단말기 / 토스 판매자센터에서 원장이 수행
 *      장부 반영       →  이 모듈 (원장이 관리자 화면에서 기록)  또는  취소 웹훅
 *
 *    둘 다 같은 paymentKey 를 건드리므로 중복 계상이 진짜 위험이다.
 *    그래서 "이미 환불된 누적액"을 항상 payments 에서 다시 세서 판단한다.
 *    (상태 플래그를 믿지 않는다 — 웹훅과 사람이 각자 다른 순서로 도착한다.)
 */

/** 환불 금액을 계산할 때 필요한 사실들. 전부 호출부가 DB 에서 읽어 넣는다. */
export interface RefundContext {
  /** payment_intents.status. 돈이 실제로 승인된 건만 환불 대상이다. */
  intentStatus: string;
  /** 승인된 금액 (양수). payment_intents.amount. */
  approvedAmount: number;
  /**
   * 이미 환불된 누적액 (양수로 환산해서 넣는다).
   * payments 의 음수 행들을 SUM 한 뒤 부호를 뒤집은 값.
   */
  alreadyRefunded: number;
  /** 이번에 환불하려는 금액 (양수). */
  requested: number;
}

export type RefundDecision =
  | {
      kind: "ok";
      /** 실제로 장부에 적을 금액 (양수). payments 에는 이 값의 음수로 들어간다. */
      amount: number;
      /** 이번 환불 후에도 남는 환불 가능액. */
      remainingAfter: number;
      /** 이번 환불로 전액이 환불되는가. true 면 intent 를 CANCELED 로 마감한다. */
      fullyRefunded: boolean;
    }
  | { kind: "reject"; reason: string };

/**
 * 환불 가능액. 음수가 되지 않게 바닥을 0 으로 자른다.
 *
 * 왜 바닥이 필요한가: 웹훅과 수기 환불이 겹쳐 과환불이 이미 기록돼 버린 상황에서도
 * 이 함수가 음수를 돌려주면 화면에 "-3,000원 환불 가능"이 뜬다. 그건 안내가 아니라
 * 또 다른 사고 유발이다. 남은 게 없으면 0 이다.
 */
export function refundableAmount(approvedAmount: number, alreadyRefunded: number): number {
  return Math.max(0, approvedAmount - alreadyRefunded);
}

/**
 * 이 환불을 받아 줄지 판정한다.
 *
 * 거절 사유는 전부 원장이 화면에서 읽고 다음 행동을 정할 수 있는 문장으로 쓴다.
 * ("검증 실패" 같은 문장은 원장에게 아무것도 알려 주지 않는다.)
 */
export function classifyRefund(ctx: RefundContext): RefundDecision {
  // 1) 승인된 적 없는 건은 환불할 원금 자체가 없다.
  //    CREATED/PROCESSING 은 아직 진행 중이므로 "취소"이지 "환불"이 아니다.
  if (ctx.intentStatus !== "APPROVED") {
    if (ctx.intentStatus === "CREATED" || ctx.intentStatus === "PROCESSING") {
      return {
        kind: "reject",
        reason: "아직 승인되지 않은 결제입니다. 환불이 아니라 취소 대상이며, 3분 뒤 자동으로 정리됩니다.",
      };
    }
    return {
      kind: "reject",
      reason: `승인된 결제가 아니라 환불할 수 없습니다 (현재 상태: ${ctx.intentStatus}).`,
    };
  }

  // 2) 금액은 양의 정수만. 0·음수·소수는 장부를 오염시킨다.
  if (!Number.isInteger(ctx.requested) || ctx.requested <= 0) {
    return { kind: "reject", reason: "환불 금액은 1원 이상의 정수여야 합니다." };
  }

  // 3) 남은 환불 가능액을 넘을 수 없다.
  //    이게 이중 환불(사람 + 웹훅, 또는 두 번 클릭)을 막는 유일한 방어선이다.
  const remaining = refundableAmount(ctx.approvedAmount, ctx.alreadyRefunded);
  if (remaining <= 0) {
    return {
      kind: "reject",
      reason: `이미 전액 환불된 결제입니다 (승인 ${ctx.approvedAmount.toLocaleString()}원 · 환불 ${ctx.alreadyRefunded.toLocaleString()}원).`,
    };
  }
  if (ctx.requested > remaining) {
    return {
      kind: "reject",
      reason: `환불 가능한 금액은 ${remaining.toLocaleString()}원입니다. (승인 ${ctx.approvedAmount.toLocaleString()}원 중 이미 ${ctx.alreadyRefunded.toLocaleString()}원 환불됨)`,
    };
  }

  const remainingAfter = remaining - ctx.requested;
  return {
    kind: "ok",
    amount: ctx.requested,
    remainingAfter,
    fullyRefunded: remainingAfter === 0,
  };
}

/**
 * 취소 웹훅이 도착했을 때 장부에 추가로 적어야 할 금액.
 *
 * 왜 웹훅이 intent.amount 를 그대로 쓰면 안 되나:
 *   원장이 관리자 화면에서 이미 환불을 기록한 뒤 토스에서 취소 웹훅이 오면,
 *   같은 돈이 두 번 마이너스로 꽂힌다. 27만원 결제에 -54만원이 되는 것이다.
 *   그래서 웹훅도 "이미 적힌 만큼 빼고 남은 것만" 적는다.
 *
 * 반환 0 이면 적을 게 없다는 뜻이므로 호출부는 payments 삽입을 건너뛴다.
 */
export function webhookCancelAmount(approvedAmount: number, alreadyRefunded: number): number {
  return refundableAmount(approvedAmount, alreadyRefunded);
}
