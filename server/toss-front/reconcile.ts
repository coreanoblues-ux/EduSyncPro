/**
 * 수기 대사(對査) 판정 — "카드는 승인됐는데 장부에 없는 건"을 되찾는다.
 *
 * 왜 필요한가 (2026-08-29 현장):
 *   원장 화면에 이런 세 건이 남았다.
 *     08-28 19:24  270,000  TIMEOUT/expired   ← 진짜 실패 (카드 안 긁힘)
 *     08-29 13:00    1,000  TIMEOUT/expired   ← 실제로는 승인됨
 *     08-29 14:57  269,000  TIMEOUT/expired   ← 실제로는 승인됨
 *   즉 학생은 270,000원을 냈는데 payments 에는 한 줄도 없다.
 *
 *   원인은 순서다. 카드 승인은 단말기에서 먼저 끝나고 서버 confirm 은 나중에 온다.
 *   confirm 이 못 오면(네트워크 끊김·단말기 재시작) 정리 배치가 TIMEOUT 으로 찍고,
 *   그 뒤로는 아무도 그 돈을 장부에 넣어 주지 않는다. classifyConfirm 개선으로
 *   "늦게라도 confirm 이 오면" 받아 주게 했지만, 이미 confirm 을 영영 못 받은
 *   과거 건은 사람이 직접 넣어 주는 수밖에 없다.
 *
 * ⚠️ 이 기능은 "돈이 들어왔다고 사람이 선언하는" 경로다. 장부에 없는 수입을 만드는
 *    동작이므로 본질적으로 위험하다. 그래서 다음을 강제한다:
 *      - 금액을 사람이 못 정한다. 항상 intent.amount 다. (숫자를 지어낼 수 없게)
 *      - 승인번호를 반드시 입력해야 한다. 판매자센터에서 실물을 보고 옮겨 적는 행위를
 *        강제해서, "아마 됐겠지" 로 누르는 것을 막는다.
 *      - 이미 장부에 있으면 아무것도 하지 않는다 (두 번 눌러도 두 번 안 들어간다).
 *      - 누가 언제 했는지 payments.notes 와 createdBy 에 남는다.
 */

export interface ReconcileContext {
  /** payment_intents.status */
  intentStatus: string;
  /**
   * 이 paymentKey 로 payments 에 이미 양수(수입) 행이 있는가.
   * 있으면 어떤 경로로든 이미 반영된 것이므로 다시 넣지 않는다.
   */
  alreadyLedgered: boolean;
}

export type ReconcileDecision =
  /** 장부에 넣어도 된다. */
  | { kind: "ok" }
  /** 이미 반영돼 있어 할 일이 없다. 오류가 아니므로 화면에는 성공처럼 알린다. */
  | { kind: "noop"; reason: string }
  | { kind: "reject"; reason: string };

export function classifyReconcile(ctx: ReconcileContext): ReconcileDecision {
  // 1) 이미 장부에 있으면 끝. 이 검사가 제일 앞에 오는 게 중요하다 —
  //    상태가 무엇이든 "돈이 이미 적혀 있다"가 최우선 사실이다.
  if (ctx.alreadyLedgered) {
    return { kind: "noop", reason: "이 결제는 이미 장부에 반영되어 있습니다." };
  }

  // 2) 아직 살아 있는 결제는 손대지 않는다.
  //    confirm 이 지금이라도 도착할 수 있고, 그러면 정상 경로로 들어간다.
  //    여기서 사람이 먼저 넣으면 곧이어 confirm 이 와서 두 번 들어간다.
  if (ctx.intentStatus === "CREATED" || ctx.intentStatus === "PROCESSING") {
    return {
      kind: "reject",
      reason:
        "아직 진행 중인 결제입니다. 단말기 응답을 기다리거나 3분 뒤 자동 정리된 다음 다시 시도하세요.",
    };
  }

  // 3) TIMEOUT·FAILED·CANCELED — 이게 되찾아야 할 본체다.
  //    APPROVED 인데 장부에 없는 경우도 여기로 온다 (confirm 중간에 끊긴 흔적).
  return { kind: "ok" };
}
