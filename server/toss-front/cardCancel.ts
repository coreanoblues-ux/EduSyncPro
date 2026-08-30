/**
 * 단말기 카드 취소 판정 (순수 함수).
 *
 * ── 이 모듈이 존재하는 이유 ──
 *   지금까지 우리 환불(/admin/refunds)은 **장부만** 건드렸다. 카드사에는 아무 일도
 *   일어나지 않았고, 실제 취소는 원장이 단말기나 토스 사장님 앱에서 따로 해야 했다.
 *   두 개가 따로 놀면 반드시 어긋난다 — 카드만 취소하고 장부를 안 적거나, 장부만
 *   적고 카드를 안 취소하거나.
 *
 *   토스플레이스 Front 플러그인 SDK 에는 `requestPaymentCancel` 이 있다. 단말기가
 *   직접 카드 취소를 걸 수 있다는 뜻이다. 그래서 흐름을 하나로 묶는다:
 *
 *       원장이 웹에서 취소 요청  →  단말기가 카드 취소  →  성공하면 그때 장부에 음수 행
 *
 *   장부 행은 **카드가 실제로 취소된 뒤에만** 쓴다. 순서가 반대면 "장부엔 환불인데
 *   돈은 안 돌아간" 상태가 되고, 그건 학부모와 다투게 되는 종류의 오류다.
 *
 * ── 왜 별도 테이블(payment_cancel_dispatches)인가 ──
 *   payment_dispatches 는 payment_key 와 intent_id 가 **둘 다 UNIQUE** 다. 취소는
 *   원결제와 같은 키를 가리키므로 그 테이블에 끼워 넣을 수 없다. 그 UNIQUE 들은
 *   같은 결제가 두 번 dispatch 되는 것을 막는 방어선이라 풀 수도 없다.
 *
 * ── 왜 전액 취소만인가 ──
 *   토스 문서(reference/plugin-sdk/front/payment.html)가 requestPaymentCancel 에
 *   대해 "원거래와 동일한 tax, supplyValue, taxExemptValue 를 전달해요" 라고 못박는다.
 *   즉 이 API 로는 원금 그대로 되돌리는 것만 지원된다. 부분 환불(중도 퇴원 정산 등)은
 *   기존 /admin/refunds 의 장부 기록으로 계속 처리한다. 여기서 억지로 부분 취소를
 *   흉내 내면 카드사 금액과 장부 금액이 갈라진다.
 *
 * ⚠️ 이 모듈은 DB·HTTP·SDK 를 모르는 순수 함수만 담는다. 돈을 되돌리는 경계 조건은
 *    테스트로 고정할 수 없으면 지킬 수 없기 때문이다 (refund.ts·lifecycle.ts 와 같은 방침).
 */

/**
 * 취소 dispatch 의 생애.
 *
 *   PENDING   서버가 큐에 담았고 단말기가 아직 집어가지 않았다. 카드는 그대로다.
 *   DELIVERED 단말기가 집어갔다. **카드 상태를 알 수 없는 구간이다.**
 *   SUCCEEDED 단말기가 취소 성공을 보고했고 장부까지 반영됐다.
 *   FAILED    단말기가 명시적 실패를 보고했다. 카드는 취소되지 **않았다**.
 *   TIMEOUT   만료될 때까지 아무 응답이 없었다. **카드 상태를 알 수 없다.**
 */
export type CancelDispatchStatus =
  | "PENDING"
  | "DELIVERED"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMEOUT";

/**
 * 재시도해도 안전한 상태.
 *
 * FAILED **하나뿐**이다. 이게 이 모듈에서 가장 중요한 한 줄이다.
 *
 *   - PENDING/DELIVERED 는 진행 중이다. 또 걸면 두 번 취소된다.
 *   - SUCCEEDED 는 이미 됐다. 또 걸 이유가 없다.
 *   - TIMEOUT 은 **모른다**. 카드가 취소됐는데 응답만 못 받은 것일 수도 있다.
 *     모르는 상태에서 자동 재시도를 붙이면 27만원이 두 번 빠져나간다.
 *     결제 아웃박스는 "안 됐으면 다시" 가 안전했지만, 취소는 정반대다.
 *     결제는 중복되면 우리가 환불하면 되지만, 취소가 중복되면 학부모 카드로
 *     돈이 두 번 들어가고 우리는 그걸 되돌릴 API 조차 없다.
 *
 *   그래서 TIMEOUT 은 사람이 토스 사장님 앱에서 실물을 확인하고 풀어야 한다.
 */
