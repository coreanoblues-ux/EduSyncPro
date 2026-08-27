/**
 * EduSyncPro Toss Front 2 플러그인 — "결제 단말기 모드".
 *
 * 이 단말기는 학생 검색·청구서 선택 UI가 없다. 학원 카운터 옆 태블릿 웹
 * (/student-kiosk) 이 학생과 청구서를 골라 서버에 dispatch 를 만들어 두고,
 * 이 단말기는 그 dispatch 를 pickup 해서 결제창만 띄운다.
 *
 * 동작 요약:
 *   1) 부팅 → deviceKey 확인 → backup 복구 → 유휴 화면(sdk.template.renderIdlePage)
 *   2) 1초마다 /api/toss-front/dispatch/pending 폴링
 *   3) PENDING 이 있으면 즉시 ackDispatch → sdk.payment.requestPayment(...)
 *   4) result.type 에 따라 서버에 APPROVED / CANCELED / TIMEOUT 통지
 *   5) 유휴 화면 복귀 → 다시 폴링
 *
 * 폴링 간격을 1초로 잡은 이유는, 태블릿에서 원장이 "결제 요청" 을 누른 순간부터
 * 이 단말기에서 카드 화면이 뜨기까지의 지연을 사용자가 인지 못 하는 수준으로 낮추기 위해서다.
 * 서버 부하는 device 당 1 req/s 로 매우 낮다.
 *
 * SDK 어댑터: sdk 는 실제 window.tossFront 또는 SDK import 로 치환된다.
 * 화면 그리기는 sdk.template.* 만 사용한다 (커스텀 HTML/CSS 없음).
 */

import {
  setDeviceKey,
  fetchPendingDispatch,
  ackDispatch,
  reportDispatchResult,
  confirmPayment,
  cancelPayment,
  type PendingDispatch,
} from "./api";

// ─── 공식 SDK 인터페이스 가정 ─────────────────────────────────────────
// 실제 SDK 시그니처에 맞춰 어댑터로 치환한다.
declare const sdk: {
  template: {
    /** 유휴 화면. Toss 표준 대기 그림/광고 슬라이드가 렌더된다. */
    renderIdlePage(): void;
  };
  payment: {
    requestPayment(input: PaymentRequest): Promise<PaymentResult>;
    /** 앱 재시작/충돌 등으로 결제 결과를 놓쳤을 때 마지막 paymentKey 를 돌려준다. */
    getBackupPaymentKey(): Promise<string | null>;
    /** 특정 paymentKey 의 최종 결과를 조회. */
    getPayment(input: { paymentKey: string }): Promise<PaymentResult | null>;
    /** backup 을 사용해 복구를 마쳤을 때 반드시 리셋한다. */
    resetBackupPaymentKey(): Promise<void>;
  };
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
};

// 공식 SDK 반환 타입.
type PaymentRequest = {
  paymentKey: string;
  orderId: string;
  amount: number;
  orderName: string;
};

type PaymentResponseSuccess = {
  paymentKey: string;
  orderId: string;
  amount: number;
  paymentMethod: "CARD" | "CASH" | "BARCODE";
  approvalNumber: string;
  approvedAt: string; // ISO
  card?: {
    number?: string;        // masked
    issuerName?: string;
    acquirerName?: string;
    cardType?: string;
    installmentMonths?: number;
    approveNo?: string;
  };
  van?: string;
  tid?: string;
  vanTransactionKey?: string;
  raw?: any;
};

type PaymentResult =
  | { type: "SUCCESS"; response: PaymentResponseSuccess }
  | { type: "CANCELED"; reason?: string }
  | { type: "TIMEOUT"; reason?: string }
  | { type: "FAILED"; code?: string; message?: string };

// ─── 부팅 ─────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 1000;
let running = false;
let busy = false; // 결제창이 떠 있는 동안 폴링을 잠근다.

export async function bootstrap() {
  const key = await sdk.storage.getItem("deviceKey");
  if (!key) {
    // 결제 단말기 모드에서는 최초 등록도 관리자 프로세스로 처리하는 것이 원칙.
    // 여기서는 로그만 남기고 유휴 화면을 띄운다.
    console.error("[edusyncpro-front] deviceKey 미설정. 관리자에서 등록 필요.");
    sdk.template.renderIdlePage();
    return;
  }
  setDeviceKey(key);

  // 앱이 결제 도중 꺼졌던 경우 backup 으로 마지막 결과 복구.
  await recoverBackupIfAny().catch((err) => {
    console.error("[edusyncpro-front] backup 복구 실패:", err);
  });

  sdk.template.renderIdlePage();
  running = true;
  scheduleNextPoll();
}

