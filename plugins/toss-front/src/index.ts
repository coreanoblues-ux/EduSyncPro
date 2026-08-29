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
  exchangePairing,
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
  type IdlePageParams,
  type PaymentResponseSuccess,
  type PaymentResult,
  type TossFrontSdk,
} from "./sdk";
import {
  showIdle,
  showBusy,
  showFatal,
  pushDiagLine,
  clearOwnScreen,
  showPairing,
  showReceiptChoice,
  showReceiptResult,
} from "./screen";

// ─── 버전 ──────────────────────────────────────────────────────────────
// vite.config.ts 가 package.json 의 version 을 여기에 주입한다 (define).
// 단말기 화면 첫 줄에 찍히므로, 새 ZIP 이 실제로 반영됐는지 이 값으로 확인한다.
declare const __PLUGIN_VERSION__: string;
const PLUGIN_VERSION =
  typeof __PLUGIN_VERSION__ === "string" ? __PLUGIN_VERSION__ : "unknown";

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

/** 단말기에 등록된 상점명. 대기화면 제목에 쓴다. 못 읽으면 빈 문자열. */
let merchantName = "";

/**
 * 대기화면에 뭘 띄울지.
 *
 * 원장 지적: 대기화면이 "빈 화면에 빨간 IP 주소"뿐이었다. 그건 renderIdlePage 를
 * 인자 없이 불러서 나온 Toss 기본(default) 화면이다. 이제 문구를 넣어 그린다.
 *
 * 버튼을 "새로고침"으로 두지 않은 이유:
 *   폴링이 이미 1초마다 돈다. 새로고침 버튼은 아무것도 앞당기지 못하면서 누르면
 *   뭔가 될 것 같은 착각만 준다. 대신 단말기 앞에 선 사람이 실제로 궁금해하는 것
 *   — "이게 서버랑 붙어 있긴 한가" — 에 답한다. 단말기에는 개발자도구가 없어서
 *   이 정보를 볼 방법이 달리 없다.
 */
function idleParams(): IdlePageParams {
  return {
    type: "oneButton",
    description: {
      text: merchantName ? `${merchantName} 수강료 결제` : "수강료 결제",
      subText: "태블릿에서 학생을 선택하면 이 화면에 결제 금액이 표시됩니다.",
    },
    button: {
      text: "단말기 상태",
      subText: "연결이 잘 되어 있는지 확인합니다",
      onClick: () => showTerminalStatus(),
    },
  };
}

/** 대기화면 버튼을 눌렀을 때. 결제에는 일절 관여하지 않는 읽기 전용 동작이다. */
function showTerminalStatus() {
  const connected = consecutivePollErrors === 0;
  const message = connected
    ? `정상 연결됨 · v${PLUGIN_VERSION}`
    : `서버 연결 끊김 (연속 실패 ${consecutivePollErrors}회) · v${PLUGIN_VERSION}`;

  log.info("대기화면 상태 확인", message);

  // openToast 가 없는 펌웨어면 자체 진단 줄로 대체한다. 버튼을 눌렀는데
  // 아무 반응이 없는 것이 제일 나쁘다.
  if (sdk?.template?.openToast) {
    try {
      sdk.template.openToast({ message });
      return;
    } catch (err) {
      log.warn("openToast 실패", describeErr(err));
    }
  }
  pushDiagLine(message);
}

/** SDK 유휴화면이 있으면 그걸 쓰고, 없으면 자체 대기화면을 그린다. */
function goIdle() {
  renderIdle(sdk, () => showIdle(), idleParams());
  if (sdk?.template?.renderIdlePage) clearOwnScreen();
}

// ─── 부팅 ──────────────────────────────────────────────────────────────

