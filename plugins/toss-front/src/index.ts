/**
 * EduSyncPro Toss Front 2 플러그인 — "결제 단말기 모드".
 *
 * 이 단말기는 학생 검색·청구서 선택 UI가 없다. 학원 카운터 옆 태블릿 웹
 * (/student-kiosk) 이 학생과 청구서를 골라 서버에 dispatch 를 만들어 두고,
 * 이 단말기는 그 dispatch 를 pickup 해서 결제창만 띄운다.
 *
 * ── 0.3.0 에서 고친 것 ──
 *   0.2.x 는 `declare const sdk` 로 SDK 를 "선언만" 하고 런타임 바인딩을 하지 않았다.
 *   그래서 bootstrap 첫 줄에서 ReferenceError 가 나고 화면은 검은 배경만 남았으며,
 *   모든 실패가 console.error 로 사라져 단말기 로그 서버에는 연결 로그만 보였다.
 *   이제 sdk.ts 가 런타임에 전역을 찾고, logger.ts 가 라이프사이클을 서버로 올리며,
 *   screen.ts 가 유휴/진행/실패 화면을 반드시 그린다.
 *
 * 동작 요약:
 *   1) 부팅 → SDK 탐색 → deviceKey 확인 → 서버 연결 확인 → backup 복구 → 유휴 화면
 *   2) 1초마다 /api/toss-front/dispatch/pending 폴링 (busy 시 skip)
 *   3) PENDING 이 있으면 ackDispatch → sdk.payment.requestPayment(...)
 *   4) result.type 에 따라 서버에 APPROVED / CANCELED / TIMEOUT / FAILED 통지
 *   5) 유휴 화면 복귀 → 다시 폴링
 *
 * 동시성 보장:
 *   - inFlight: 폴링 요청이 아직 응답 오지 않았으면 다음 tick 을 건너뛴다
 *   - busy: 결제창이 떠 있는 동안 폴링 자체를 잠근다
 *   - handledPaymentKeys: 같은 paymentKey 로 requestPayment 를 두 번 부르지 않는다
 *   - 서버 측 ack 는 조건부 UPDATE(PENDING→DELIVERED) 라 단말기가 둘이어도 하나만 집어간다
 */

import {
  SERVER_URL,
  setDeviceKey,
  pingServer,
  fetchPendingDispatch,
  ackDispatch,
  reportDispatchResult,
  confirmPayment,
  cancelPayment,
  type PendingDispatch,
} from "./api";
import {
  configureLogger,
  installGlobalErrorHandlers,
  log,
  setLogDeviceId,
} from "./logger";
import {
  findSdk,
  waitForSdk,
  renderIdle,
  storage,
  type PaymentResponseSuccess,
  type PaymentResult,
  type TossFrontSdk,
} from "./sdk";
import { showIdle, showBusy, showFatal, pushDiagLine, clearOwnScreen } from "./screen";

// ─── 상태 ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 1000;
const PAYMENT_TIMEOUT_MS = 60_000;
const DEVICE_KEY_STORAGE = "deviceKey";

let sdk: TossFrontSdk | null = null;
let running = false;
let busy = false;            // 결제창이 떠 있는 동안 폴링 잠금
let inFlight = false;        // 이미 fetchPendingDispatch 가 답을 기다리는 중인지
let consecutivePollErrors = 0;
const handledPaymentKeys = new Set<string>();

/** SDK 유휴화면이 있으면 그걸 쓰고, 없으면 자체 대기화면을 그린다. */
function goIdle() {
  renderIdle(sdk, () => showIdle());
  if (sdk?.template?.renderIdlePage) clearOwnScreen();
}

// ─── 부팅 ──────────────────────────────────────────────────────────────