async function recoverBackupIfAny() {
  const backup = await sdk.payment.getBackupPaymentKey();
  if (!backup) return;
  const result = await sdk.payment.getPayment({ paymentKey: backup });
  if (result && result.type === "SUCCESS") {
    // 서버는 dispatchId 를 몰라도 confirmPayment 만으로 원장에 반영한다 (idempotent).
    await confirmPaymentFromSdk(result.response).catch((err) => {
      console.error("[edusyncpro-front] backup confirm 실패:", err);
    });
  } else if (result && (result.type === "CANCELED" || result.type === "TIMEOUT" || result.type === "FAILED")) {
    // 결제 실패 backup 은 서버에 굳이 알릴 필요 없다 (dispatch 는 서버 타이머로 만료됨).
  }
  await sdk.payment.resetBackupPaymentKey();
}

function scheduleNextPoll() {
  if (!running) return;
  setTimeout(pollOnce, POLL_INTERVAL_MS);
}

async function pollOnce() {
  if (!running) return;
  if (busy) {
    scheduleNextPoll();
    return;
  }
  try {
    const { pending } = await fetchPendingDispatch();
    if (pending) {
      busy = true;
      try {
        await handleDispatch(pending);
      } finally {
        busy = false;
        sdk.template.renderIdlePage();
      }
    }
  } catch (err) {
    console.error("[edusyncpro-front] 폴링 오류:", err);
  } finally {
    scheduleNextPoll();
  }
}

async function handleDispatch(d: PendingDispatch) {
  // DELIVERED 표시. 이 단계에서 서버 실패는 무시하지 않는다 —
  // ack 못 하면 다른 단말이 같은 dispatch 를 잡을 수도 있으니 중단이 안전하다.
  await ackDispatch(d.dispatchId);

  // 즉시 결제창. 확인 버튼 없이 바로 카드 프롬프트.
  let result: PaymentResult;
  try {
    result = await sdk.payment.requestPayment({
      paymentKey: d.paymentKey,
      orderId: d.orderId,
      amount: d.amount,
      orderName: d.orderName,
    });
  } catch (err: any) {
    await reportDispatchResult(d.dispatchId, {
      status: "FAILED",
      reason: err?.message ?? String(err),
    }).catch(() => {});
    await cancelPayment(d.paymentKey, "sdk exception").catch(() => {});
    return;
  }

  if (result.type === "SUCCESS") {
    // 서버 원장 반영 → dispatch APPROVED 는 confirmPayment 내부에서 함께 처리된다.
    await confirmPaymentFromSdk(result.response);
    // confirmPayment 성공 후 명시적으로 결과도 통지 (SSE 알림·통계용).
    await reportDispatchResult(d.dispatchId, { status: "APPROVED" }).catch(() => {});
    return;
  }
  if (result.type === "CANCELED") {
    await reportDispatchResult(d.dispatchId, {
      status: "CANCELED",
      reason: result.reason,
    }).catch(() => {});
    await cancelPayment(d.paymentKey, result.reason ?? "user cancel").catch(() => {});
    return;
  }
  if (result.type === "TIMEOUT") {
    await reportDispatchResult(d.dispatchId, {
      status: "TIMEOUT",
      reason: result.reason,
    }).catch(() => {});
    await cancelPayment(d.paymentKey, "timeout").catch(() => {});
    return;
  }
  // FAILED
  await reportDispatchResult(d.dispatchId, {
    status: "FAILED",
    reason: (result as any).message ?? (result as any).code,
  }).catch(() => {});
  await cancelPayment(d.paymentKey, "sdk failed").catch(() => {});
}

async function confirmPaymentFromSdk(r: PaymentResponseSuccess) {
  await confirmPayment({
    paymentKey: r.paymentKey,
    orderId: r.orderId,
    amount: r.amount,
    paymentMethod: r.paymentMethod,
    approvalNumber: r.approvalNumber ?? r.card?.approveNo ?? "",
    approvedTimestamp: r.approvedAt,
    van: r.van ?? null,
    tid: r.tid ?? null,
    vanTransactionKey: r.vanTransactionKey ?? null,
    maskedCardNumber: r.card?.number ?? null,
    issuerName: r.card?.issuerName ?? null,
    acquirerName: r.card?.acquirerName ?? null,
    cardType: r.card?.cardType ?? null,
    installment: r.card?.installmentMonths ?? 0,
    rawResponse: r.raw,
  });
}

// SDK 부팅 훅. 매니페스트에서 이 심볼을 진입점으로 지정한다.
(globalThis as any).__eduSyncPluginBootstrap = bootstrap;