export async function bootstrap() {
  configureLogger({ serverUrl: SERVER_URL, onScreen: (line) => pushDiagLine(line) });
  installGlobalErrorHandlers();

  log.info("plugin entry started", `version=${PLUGIN_VERSION} server=${SERVER_URL}`);

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
  //
  //    ── 0.3.1 에서 바뀐 것 ──
  //      0.3.0 은 deviceKey 가 없으면 그냥 치명적 화면을 띄우고 멈췄다. 하지만 실제로는
  //      "단말기에 어떻게 deviceKey 를 넣지?" 자체가 명시된 적이 없었다 (Toss 는 plugin bundle
  //      에 env 를 주입해 주지 않고, 매니페스트의 envRequired 는 참고 정보일 뿐이다).
  //      공식 template 의 onboarding 예제(sdk.template.renderOnboardingPage + sdk.storage.set)
  //      와 동일한 패턴으로, 첫 부팅 때 원장이 관리자 화면에서 발급받은 raw deviceKey 를
  //      한 번만 입력하면 이후 재부팅에서도 sdk.storage 에 남는다.
  log.info("merchant loaded", "단말기 저장소에서 deviceKey를 읽습니다.");
  let key = await storage.getItem(sdk, DEVICE_KEY_STORAGE);
  if (!key) {
    log.warn("deviceKey 미설정", "온보딩 화면으로 이동합니다. 관리자에서 발급한 등록 코드를 입력받습니다.");
    try {
      key = await runPairingFlow();
    } catch (err) {
      log.error("페어링 실패", err, "onboarding 을 완료하지 못했습니다.");
      // 원인을 그대로 화면에 띄운다.
      //
      // 0.3.3 은 여기서 "코드가 잘못됐거나 서버에 연결하지 못했습니다" 라는 한 문장만
      // 보여 줬다. 그런데 그 둘은 현장에서 해야 할 일이 완전히 다르다 — 하나는 코드를
      // 다시 받는 것이고, 다른 하나는 개발자센터 허용 도메인을 고치는 것이다. 실제로
      // 이 문장 때문에 원인을 찾는 데 하루가 걸렸다. 진단은 단말기 앞에 선 사람이
      // 읽을 수 있어야 한다.
      showFatal("단말기 등록 실패", humanErr(err));
      await log.flushNow();
      return;
    }
    await storage.setItem(sdk, DEVICE_KEY_STORAGE, key);
    log.info("페어링 완료", "deviceKey 를 단말기 저장소에 저장했습니다.");
  }
  setDeviceKey(key);

  // 참조용 시리얼 번호 로깅. 이후 사고 발생 시 서버 로그에서 어느 물리 단말인지 매칭 가능.
  try {
    if (sdk.app?.getSerialNumber) {
      const { serialNumber } = await sdk.app.getSerialNumber();
      log.info("device serial", serialNumber ?? "(unknown)");
    }
  } catch (err) {
    log.warn("getSerialNumber 실패", describeErr(err));
  }

  // 상점명은 대기화면 제목으로 쓴다. 실패해도 그냥 넘어간다 —
  // 이름이 없으면 "수강료 결제" 로 떨어질 뿐, 결제와는 무관하다.
  try {
    if (sdk.app?.getMerchant) {
      const merchant = await sdk.app.getMerchant();
      merchantName = merchant?.name ?? "";
      log.info("merchant name", merchantName || "(이름 없음)");
    }
  } catch (err) {
    log.warn("getMerchant 실패", describeErr(err));
  }

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

    // ── 영수증 자동 출력 (승인·원장반영·dispatch 마킹이 모두 끝난 뒤에만 진입) ──
    //
    // 여기서 어떤 예외가 나도 결제는 이미 확정 상태다. 프린터 관련 실패는
    // 절대 위로 전파시키지 않는다. try/catch 로 봉인하고 로그만 남긴다.
    // 부분결제의 경우 한 dispatch = 한 카드 승인 = 한 paymentKey 이므로,
    // 이 흐름은 각 카드 승인마다 독립적으로 한 번씩 돌며 각기 다른 영수증을 뽑는다.
    try {
      await promptReceiptPrintAfterApproval(result.response.paymentKey);
    } catch (err) {
      log.error(
        "영수증 흐름 예외 (무시)",
        err,
        "결제와 원장 반영은 이미 완료되었습니다. 영수증 흐름 오류는 결제 상태에 영향을 주지 않습니다."
      );
    }
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

// ─── 영수증 출력 (승인 이후 부가 단계) ───────────────────────────────

/**
 * 승인 완료 후 영수증 선택 화면을 띄우고, 결정에 따라 프린터를 호출한다.
 *
 * 사양 요약:
 *   - 8초 카운트다운을 표시한다.
 *   - 사용자가 "영수증 출력" 을 누르면 즉시 printReceipt 1회.
 *   - "영수증 생략" 을 누르면 프린터를 호출하지 않고 종료.
 *   - 아무것도 안 누르고 8초가 지나면 자동으로 printReceipt 1회.
 *   - 위 세 진입점 중 최초 하나만 실제로 프린터를 호출한다 (중복 출력 방지).
 *
 * 이중 안전 guard:
 *   1) 이 함수의 로컬 `printCalledForThisPayment` 플래그 — race 시 최종 방어선.
 *   2) screen.showReceiptChoice 내부의 `decided` 플래그 — UI 이벤트 자체를 잠근다.
 *
 * 이 함수는 예외를 밖으로 던지지 않는다. 프린터가 없거나 실패해도 결제 상태는
 * 이미 확정이므로 로그만 남기고 조용히 종료. resolve 는 항상 발생한다.
 */
async function promptReceiptPrintAfterApproval(paymentKey: string): Promise<void> {
  // 최종 방어선: 같은 paymentKey 에 대해 이번 흐름에서 printReceipt 는 최대 1회.
  let printCalledForThisPayment = false;

  return new Promise<void>((resolve) => {
    const doPrint = async (trigger: "user" | "timeout") => {
      if (printCalledForThisPayment) {
        // race 로 두 경로가 거의 동시에 진입해도 여기서 컷.
        log.info("영수증 중복 호출 방지", `paymentKey=${paymentKey} trigger=${trigger} 이미 처리됨`);
        resolve();
        return;
      }
      printCalledForThisPayment = true;
      log.info("영수증 출력 요청", `paymentKey=${paymentKey} trigger=${trigger}`);

      if (!sdk?.printer || typeof sdk.printer.printReceipt !== "function") {
        // 프린터 미도착·구형 펌웨어 등. 결제 성공에는 영향 없음.
        log.warn(
          "printer.printReceipt 미지원",
          "SDK 에 printer 모듈이 없습니다. 실제 프린터가 연결된 뒤에 재검증합니다."
        );
        showReceiptResult("fail", "결제는 정상적으로 완료되었습니다. 프린터를 사용할 수 없습니다.");
        resolve();
        return;
      }

      try {
        await sdk.printer.printReceipt({ paymentKey, count: 1 });
        log.info("영수증 출력 완료", `paymentKey=${paymentKey}`);
        // 성공 시 별도 안내 화면을 오래 띄우지 않는다. 유휴 복귀가 자연스럽다.
      } catch (err) {
        // 종이 없음 / 프린터 오프라인 / 권한 거부 등. 결제 상태와 완전히 분리.
        log.error(
          "영수증 출력 실패",
          err,
          "카드 승인·원장 반영은 이미 완료된 상태이며 이 오류는 결제에 영향을 주지 않습니다."
        );
        showReceiptResult("fail", "결제는 정상적으로 완료되었습니다. 영수증 출력에 실패했습니다.");
      }
      resolve();
    };

    const doSkip = () => {
      if (printCalledForThisPayment) {
        // 이미 프린터를 부른 뒤라면 skip 은 무시 (사실상 도달 불가한 방어).
        resolve();
        return;
      }
      // 사용자 명시 생략 — printCalledForThisPayment 는 켜지 않는다 (프린터를 안 부름).
      // 이후 timeout 콜백이 뒤늦게 들어와도 screen 내부 decided guard 가 이미 잠갔다.
      log.info("영수증 생략", `paymentKey=${paymentKey} 사용자가 생략을 선택`);
      resolve();
    };

    showReceiptChoice({
      autoPrintMs: 8_000,
      onPrint: () => {
        void doPrint("user");
      },
      onSkip: () => {
        doSkip();
      },
      onTimeout: () => {
        void doPrint("timeout");
      },
    });
  });
}

// ─── 페어링 (onboarding) ─────────────────────────────────────────────

/**
 * 첫 부팅 페어링 흐름.
 *
 * 0.3.2 에서 바뀐 것:
 *   0.3.1 은 44자 raw deviceKey 를 태블릿 온보딩에 직접 붙여넣는 방식이었는데,
 *   현장에서 오타·공백·개행 삽입으로 실패가 잦았다. 공식 template `onboarding.html`
 *   의 패턴(이메일/비번 정도의 짧은 자격증명만 사람이 치고, 긴 문자열은 서버가 응답으로
 *   내려준 뒤 sdk.storage.set 으로 자동 저장) 을 따라 다음과 같이 바꿈:
 *
 *     1) 사용자는 6자 매장코드 + 4자리 PIN 만 입력
 *     2) 플러그인이 sdk.app.getSerialNumber() 로 단말 시리얼을 자동 첨부
 *     3) POST /api/toss-front/devices/exchange 로 { code, pin, serialNumber } 전송
 *     4) 서버가 raw deviceKey 를 응답 → 그 값으로 pingServer() 로 세션 검증
 *     5) 검증 성공 시에만 sdk.storage 에 저장. 실패면 다음 부팅에서 화면이 다시 뜬다.
 */
async function runPairingFlow(): Promise<string> {
  // 사전에 시리얼 번호를 확보. 없으면(개발 오버라이드 등) 빈 문자열 대신 '000000000000000' 를 쓴다.
  let serialNumber = "";
  try {
    if (sdk?.app?.getSerialNumber) {
      const r = await sdk.app.getSerialNumber();
      serialNumber = (r?.serialNumber ?? "").trim();
    }
  } catch (err) {
    log.warn("페어링: getSerialNumber 실패", describeErr(err));
  }
  if (!serialNumber) {
    // 공식 sdk.js 개발 오버라이드도 이 값을 씀. 서버는 min(1) 만 검사하므로 통과된다.
    serialNumber = "000000000000000";
    log.warn("페어링: serialNumber 미확인", "임시로 '000000000000000' 를 사용합니다.");
  }
  log.info("페어링 준비", `serialNumber=${serialNumber}`);

  const attempt = async (pairingCode: string, pin: string): Promise<string> => {
    const { deviceKey: rawKey, device: enrolled } = await exchangePairing({
      pairingCode,
      pin,
      serialNumber,
    });
    log.info("exchange 성공", `device=${enrolled.displayName}, deviceKey 수신 완료`);
    setDeviceKey(rawKey);
    // pingServer 는 /session 발급 + /dispatch/pending 한번 두드리기까지 수행한다.
    const device = await pingServer();
    setLogDeviceId(device.id);
    log.info("페어링 검증 성공", `device=${device.displayName}`);
    return rawKey;
  };

  const validate = (values: { pairingCode?: string; pin?: string }): string | null => {
    const code = String(values.pairingCode ?? "").trim().toUpperCase();
    const pin = String(values.pin ?? "").trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) return "매장 코드는 6자 (영문 대문자·숫자) 여야 합니다.";
    if (!/^\d{4}$/.test(pin)) return "PIN은 4자리 숫자여야 합니다.";
    return null;
  };

  // 공식 SDK 의 renderOnboardingPage 가 있으면 그걸 쓰고, 없으면 자체 화면으로 폴백.
  //
  // ── 0.3.5 에서 바뀐 것 ──
  //   0.3.4 까지는 renderOnboardingPage 가 "존재하지만 던지는" 경우를 폴백으로 치지
  //   않고 그대로 실패시켰다. 실제로 React #299 로 이 함수가 터졌고, 그 순간 단말기는
  //   등록할 방법이 아예 없는 상태가 됐다. SDK 화면이 안 되면 우리 화면으로라도
  //   등록은 되어야 한다. 화면 하나 때문에 단말기를 못 쓰는 건 과한 대가다.
  const t = sdk?.template as any;
  if (t && typeof t.renderOnboardingPage === "function") {
    try {
      // 우리 대기화면은 position:fixed 전체화면이라 그대로 두면 SDK 화면을 덮는다.
      // 넘겨주기 전에 먼저 치운다.
      clearOwnScreen();
      return await new Promise<string>((resolve, reject) => {
      try {
        t.renderOnboardingPage({
          title: "EduSyncPro 단말기 등록",
          inputs: {
            pairingCode: {
              label: "매장 코드 (6자)",
              type: "text",
              placeholder: "예: A2K7ZM",
            },
            pin: {
              label: "PIN (4자리)",
              type: "password",
              placeholder: "예: 4837",
            },
          },
          onSubmit: async (values: any) => {
            const msg = validate(values);
            if (msg) throw new Error(msg);
            const code = String(values.pairingCode).trim().toUpperCase();
            const pin = String(values.pin).trim();
            try {
              const ok = await attempt(code, pin);
              resolve(ok);
            } catch (e) {
              log.error("페어링 검증 실패", e, "다시 입력받습니다.");
              throw e; // Toss template 은 이 예외를 폼에 표시해 준다.
            }
          },
        });
      } catch (err) {
        reject(err);
      }
      });
    } catch (err) {
      // 취소는 사용자의 의사이므로 폴백하지 않고 그대로 올린다.
      if (err instanceof Error && /취소/.test(err.message)) throw err;
      log.warn(
        "SDK 온보딩 화면 실패 — 자체 화면으로 대체합니다",
        describeErr(err)
      );
      clearOwnScreen();
    }
  }

  // Fallback: 자체 온보딩 폼.
  return await new Promise<string>((resolve, reject) => {
    showPairing({
      title: "단말기 등록",
      subtitle:
        "원장 화면 → Toss Front → 새 단말기 발급을 누르면 매장 코드와 PIN이 뜹니다. 두 값을 아래에 입력하세요.",
      submitLabel: "등록",
      inputs: [
        {
          name: "pairingCode",
          label: "매장 코드 (6자)",
          placeholder: "예: A2K7ZM",
          type: "text",
          uppercase: true,
          maxLength: 6,
        },
        {
          name: "pin",
          label: "PIN (4자리 숫자)",
          placeholder: "예: 4837",
          type: "tel",
          maxLength: 4,
        },
      ],
      onSubmit: async (values) => {
        const msg = validate(values);
        if (msg) return msg;
        const code = String(values.pairingCode).trim().toUpperCase();
        const pin = String(values.pin).trim();
        try {
          const ok = await attempt(code, pin);
          resolve(ok);
          return null;
        } catch (e: any) {
          log.error("페어링 검증 실패", e, "다시 입력받습니다.");
          return e?.message ? String(e.message).slice(0, 200) : "등록 실패. 매장코드와 PIN을 확인해 주세요.";
        }
      },
      onCancel: () => reject(new Error("사용자가 온보딩을 취소했습니다.")),
    });
  });
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try { return String(err); } catch { return "알 수 없는 오류"; }
}

/**
 * 단말기 화면에 띄울 문장. describeErr 과 달리 "ApiError:" 같은 클래스 이름을 뗀다.
 * 화면 앞에 선 사람은 원장이나 강사지 개발자가 아니다. 진단 문자열은 로그가 맡는다.
 */
function humanErr(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return describeErr(err);
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