export async function bootstrap() {
  configureLogger({ serverUrl: SERVER_URL, onScreen: (line) => pushDiagLine(line) });
  installGlobalErrorHandlers();

  log.info("plugin entry started", `version=0.3.0 server=${SERVER_URL}`);

  // 1) SDK 확보. 못 찾으면 결제는 불가능하지만, 화면과 로그는 계속 살려 둔다.
  //    (여기서 return 해 버리면 다시 "아무 단서 없는 화면"이 된다)
  showIdle();
  sdk = await waitForSdk(10_000);
  if (!sdk) {
    showFatal(
      "결제 단말기 연결 실패",
      "Toss Front SDK를 찾지 못했습니다. 단말기를 재시작하거나 플러그인을 다시 설치해 주세요."
    );
    log.error("terminal auth started 이전 중단", new Error("SDK 없음"), "결제 기능을 비활성화합니다.");
    await log.flushNow();
    return;
  }

  // 2) merchant / deviceKey 로드
  log.info("merchant loaded", "단말기 저장소에서 deviceKey를 읽습니다.");
  const key = await storage.getItem(sdk, DEVICE_KEY_STORAGE);
  if (!key) {
    showFatal(
      "단말기 등록 필요",
      "이 단말기에 EduSyncPro 등록 코드가 없습니다. 원장 화면 → Toss Front 에서 단말기를 발급한 뒤 등록해 주세요."
    );
    log.error("deviceKey 미설정", new Error("deviceKey 없음"), "관리자에서 단말기 등록이 필요합니다.");
    await log.flushNow();
    goIdle();
    return;
  }
  setDeviceKey(key);

  // 3) 서버 세션 발급 = 단말기 인증
  log.info("terminal auth started", "EduSyncPro 서버에 장치 세션을 요청합니다.");
  try {
    const device = await pingServer();
    setLogDeviceId(device.id);
    log.info("terminal authenticated", `device=${device.displayName}`);
    log.info("backend connection OK", `${SERVER_URL} 응답 정상`);
  } catch (err) {
    showFatal(
      "서버 연결 실패",
      "EduSyncPro 서버에 연결하지 못했습니다. 단말기 인터넷 연결과 등록 코드를 확인해 주세요."
    );
    log.error("backend connection 실패", err, "세션 발급 단계에서 중단되었습니다.");
    await log.flushNow();
    // 연결이 끊겼어도 폴링은 계속 돌린다. 네트워크가 돌아오면 스스로 복구된다.
  }

  // 4) 앱이 결제 도중 꺼졌던 경우 backup 으로 마지막 결과 복구
  await recoverBackupIfAny().catch((err) => {
    log.error("backup 복구 실패", err, "미확정 승인이 남아 있을 수 있습니다.");
  });

  goIdle();
  running = true;
  log.info("polling started", `간격=${POLL_INTERVAL_MS}ms`);
  log.info("waiting payment intent", "학생 태블릿의 결제 요청을 기다립니다.");
  scheduleNextPoll();
}

/**
 * 앱이 승인 직후 꺼져서 서버에 결과를 못 올린 경우를 복구한다.
 * 순서: getBackupPaymentKey → getPayment → 서버 confirm → resetBackupPaymentKey.
 * SDK 가 이 메서드들을 제공하지 않으면 조용히 건너뛴다 (없는 API 를 만들어 부르지 않는다).
 */
async function recoverBackupIfAny() {
  if (!sdk) return;
  const p = sdk.payment;
  if (typeof p.getBackupPaymentKey !== "function" || typeof p.getPayment !== "function") {
    log.info("backup 복구 건너뜀", "SDK가 backup 조회 API를 제공하지 않습니다.");
    return;
  }

  const backup = await p.getBackupPaymentKey();
  if (!backup) {
    log.info("backup 없음", "복구할 미확정 결제가 없습니다.");
    return;
  }
  log.warn("backup 발견", "미확정 결제를 복구합니다.");

  const result = await p.getPayment({ paymentKey: backup });
  if (result && result.type === "SUCCESS") {
    try {
      await confirmPaymentFromSdk(result.response);
      handledPaymentKeys.add(result.response.paymentKey);
      log.info("backup 복구 완료", "승인 결과를 서버 원장에 반영했습니다.");
    } catch (err) {
      // 서버 confirm 이 실패하면 backup 을 지우지 않는다 — 다음 부팅에서 재시도할 수 있다.
      log.error("backup confirm 실패", err, "backup을 유지하고 다음 부팅에서 재시도합니다.");
      return;
    }
  }
  if (typeof p.resetBackupPaymentKey === "function") {
    await p.resetBackupPaymentKey();
  }
}

// ─── 폴링 ──────────────────────────────────────────────────────────────

function scheduleNextPoll() {
  if (!running) return;
  setTimeout(pollOnce, POLL_INTERVAL_MS);
}

async function pollOnce() {
  if (!running) return;
  if (busy || inFlight) {
    scheduleNextPoll();
    return;
  }
  inFlight = true;
  try {
    const { pending } = await fetchPendingDispatch();

    if (consecutivePollErrors > 0) {
      log.info("backend connection 복구", `연속 실패 ${consecutivePollErrors}회 뒤 정상화되었습니다.`);
      consecutivePollErrors = 0;
      goIdle();
    }

    if (pending && !handledPaymentKeys.has(pending.paymentKey)) {
      handledPaymentKeys.add(pending.paymentKey);
      busy = true;
      log.info(
        "payment intent 수신",
        `dispatch=${pending.dispatchId} 금액=${pending.amount}원 주문=${pending.orderName}`
      );
      try {
        await handleDispatch(pending);
      } finally {
        busy = false;
        goIdle();
        log.info("waiting payment intent", "다음 결제 요청을 기다립니다.");
      }
    }
  } catch (err) {
    consecutivePollErrors += 1;
    // 매 초 같은 오류를 500줄씩 올리면 로그가 쓸모없어진다. 처음 3회와 이후 30회마다만 남긴다.
    if (consecutivePollErrors <= 3 || consecutivePollErrors % 30 === 0) {
      log.error("폴링 오류", err, `연속 실패 ${consecutivePollErrors}회`);
    }
    if (consecutivePollErrors === 5) {
      showFatal(
        "서버 연결 끊김",
        "EduSyncPro 서버와 통신하지 못하고 있습니다. 인터넷 연결을 확인해 주세요. 연결되면 자동으로 복구됩니다."
      );
    }
  } finally {
    inFlight = false;
    scheduleNextPoll();
  }
}

