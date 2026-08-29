/**
 * 결제 수명주기 판단 규칙 — 순수 함수 모음.
 *
 * 왜 따로 뺐나 (2026-08-29 사고 이후):
 *   "이 결제 시도가 아직 살아 있는가", "이 승인을 받아 줘도 되는가" 는 이 시스템에서
 *   가장 비싼 판단이다. 틀리면 학생이 결제를 못 하거나(영업 정지), 돈이 장부에서
 *   사라진다. 그런데 이 규칙들이 전부 DB 쿼리의 WHERE 절과 라우트 핸들러 안에
 *   흩어져 있어서 단위 검증이 불가능했다. 실제로 유령 CREATED intent 가 하루 넘게
 *   학생의 재결제를 막았는데도 그걸 잡아낼 테스트가 하나도 없었다.
 *
 *   그래서 규칙 자체를 여기로 옮기고, 라우트는 이 함수들을 **실제로 호출한다**.
 *   테스트가 검증하는 코드와 배포되는 코드가 같아야 의미가 있다.
 *
 * 시간 축의 원칙:
 *   status 는 "우리가 기록해 둔 것", expiresAt 은 "실제로 그럴 수 있는 시간인가".
 *   정리 배치나 단말기 응답이 유실되면 status 는 얼마든지 낡을 수 있지만 시간은
 *   거짓말하지 않는다. 그래서 **차단 여부는 항상 시간이 최종 판단한다.**
 */

import type { PaymentDispatchStatus, PaymentIntentStatus } from "@shared/schema";

/** 아직 마감되지 않은(=결과가 안 들어온) intent 상태. */
export const OPEN_INTENT_STATES: PaymentIntentStatus[] = ["CREATED", "PROCESSING"];

/** 아직 마감되지 않은 dispatch 상태. */
export const OPEN_DISPATCH_STATES: PaymentDispatchStatus[] = ["PENDING", "DELIVERED"];

/**
 * 이 결제 시도가 "지금 진짜로 진행 중"이라 새 결제를 막아야 하는가.
 *
 * 두 조건을 모두 만족해야 막는다:
 *   1) 상태가 아직 마감 전이고,
 *   2) 만료 시각이 아직 지나지 않았다.
 *
 * (2) 가 없으면 실패한 시도가 영원히 남아 결제를 막는다 — 바로 그 사고가 났다.
 * 실패한 시도는 기록으로만 남고 다음 결제를 방해해선 안 된다.
 */
export function isBlocking(
  status: string,
  expiresAt: Date | string,
  now: Date = new Date()
): boolean {
  const openStates: string[] = [...OPEN_INTENT_STATES, ...OPEN_DISPATCH_STATES];
  if (!openStates.includes(status)) return false;
  return new Date(expiresAt).getTime() > now.getTime();
}

/** 차단 해제까지 남은 초. 화면에 "N초 후 다시 시도" 라고 알려 주기 위한 값. */
export function secondsUntilFree(expiresAt: Date | string, now: Date = new Date()): number {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return Math.max(1, Math.ceil(ms / 1000));
}

// ─────────────────────────────────────────────────────────────────────────
// 승인 확정(confirm) 판단
// ─────────────────────────────────────────────────────────────────────────

export type ConfirmDecision =
  /** 이미 승인된 건 — 같은 결과를 그대로 돌려준다 (재전송 대비). */
  | { kind: "idempotent" }
  /** 정상 승인. */
  | { kind: "accept"; lateRecovery: false }
  /**
   * 늦게 도착했지만 받아 준다. 카드는 이미 긁혔으므로 기록이 최우선.
   * why 는 로그·비고에 남길 사람이 읽을 수 있는 사유.
   */
  | { kind: "accept"; lateRecovery: true; why: string }
  /** 받을 수 없다 (알 수 없는 상태). */
  | { kind: "reject"; reason: string };

/**
 * confirm 요청을 받아 줄지 판단한다.
 *
 * ── 핵심 원칙: 이 함수가 호출됐다는 건 카드가 이미 승인됐다는 뜻이다 ──
 *   순서를 보자. 단말기에서 카드 승인이 **먼저** 끝나고, 그 결과를 서버에 알리려고
 *   confirm 이 **나중에** 온다. 그러니 여기서 거절하면 돈은 빠져나갔는데 payments
 *   행은 없는 상태가 된다. 학생은 냈다고 하고 장부는 미납이라고 한다.
 *
 *   예전 코드는 만료(3분)나 TIMEOUT 상태를 이유로 409 를 돌려줬다. 단말기 네트워크가
 *   잠깐 끊겼다 재전송하는 것만으로 이 사고가 난다. 게다가 정리 배치가 intent 를
 *   TIMEOUT 으로 바꿔 두면 더 쉽게 걸린다.
 *
 *   그래서 TTL 의 의미를 다시 정의한다:
 *     TTL 은 "아직 승인되지 않은 결제를 언제까지 기다릴까"를 정하는 값이다.
 *     이미 승인된 돈을 버릴지 말지를 정하는 값이 아니다.
 *
 *   위조·중복 방어는 그대로다 — 금액 대조와 paymentKey UNIQUE 는 호출부에 남아 있다.
 *   이 완화로 새로 열리는 공격 경로는 없다. 공격자가 얻는 건 "만료된 자기 결제를
 *   제 금액 그대로 기록되게 하는 것"뿐이다.
 *
 * CANCELED 도 받아 주는 이유:
 *   태블릿에서 취소를 눌렀는데 단말기에서는 이미 카드가 승인되는 경합이 실재한다.
 *   이때도 돈은 나갔다. 기록이 우리 의도를 이긴다.
 */
export function classifyConfirm(input: {
  intentStatus: string;
  expiresAt: Date | string;
  now?: Date;
}): ConfirmDecision {
  const now = input.now ?? new Date();

  if (input.intentStatus === "APPROVED") return { kind: "idempotent" };

  const isOpen = input.intentStatus === "CREATED" || input.intentStatus === "PROCESSING";
  const isClosedButRecoverable =
    input.intentStatus === "TIMEOUT" ||
    input.intentStatus === "CANCELED" ||
    input.intentStatus === "FAILED";

  if (!isOpen && !isClosedButRecoverable) {
    return { kind: "reject", reason: `현재 상태에서는 승인할 수 없습니다: ${input.intentStatus}` };
  }

  const expired = new Date(input.expiresAt).getTime() < now.getTime();

  if (isOpen && !expired) return { kind: "accept", lateRecovery: false };

  const reasons: string[] = [];
  if (!isOpen) reasons.push(`상태=${input.intentStatus}`);
  if (expired) reasons.push("만료 후 도착");
  return { kind: "accept", lateRecovery: true, why: reasons.join(", ") };
}