export const RETRYABLE_CANCEL_STATES: readonly CancelDispatchStatus[] = ["FAILED"];

/** 아직 단말기에서 처리 중이라 새 요청을 받으면 안 되는 상태. */
export const OPEN_CANCEL_STATES: readonly CancelDispatchStatus[] = ["PENDING", "DELIVERED"];

/** 카드 취소를 걸기 위해 SDK 에 넘겨야 하는 사실들. 전부 원승인 기록에서 나온다. */
export interface CancelSourceFacts {
  /** payment_intents.status. APPROVED 가 아니면 되돌릴 원금이 없다. */
  intentStatus: string;
  /** 승인 금액 (양수). */
  approvedAmount: number;
  /** 이 결제로 장부에 실제 들어온 돈 (양수 합). */
  ledgerPaidIn: number;
  /** 이 결제에서 이미 환불된 누적액 (양수로 환산). */
  ledgerRefunded: number;
  /** 원승인 기록(toss_payment_transactions)이 있는가. 없으면 SDK 를 부를 수 없다. */
  hasApprovalRecord: boolean;
  /** 원승인번호. SDK 필수 파라미터. */
  approvalNumber: string | null;
  /**
   * 원승인 timestamp. SDK 필수 파라미터이자 **단말기가 원거래를 찾는 조회 키**다.
   * 저장된 값은 ISO 일 수도 밀리초일 수도 있어 normalizeApprovedTimestamp 로 본다.
   */
  approvedTimestamp: string | null;
  /** 단말기 거래번호. SDK 필수 파라미터. 컬럼이 nullable 이라 비어 있을 수 있다. */
  tid: string | null;
  /** 어느 단말기에서 승인됐는가. 없으면 어디로 보낼지 알 수 없다. */
  deviceId: string | null;
  /** 이 결제에 대해 이미 존재하는 취소 dispatch 의 상태들. */
  existingCancelStates: CancelDispatchStatus[];
}

export type CancelDecision =
  | {
      kind: "ok";
      /** 카드에서 되돌릴 금액. 전액 취소이므로 원승인 금액. */
      cancelAmount: number;
      /** 성공했을 때 장부에 추가로 적을 금액 (양수). 0 이면 이미 적혀 있다는 뜻. */
      ledgerAmount: number;
    }
  | { kind: "reject"; reason: string; needsHuman?: boolean };

/**
 * 웹훅이 쓰는 것과 같은 계산 — "아직 되돌릴 수 있는 돈".
 *
 * refund.ts 의 webhookCancelAmount 와 의도적으로 같은 식이다. 세 경로(단말기 취소·
 * 취소 웹훅·원장 수기 환불)가 **같은 근거**로 금액을 정해야 서로 중복 계상하지 않는다.
 * 상태 플래그가 아니라 실제로 장부에 적힌 돈만 본다.
 */
export function remainingRefundable(ledgerPaidIn: number, ledgerRefunded: number): number {
  return Math.max(0, ledgerPaidIn - ledgerRefunded);
}

/**
 * 이 결제에 카드 취소를 걸어도 되는가.
 *
 * 거절 사유는 전부 원장이 화면에서 읽고 **다음에 뭘 해야 하는지** 알 수 있게 쓴다.
 * needsHuman=true 는 "우리가 자동으로 못 푼다, 사장님 앱에서 실물을 확인하라"는 뜻이다.
 */