// ─── 결제 처리 ─────────────────────────────────────────────────────────

async function handleDispatch(d: PendingDispatch) {
  if (!sdk) {
    log.error("결제 불가", new Error("SDK 없음"), `dispatch=${d.dispatchId}`);
    await reportDispatchResult(d.dispatchId, { status: "FAILED", reason: "sdk unavailable" }).catch(
      () => {}
    );
    return;
  }

  // ack 못 하면 다른 단말이 같은 dispatch 를 잡을 수도 있으니 실패 시 중단한다.
  try {
    await ackDispatch(d.dispatchId);
    log.info("dispatch ack", `dispatch=${d.dispatchId} DELIVERED 로 표시했습니다.`);
  } catch (err) {
    log.error("dispatch ack 실패", err, `dispatch=${d.dispatchId} — 결제창을 띄우지 않습니다.`);
    return;
  }

  showBusy(d.orderName, d.amount);

  let result: PaymentResult;
  try {
    log.info("requestPayment 호출", `금액=${d.amount} 공급가=${d.supplyValue} 세액=${d.tax}`);
    result = await sdk.payment.requestPayment({
      paymentKey: d.paymentKey,
      tax: d.tax,
      supplyValue: d.supplyValue,
      taxExemptValue: d.taxExemptValue,
      tip: d.tip,
      timeoutMs: PAYMENT_TIMEOUT_MS,
      localeCode: "ko",
      excludePaymentTypes: ["CASH"],
    });
  } catch (err: any) {
    log.error("requestPayment 예외", err, `dispatch=${d.dispatchId}`);
    await reportDispatchResult(d.dispatchId, {
      status: "FAILED",
      reason: err?.message ?? String(err),
    }).catch(() => {});
    await cancelPayment(d.paymentKey, "sdk exception").catch(() => {});
    return;
  }

  if (result.type === "SUCCESS") {
    log.info("결제 승인", `승인번호=${result.response.approvalNumber ?? "-"} 금액=${result.response.amount}`);
    try {
      await confirmPaymentFromSdk(result.response);
      log.info("원장 반영 완료", "수납 내역에 기록했습니다.");
    } catch (err) {
      // 승인은 났는데 서버 기록이 실패한 경우. 가장 위험한 상태라 강하게 남긴다.
      log.error(
        "승인 후 원장 반영 실패",
        err,
        "카드 승인은 완료되었으나 수납 기록이 실패했습니다. 원장 확인이 필요합니다."
      );
    }
    await reportDispatchResult(d.dispatchId, { status: "APPROVED" }).catch(() => {});
    return;
  }

  if (result.type === "CANCELED") {
    log.info("결제 취소", result.reason ?? "사용자 취소");
    await reportDispatchResult(d.dispatchId, { status: "CANCELED", reason: result.reason }).catch(
      () => {}
    );
    await cancelPayment(d.paymentKey, result.reason ?? "user cancel").catch(() => {});
    return;
  }

  if (result.type === "TIMEOUT") {
    log.warn("결제 시간초과", result.reason ?? `${PAYMENT_TIMEOUT_MS}ms 초과`);
    await reportDispatchResult(d.dispatchId, { status: "TIMEOUT", reason: result.reason }).catch(
      () => {}
    );
    await cancelPayment(d.paymentKey, "timeout").catch(() => {});
    return;
  }

  // FAILED
  const failMsg = (result as any).message ?? (result as any).code ?? "알 수 없는 실패";
  log.error("결제 실패", new Error(failMsg), `dispatch=${d.dispatchId}`);
  await reportDispatchResult(d.dispatchId, { status: "FAILED", reason: failMsg }).catch(() => {});
  await cancelPayment(d.paymentKey, "sdk failed").catch(() => {});
}

async function confirmPaymentFromSdk(r: PaymentResponseSuccess) {
  await confirmPayment({
    paymentKey: r.paymentKey,
    orderId: r.orderId ?? "",
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

// ─── 진입 ──────────────────────────────────────────────────────────────

// SDK 부팅 훅. 매니페스트가 이 심볼을 진입점으로 지정할 수 있다.
(globalThis as any).__eduSyncPluginBootstrap = bootstrap;

// 브라우저 window 로드 시 자동 부팅.
// bootstrap 이 던지는 예외는 반드시 화면과 서버 양쪽에 남긴다 — 0.2.x 는 여기서 증거가 사라졌다.
if (typeof window !== "undefined") {
  const start = () => {
    bootstrap().catch((err) => {
      configureLogger({ serverUrl: SERVER_URL, onScreen: (line) => pushDiagLine(line) });
      log.error("bootstrap 실패", err, "플러그인을 시작하지 못했습니다.");
      showFatal("플러그인 시작 실패", "관리자에게 문의해 주세요. 자세한 내용은 아래 로그를 확인하세요.");
      void log.flushNow();
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}

export { findSdk };