export function classifyCardCancel(facts: CancelSourceFacts): CancelDecision {
  // (1) 진행 중인 취소가 있으면 무조건 막는다. 가장 먼저 본다 —
  //     버튼은 네트워크가 느리면 반드시 두 번 눌린다.
  if (facts.existingCancelStates.some((s) => OPEN_CANCEL_STATES.includes(s))) {
    return {
      kind: "reject",
      reason: "이미 취소를 단말기로 보냈습니다. 단말기 화면을 확인해 주세요.",
    };
  }

  // (2) 이미 성공한 취소가 있으면 막는다.
  if (facts.existingCancelStates.includes("SUCCEEDED")) {
    return { kind: "reject", reason: "이미 카드 취소가 완료된 결제입니다." };
  }

  // (3) 결과를 모르는 취소(TIMEOUT)가 있으면 **자동으로 다시 걸지 않는다.**
  //     여기서 재시도를 허용하면 이중 취소가 난다. 사람이 확인해야 한다.
  if (facts.existingCancelStates.includes("TIMEOUT")) {
    return {
      kind: "reject",
      needsHuman: true,
      reason:
        "이전 취소 요청의 결과를 받지 못했습니다. 카드가 이미 취소됐을 수 있으므로 " +
        "자동으로 다시 시도하지 않습니다. 토스 사장님 앱에서 취소 여부를 먼저 확인해 주세요.",
    };
  }

  // (4) 승인된 결제만 취소할 수 있다.
  if (facts.intentStatus !== "APPROVED") {
    if (facts.intentStatus === "CREATED" || facts.intentStatus === "PROCESSING") {
      return {
        kind: "reject",
        reason: "아직 승인이 끝나지 않은 결제입니다. 취소가 아니라 진행 중이며, 3분 뒤 자동 정리됩니다.",
      };
    }
    if (facts.intentStatus === "CANCELED") {
      return { kind: "reject", reason: "이미 취소 처리된 결제입니다." };
    }
    return {
      kind: "reject",
      reason: `승인된 결제가 아니라 카드 취소를 걸 수 없습니다 (현재 상태: ${facts.intentStatus}).`,
    };
  }

  // (5) SDK 에 넘길 원승인 정보가 있어야 한다.
  //     requestPaymentCancel 은 approvalNumber 와 timestamp 를 필수로 요구한다.
  //     이게 없으면 호출 자체가 불가능하다 — 있는 척하고 보내면 단말기에서 죽는다.
  if (!facts.hasApprovalRecord || !facts.approvalNumber || !facts.approvedTimestamp) {
    return {
      kind: "reject",
      needsHuman: true,
      reason:
        "이 결제의 단말기 승인 기록(승인번호·승인시각)이 없어 카드 취소를 걸 수 없습니다. " +
        "토스 사장님 앱에서 직접 취소한 뒤, 환불 기록 화면에서 장부에만 반영해 주세요.",
    };
  }

  // (5-a) 원승인 시각이 밀리초로 해석돼야 한다. 이건 단말기가 **원거래를 찾는
  //       조회 키**다. 해석이 안 되는 값을 보내면 단말기는 취소 화면을 띄웠다가
  //       "요청건이 없다" 며 되돌아온다. 원장 입장에선 아무 설명 없이 실패한 것이라
  //       가장 나쁜 종류의 오류다. 그래서 보내기 전에 여기서 거른다.
  if (!normalizeApprovedTimestamp(facts.approvedTimestamp)) {
    return {
      kind: "reject",
      needsHuman: true,
      reason:
        "이 결제의 승인 시각 기록이 단말기가 알아볼 수 있는 형식이 아니라 카드 취소를 걸 수 없습니다. " +
        "토스 사장님 앱에서 직접 취소한 뒤, 환불 기록 화면에서 장부에만 반영해 주세요.",
    };
  }

  // (5-b) TID 는 원거래를 특정하는 또 하나의 필수 키다 (SDK 필수 파라미터).
  //       DB 컬럼이 nullable 이라 승인 응답에 없었으면 비어 있을 수 있다.
  //       비어 있으면 단말기가 원거래를 못 찾는다 — 위와 같은 실패다.
  if (!facts.tid) {
    return {
      kind: "reject",
      needsHuman: true,
      reason:
        "이 결제의 단말기 거래번호(TID)가 기록돼 있지 않아 카드 취소를 걸 수 없습니다. " +
        "토스 사장님 앱에서 직접 취소한 뒤, 환불 기록 화면에서 장부에만 반영해 주세요.",
    };
  }

  // 웹훅이 만들어 준 승인 기록은 승인번호가 "WEBHOOK" 이다. 실물 승인번호가 아니라
  // 단말기에 넘길 수 없다. 이걸 거르지 않으면 단말기가 알 수 없는 오류로 실패한다.
  if (facts.approvalNumber === "WEBHOOK") {
    return {
      kind: "reject",
      needsHuman: true,
      reason:
        "이 결제는 웹훅으로만 확인된 건이라 실제 승인번호가 없습니다. " +
        "토스 사장님 앱에서 직접 취소한 뒤 장부에만 반영해 주세요.",
    };
  }

  // (6) 어느 단말기로 보낼지 알아야 한다.
  if (!facts.deviceId) {
    return {
      kind: "reject",
      needsHuman: true,
      reason:
        "이 결제가 어느 단말기에서 승인됐는지 기록이 없어 취소를 보낼 곳을 정할 수 없습니다. " +
        "토스 사장님 앱에서 직접 취소해 주세요.",
    };
  }

  // (7) 되돌릴 돈이 남아 있어야 한다.
  const remaining = remainingRefundable(facts.ledgerPaidIn, facts.ledgerRefunded);
  if (facts.ledgerPaidIn <= 0) {
    return {
      kind: "reject",
      needsHuman: true,
      reason:
        "승인 상태이지만 장부에 입금 기록이 없습니다. 먼저 수기 대사로 승인을 장부에 반영한 뒤 취소해 주세요.",
    };
  }
  if (remaining <= 0) {
    return {
      kind: "reject",
      reason: `이미 전액 환불로 기록된 결제입니다 (입금 ${facts.ledgerPaidIn.toLocaleString()}원 · 환불 ${facts.ledgerRefunded.toLocaleString()}원).`,
    };
  }

  // 카드에서 되돌리는 금액은 **원승인 전액**이다 (SDK 가 부분 취소를 지원하지 않는다).
  // 장부에 적을 금액은 **아직 안 적힌 만큼**이다. 둘이 다를 수 있다 — 원장이 이미
  // 일부를 수기로 환불 기록해 뒀다면 카드는 전액 되돌아가지만 장부에는 나머지만 적힌다.
  return {
    kind: "ok",
    cancelAmount: facts.approvedAmount,
    ledgerAmount: remaining,
  };
}

/**
 * 단말기가 보고한 취소 결과를 어떻게 받아들일지.
 *
 * SDK 결과 타입은 결제와 같다: SUCCESS / CANCELED / TIMEOUT / FAILED.
 * 여기서 CANCELED 는 "취소 요청 자체를 사용자가 단말기에서 물렀다"는 뜻이라
 * 카드는 그대로다 — 즉 우리 관점에서는 실패다. 헷갈리기 쉬운 지점이라 명시한다.
 */
export function classifyCancelResult(
  sdkResultType: string
): { status: CancelDispatchStatus; cardCancelled: boolean } {
  switch (sdkResultType) {
    case "SUCCESS":
      return { status: "SUCCEEDED", cardCancelled: true };
    case "FAILED":
      // 단말기가 명시적으로 실패를 알렸다 = 카드는 건드려지지 않았다.
      return { status: "FAILED", cardCancelled: false };
    case "CANCELED":
      // 사용자가 단말기에서 취소 진행을 물렀다. 카드는 그대로다.
      return { status: "FAILED", cardCancelled: false };
    case "TIMEOUT":
      // 가장 위험한 경우. 카드가 취소됐는지 알 수 없다.
      return { status: "TIMEOUT", cardCancelled: false };
    default:
      // 모르는 결과는 TIMEOUT 과 같이 취급한다. "모른다" 쪽으로 기울여야 안전하다.
      return { status: "TIMEOUT", cardCancelled: false };
  }
}

/** 취소 dispatch TTL. 카드 재삽입·서명이 필요할 수 있어 결제(3분)보다 넉넉히 준다. */
export const CANCEL_DISPATCH_TTL_MS = 5 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════
// 원승인 시각 정규화
// ═══════════════════════════════════════════════════════════════════════

/**
 * 저장된 원승인 시각을 **밀리초 문자열**로 바꾼다. 못 바꾸면 null.
 *
 * ── 왜 필요한가 (2026-08-30 현장에서 잡은 진짜 원인) ──
 *   원장이 [카드 취소] 를 누르면 단말기에 취소 화면이 떴다가 곧 "요청건이 없다" 며
 *   원래 화면으로 돌아갔다. 배달도 됐고 ack 도 됐고 SDK 도 불렸는데 결과만 실패였다.
 *
 *   범인은 timestamp 의 형식이었다.
 *     · SDK requestPaymentCancel 의 timestamp 는 "원승인 시각(밀리초)" 이고
 *       **원거래를 찾는 조회 키**다 (sdk.ts 선언 참고).
 *     · 그런데 승인 때 플러그인이 저장한 값은 SDK 승인 응답의 approvedAt,
 *       즉 ISO 문자열이다 ("2026-08-15T11:23:45.000Z").
 *   조회 키에 형식이 다른 값을 넣었으니 단말기는 그런 거래가 없다고 답할 수밖에 없다.
 *   toss_payment_transactions.approved_timestamp 의 스키마 주석이 처음부터
 *   "밀리초" 라고 적혀 있었는데 기록하는 쪽만 ISO 였다.
 *
 * ── 왜 저장값을 고치지 않고 쓸 때 변환하는가 ──
 *   approved_timestamp 는 단말기가 준 것을 그대로 남긴 감사 기록이다. 지나간 기록을
 *   덮어쓰면 나중에 "그때 단말기가 뭐라고 했는지" 를 영영 알 수 없다. 해석은 쓰는
 *   쪽에서 한다.
 *
 * ── 왜 두 형식을 다 받는가 ──
 *   펌웨어에 따라 이미 밀리초를 주는 경우가 있을 수 있다. 어느 쪽이 오든 맞게
 *   동작해야 하고, **판단이 안 서면 추측해서 보내지 않는다** (null 을 돌려
 *   호출측이 취소를 거절하게 한다). 조회 키를 틀리게 보내는 것이 바로 이 사고였다.
 */
export function normalizeApprovedTimestamp(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === "") return null;

  // (1) 숫자만 있는 경우 — 이미 epoch 다. 자릿수로 초/밀리초를 가른다.
  if (/^\d+$/.test(s)) {
    // 13자리 ≈ 2001~2286년의 밀리초. 우리 도메인의 값은 전부 여기 들어온다.
    if (s.length === 13) return s;
    // 10자리 = 초 단위. ×1000 해서 밀리초로 맞춘다.
    if (s.length === 10) return `${Number(s) * 1000}`;
    // 그 밖의 자릿수는 무엇인지 모른다. 추측하지 않는다.
    return null;
  }

  // (2) ISO 등 날짜 문자열 — 지금 현장의 실제 값이 이것이다.
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  // 1990년 이전/2100년 이후면 파싱이 엉뚱하게 된 것이다. 그런 값은 보내지 않는다.
  if (ms < 631_152_000_000 || ms > 4_102_444_800_000) return null;
  return `${ms}`;
}

// ═══════════════════════════════════════════════════════════════════════
// 재배정 (reroute)
// ═══════════════════════════════════════════════════════════════════════

/**
 * 한 번의 폴링에서 살펴볼 PENDING 취소 행 수.
 *
 * 학원엔 단말기가 한 대뿐이라 실제로는 늘 0~1건이다. 여러 건을 훑는 이유는
 * "내 앞으로 온 건"이 목록 뒤에 있을 때 앞의 남의 건 때문에 못 보는 일을 막기 위해서다.
 */
export const CANCEL_SCAN_LIMIT = 5;

/**
 * 폴링하는 단말기의 lastSeenAt 을 다시 찍기까지 기다리는 시간.
 *
 * 플러그인은 1초마다 폴링한다. 그때마다 UPDATE 하면 한 행에 초당 한 번씩 쓰는 꼴이라
 * 필요 없는 테이블 부풀림이 생긴다. 20초면 아래 STALE 판정(90초)의 4분의 1이라
 * 살아 있는 단말기가 죽은 것으로 보일 일은 없다.
 */
export const DEVICE_TOUCH_INTERVAL_MS = 20 * 1000;

/**
 * 대상 단말기를 "죽었다"고 보기까지의 시간.
 *
 * 폴링할 때마다(최대 20초 간격) lastSeenAt 이 갱신되므로, 90초 넘게 조용하면 그 기기 행은
 * 살아 있는 단말기가 아니다 — 재페어링으로 버려진 행이거나 꺼진 단말기다.
 * 넉넉히 잡는 이유는, 잘못 짧게 잡아 살아 있는 단말기의 일을 빼앗는 쪽이
 * 훨씬 위험하기 때문이다(두 대가 같은 카드 취소를 집어가려 든다).
 */
export const CANCEL_DEVICE_STALE_MS = 90 * 1000;

/** decideCancelReroute 가 보는 최소한의 정보. DB 행의 부분집합이다. */
export interface CancelRerouteCandidate {
  cancelId: string;
  targetDeviceId: string;
  targetActive: boolean | null;
  targetLastSeenAt: Date | null;
}

/**
 * 내 앞으로 온 취소가 하나도 없을 때, 남의 앞으로 온 것을 가져와도 되는지 판단한다.
 *
 * ── 왜 이 판단이 필요한가 (2026-08-30 현장) ──
 *   취소는 "원래 결제를 승인했던 단말기 ID" 앞으로 쌓인다. 그런데 플러그인을 다시 올리거나
 *   단말기를 재페어링하면 toss_front_devices 에 **새 행**이 생긴다. 물리적으로는 같은
 *   단말기인데 ID 가 달라진 것이다. 그러면 취소는 옛 ID 앞에 남고, 지금 폴링하는 새 ID 는
 *   가져갈 게 없어 단말기 화면에 아무 일도 일어나지 않는다. 원장 화면에는 "취소 요청됨"
 *   이라고 떠 있는데 단말기는 조용한, 가장 설명하기 어려운 상태가 된다.
 *
 * ── 왜 조건을 붙이는가 ──
 *   무조건 가져오면 단말기가 두 대인 학원에서 엉뚱한 카운터의 단말기가 취소를 집어간다.
 *   결제라면 그냥 다시 하면 되지만, 취소는 되돌릴 API 가 우리에게 없다. 그래서
 *   **대상 단말기가 확실히 조용할 때만** 가져온다. 애매하면 양보하고 아무것도 안 한다.
 */
export function decideCancelReroute<T extends CancelRerouteCandidate>(
  candidates: readonly T[],
  pollingDeviceId: string,
  now: number,
  uptimeMs: number
): T | null {
  for (const c of candidates) {
    if (c.targetDeviceId === pollingDeviceId) return c; // 원래 내 것 (호출측에서 이미 걸렀지만 방어적으로)

    // 비활성 기기 행 = 페어링이 해제된 것. 살아 있을 수 없다.
    // 이 판정은 시계가 아니라 원장의 명시적 조작에 근거하므로 부팅 직후에도 믿을 수 있다.
    if (c.targetActive === false) return c;

    // ── 부팅 직후에는 시간 기반 판정을 하지 않는다 ──
    //   lastSeenAt 은 이 서버 프로세스가 폴링을 받아야 갱신된다. 방금 재배포됐다면
    //   멀쩡히 켜져 있는 단말기도 아직 한 번도 자기 시각을 찍지 못했다. 그 순간에
    //   "조용하니 죽었다"고 판단하면 살아 있는 단말기의 취소를 빼앗는다.
    //   Railway 는 배포마다 재시작하므로 이건 드문 일이 아니다.
    if (uptimeMs <= CANCEL_DEVICE_STALE_MS) return null;

    // 한 번도 접속한 적 없는 기기 행 앞으로 취소가 있다면, 그 기기는 존재한 적이 없다.
    if (c.targetLastSeenAt == null) return c;

    if (now - c.targetLastSeenAt.getTime() > CANCEL_DEVICE_STALE_MS) return c;

    // 대상 단말기가 살아 있다. 그 단말기가 자기 폴링에서 가져가게 둔다.
    // 여기서 continue 하지 않고 멈추는 이유: 순서(createdAt)를 지켜야 한다.
    return null;
  }
  return null;
}
