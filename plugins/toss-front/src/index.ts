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
  reportRecoveryNotFound,
  ackDispatch,
  reportDispatchResult,
  confirmPayment,
  cancelPayment,
  exchangePairing,
  ackCancel,
  reportCancelResultRaw,
  type PendingDispatch,
  type PendingCancel,
  type RecoveryRequest,
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
  OUTBOX_KEY,
  addEntry,
  dueEntries,
  isSettled,
  isStale,
  loadOutbox,
  markAttempt,
  removeEntry,
  saveOutbox,
  type ConfirmPayload,
  type OutboxEntry,
  type OutboxStorage,
} from "./outbox";
import {
  addCancelReport,
  cardWasCancelled,
  clearInflight,
  dueCancelReports,
  isCancelReportSettled,
  loadCancelOutbox,
  markCancelAttempt,
  markInflight,
  readInflight,
  removeCancelReport,
  saveCancelOutbox,
  type CancelOutboxEntry,
  type CancelReportResult,
} from "./cancelOutbox";
import {
  MAX_REASON_LEN,
  PAYMENT_NOT_FOUND,
  describeFailure,
  errCode,
  errCodeCandidates,
  isPaymentNotFound,
  safeRawSummary,
} from "./sdkError";
import {
  showIdle,
  showAdminMenu,
  showBusy,
  showCancelBusy,
  showFatal,
  showStatus,
  pushDiagLine,
  clearOwnScreen,
  confirmTemplateRendered,
  setScreenVersion,
  showPairing,
  showReceiptChoice,
  showReceiptResult,
  type ScreenAction,
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

/**
 * 아직 서버 원장에 못 올린 승인들. 저장소의 사본을 메모리에 들고 다닌다.
 *
 * 이 배열이 비어 있지 않다는 것은 "카드에서는 돈이 빠져나갔는데 장부에는 아직
 * 없는 건이 있다" 는 뜻이다. 그래서 비울 때까지 계속 재시도한다.
 */
let outbox: OutboxEntry[] = [];
/** flushOutbox 재진입 방지. 폴링(1초)이 이전 flush 를 앞지르지 못하게 한다. */
let flushingOutbox = false;

/**
 * 아직 서버에 못 올린 **취소 결과** 보고들 (0.3.15~).
 *
 * 결제 아웃박스와 목적이 다르다. 저기는 "승인 요청을 다시 보낸다" 이고
 * 여기는 "이미 끝난 취소의 결과를 다시 알린다" 이다. 취소 요청 자체는
 * 무슨 일이 있어도 다시 보내지 않는다 (cancelOutbox.ts 헤더 참고).
 */
let cancelOutbox: CancelOutboxEntry[] = [];
let flushingCancels = false;
/** 같은 취소를 두 번 집지 않는다. 결제의 handledPaymentKeys 와 같은 역할. */
const handledCancelIds = new Set<string>();

/** 단말기에 등록된 상점명. 대기화면 제목에 쓴다. 못 읽으면 빈 문자열. */
let merchantName = "";

/**
 * 원장이 [첫화면으로] 로 나가는 데 성공했는가.
 *
 * ── 이 플래그가 없으면 나가기는 여전히 안 된 것과 같다 ──
 *   폴링 루프는 우리 화면을 스스로 다시 그리는 자리가 두 곳 있다:
 *     · 연결이 끊겼다 복구되면  goIdle()
 *     · 연속 실패 5회가 되면     showFatal()
 *   둘 다 position:fixed·inset:0·z-index 2147483000 짜리 판을 다시 깐다.
 *   즉 원장이 토스 첫화면으로 잘 나갔더라도, 몇 초 뒤 와이파이가 한 번
 *   출렁이면 우리 화면이 그 위를 덮으며 도로 끌고 들어온다. 원장이 신고한
 *   "나갈 방법이 없다" 와 결과가 똑같다.
 *
 *   그래서 나간 뒤에는 폴링이 화면을 건드리지 못하게 막는다. 예외는 하나,
 *   실제 결제요청이 도착했을 때다. 그건 학생이 카드를 대려고 태블릿에서
 *   금액을 띄운 상황이라 단말기가 화면을 되찾는 것이 맞다.
 */
let exitedToHome = false;

/**
 * 대기화면에 뭘 띄울지.
 *
 * ── 왜 oneButton 인가 (2026-08-29, 문서 확인 후 twoButton 에서 변경) ──
 *   원장 질문: "대기 화면이 검정 말고 뭔가 그림이나 디자인이 있고…"
 *
 *   세 타입이 그리는 그림이 서로 다르다는 걸 이제야 확인했다
 *   (docs.tossplace.com/reference/plugin-sdk/front/template.html):
 *
 *     default   — 단말기 "프론트 꾸미기" 배경화면이 전면에 깔리고 하단에 매장명.
 *                 그림은 제일 예쁘지만 버튼이 없다. 인자도 못 넣는다.
 *     oneButton — "기본 대기화면 기능과 동일해요" = 배경화면과 매장명이 그대로
 *                 살아 있고, 그 위에 문구 박스와 버튼 하나가 얹힌다.
 *     twoButton — 흰 배경. 배경화면이 사라진다. 버튼은 둘.
 *
 *   0.3.8 에서 내가 고른 twoButton 은 버튼 두 개를 얻는 대신 배경화면을 통째로
 *   버리는 선택이었다. 그걸 모르고 골랐다. 원장이 원한 "그림 있는 화면"은
 *   배경화면이 살아 있는 쪽이고, 버튼은 하나면 충분하다 — 두 번째 버튼이 하던
 *   일은 아래 관리자 메뉴로 한 단계 내렸다.
 *
 *   배경 그림 자체는 플러그인이 못 바꾼다. renderIdlePage 에는 이미지·색상·테마
 *   파라미터가 아예 없다. 배경은 단말기 설정에서 원장이 직접 고른다.
 *
 *   ⚠️ 설정 진입 동작은 여기 적지 않는다 (0.3.12 정정).
 *      0.3.11 까지 이 자리에 "우측 상단 5회 터치 → 7055" 라고 적혀 있었다.
 *      7055(관리자 PIN)는 맞다 — docs.tossplace.com 의 트러블슈팅 문서가
 *      "설정 → 7055 → 하단 '토스 프론트 재시작'" 이라고 명시한다.
 *      틀린 것은 그 앞의 터치 동작이다. "우측 상단 5회 터치"는 옛 FAQ 방식이고,
 *      Toss 개발자 문서는 설정 진입 동작을 아예 문서화하지 않는다. 즉 이 값은
 *      펌웨어에 따라 바뀌며 코드 주석이 보증할 수 있는 종류가 아니다.
 *      단말기에서 실제로 통하는 동작을 확인한 뒤 태블릿 안내 화면
 *      (client/src/pages/TossFront.tsx) 한 곳에만 적는다. 두 곳에 적으면
 *      한쪽이 반드시 낡는다.
 *
 * 버튼을 "새로고침"으로 두지 않은 이유:
 *   폴링이 이미 1초마다 돈다. 새로고침 버튼은 아무것도 앞당기지 못하면서 누르면
 *   뭔가 될 것 같은 착각만 준다.
 */
function idleParams(): IdlePageParams {
  return {
    type: "oneButton",
    description: {
      text: "태블릿에서 학생을 선택하면 결제 금액이 표시됩니다.",
      subText: "단말기를 직접 누르실 필요는 없습니다.",
    },
    button: {
      text: "관리자",
      subText: "원장님 전용",
      onClick: () => openAdminMenu(),
    },
  };
}

/**
 * 관리자 메뉴. 대기화면의 [관리자] 버튼에서만 들어온다.
 *
 * 대기화면이 oneButton 이 되면서 버튼이 하나로 줄었다. 그래서 "단말기 상태"와
 * "첫화면으로"를 여기 한 단계 아래로 모았다. 결과적으로 더 안전해졌다 —
 * 이 화면은 학원 로비에 서 있고 학생도 만질 수 있는데, 이제 나가기까지
 * 두 번을 눌러야 하고 그 사이에 경고 문구를 읽게 된다.
 *
 * ── 0.3.11 에서 바뀐 것 ──
 *   0.3.10 은 이 메뉴를 공식 템플릿으로만 그렸고, 실패하면 토스트 한 줄을
 *   띄우고 끝냈다. 그런데 이 단말기의 renderIdlePage 는 React 오류를 던진다.
 *   즉 원장 앞의 실물 단말기에서는 관리자 메뉴가 아예 열리지 않았다.
 *   "안 나가고 이유를 알려 주는 편이 낫다" 고 적어 뒀지만, 나갈 길이 하나도
 *   없는 상태에서 그 말은 그냥 갇힌다는 뜻이다.
 *
 *   이제 템플릿이 실패하면 자체 DOM 메뉴를 그린다. 자체 DOM 이 단말기에서
 *   렌더된다는 건 원장이 보낸 사진으로 확인됐다.
 */
function openAdminMenu() {
  log.info("관리자 메뉴", "대기화면에서 관리자 버튼을 눌렀습니다.");

  const params: IdlePageParams = {
    type: "twoButton",
    title: { text1: merchantName || "관리자", text2: "무엇을 할까요?" },
    description: {
      text: "[첫화면으로]를 누르면 학생이 이 단말기로 결제할 수 없습니다.",
      subText: "결제 취소는 단말기가 아니라 토스플레이스 판매자센터(PC)에서 하세요.",
    },
    primaryButton: { text: "단말기 상태", onClick: () => showTerminalStatus() },
    secondaryButton: { text: "첫화면으로", onClick: () => exitToTossHome() },
  };

  const rendered = renderIdle(
    sdk,
    () =>
      showAdminMenu({
        title: merchantName || "관리자",
        onStatus: () => showTerminalStatus(),
        onExit: () => exitToTossHome(),
        onClose: () => goIdle(),
      }),
    params
  );
  if (rendered) confirmTemplateRendered();
}

/**
 * 단말기 첫화면으로 나간다.
 *
 * ── 정직하게 남겨 두는 한계 (2026-08-29 문서 재확인) ──
 *   sdk.app.setIdle 에 대해 Toss 레퍼런스가 적어 둔 것은 딱 한 줄이다:
 *     "setIdle — 첫화면으로 이동해요."
 *   (docs.tossplace.com/reference/plugin-sdk/front/app.html)
 *
 *   "플러그인을 종료한다"거나 "토스 기본 결제앱으로 간다"는 서술은 없다.
 *   sdk.app 전체를 뒤져도 플러그인을 빠져나가는 API 는 문서에 존재하지 않는다
 *   (restartOnboarding · getSerialNumber · getMerchant · openSetting · setIdle ·
 *    isDebugMode 6개가 전부).
 *
 *   나는 앞서 원장에게 "[토스 홈으로] → [나가기] 로 기본 결제앱의 거래내역에서
 *   취소하시면 됩니다" 라고 안내했다. 그건 검증하지 않은 말이었다. 이 버튼이
 *   실제로 어디로 가는지는 단말기에서 눌러 봐야만 안다. 그래서 문구를
 *   "토스 홈으로"가 아니라 "첫화면으로" 로 바꾸고, 거래내역 이야기는 뺐다.
 *   결제 취소의 확실한 경로는 판매자센터(PC 웹)뿐이다.
 *
 * ── 0.3.12 에서 고친 것 (원장 신고: "눌러도 화면이 바뀌질 않아") ──
 *   원인은 setIdle 이 아니라 우리 쪽이었다. 자체 화면(#edusync-front-root)과
 *   부팅 문구(#boot)는 둘 다 position:fixed·inset:0 이고, 자체 화면은
 *   z-index 가 2147483000 이다. 즉 setIdle 이 성공해서 토스가 첫화면을
 *   #root 에 그리더라도 그 위를 우리 판이 통째로 덮는다. 원장 눈에는
 *   "아무 일도 안 일어나고 로그만 한 줄 늘어나는" 화면이 된다.
 *   그래서 이제 부르기 전에 우리 화면을 먼저 걷어낸다.
 *
 *   덮개를 걷으면 새 위험이 생긴다 — setIdle 이 조용히 실패하면 화면에
 *   아무것도 안 남는다. 그래서 세 가지를 같이 넣었다:
 *     1) reject 를 잡아 실패 화면으로 되돌린다.
 *     2) 3초 워치독. resolve 도 reject 도 안 오는 경우를 잡는다.
 *        (이 펌웨어의 renderIdlePage 는 그냥 던졌다. 조용히 죽는 API 를
 *         이미 한 번 봤으니 응답 자체를 안 믿는다.)
 *     3) resolve 를 받아도 그것만으로는 성공으로 치지 않는다. 0.6초 뒤
 *        #root 에 자식 노드가 생겼는지 본다. 그게 "토스가 실제로 그렸다"는
 *        유일한 양성 증거다. 없으면 실패로 처리한다.
 *   어느 쪽으로 실패하든 [토스 설정 열기](openSetting) 와 [대기화면으로] 를
 *   가진 화면을 그린다. openSetting 은 문서에 있는데 여태 한 번도 안 써 본
 *   나가는 길이다 — 설정 화면까지만 가도 원장이 단말기를 다룰 수 있다.
 */
const EXIT_WATCHDOG_MS = 3000;
const EXIT_VERIFY_MS = 600;

function exitToTossHome() {
  if (!sdk?.app?.setIdle) {
    log.warn("setIdle 없음", "이 펌웨어는 첫화면 이동을 지원하지 않습니다.");
    reportExitFailed("이 단말기 펌웨어에는 sdk.app.setIdle 이 없습니다.");
    return;
  }

  log.info("첫화면으로 이동", "원장 요청으로 sdk.app.setIdle() 을 호출합니다.");

  // 덮개를 먼저 걷는다. 이게 0.3.12 수정의 핵심이다.
  clearOwnScreen();
  removeBootNode();

  let settled = false;
  const watchdog = setTimeout(() => {
    if (settled) return;
    settled = true;
    reportExitFailed("setIdle() 이 3초 안에 응답하지 않았습니다.");
  }, EXIT_WATCHDOG_MS);

  void sdk.app
    .setIdle()
    .then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      log.info("setIdle 응답", "성공. 토스가 실제로 그렸는지 확인합니다.");
      setTimeout(() => {
        const drawn = (document.getElementById("root")?.childElementCount ?? 0) > 0;
        if (drawn) {
          // 여기서만 true 가 된다. "나갔다고 믿는" 것이 아니라 "나간 것을 봤다".
          exitedToHome = true;
          log.info("첫화면 이동 확인", "#root 에 토스 화면이 그려졌습니다. 폴링 화면 갱신을 멈춥니다.");
          return;
        }
        reportExitFailed("setIdle() 은 성공했지만 토스 첫화면이 그려지지 않았습니다.");
      }, EXIT_VERIFY_MS);
    })
    .catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reportExitFailed(describeErr(err));
    });
}

/**
 * 부팅 문구를 지운다.
 *
 * confirmTemplateRendered 와 달리 "토스가 그렸다"는 증거 없이도 지운다.
 * 나가기는 화면을 통째로 넘겨주는 동작이라 덮개를 남길 수 없기 때문이다.
 * 실패하면 곧바로 reportExitFailed 가 자체 화면을 다시 그려서 메운다.
 */
function removeBootNode() {
  if (typeof document === "undefined") return;
  document.getElementById("boot")?.remove();
}

/** 나가기가 안 됐을 때. 빈 화면에 원장을 버려 두지 않는 것이 이 함수의 전부다. */
function reportExitFailed(reason: string) {
  // 나가지 못했으니 화면은 다시 우리 것이다. 폴링 갱신도 다시 허용한다.
  exitedToHome = false;
  log.error("첫화면 이동 실패", reason, "대안 경로를 화면에 띄웁니다.");

  const actions: ScreenAction[] = [];
  if (sdk?.app?.openSetting) {
    actions.push({ label: "토스 설정 열기", kind: "primary", onClick: () => openTossSetting() });
  }
  actions.push({ label: "대기화면으로", kind: "secondary", onClick: () => goIdle() });

  showStatus({
    tone: "error",
    title: "첫화면으로 나가지 못했습니다",
    detail:
      "이 단말기 펌웨어가 플러그인 밖으로 나가는 것을 허용하지 않습니다. " +
      "결제 취소는 토스플레이스 판매자센터(PC 웹)에서 하세요. " +
      "단말기 자체를 다루셔야 하면 아래 [토스 설정 열기]를 눌러 보세요.",
    actions,
  });
}

/** 문서에 있는데 여태 안 써 본 두 번째 탈출구. */
function openTossSetting() {
  if (!sdk?.app?.openSetting) return;
  log.info("토스 설정 열기", "sdk.app.openSetting() 을 호출합니다.");
  clearOwnScreen();
  removeBootNode();
  // 설정 화면도 남에게 넘긴 화면이다. 폴링이 그 위를 덮지 않게 막는다.
  // 실패하면 아래 catch 에서 reportExitFailed 와 같은 이유로 도로 푼다.
  exitedToHome = true;
  void sdk.app.openSetting().catch((err) => {
    exitedToHome = false;
    log.error("openSetting 실패", err, "대기화면으로 되돌립니다.");
    showStatus({
      tone: "error",
      title: "설정 화면도 열지 못했습니다",
      detail:
        "단말기에서 직접 설정으로 들어가셔야 합니다. 진입 방법은 아래 로그가 아니라 " +
        "태블릿 화면(단말기 모드 안내)에 적어 두었습니다.",
      actions: [{ label: "대기화면으로", kind: "secondary", onClick: () => goIdle() }],
    });
  });
}

// notify() 는 0.3.12 에서 지웠다.
//   openToast 로 한 줄 띄우는 함수였는데, 이 펌웨어에서는 template.* 이 통째로
//   실패해서 사실상 아무것도 안 보여 주는 함수였다. 남겨 두면 다음에 또
//   "알렸다고 착각하는" 코드를 쓰게 된다. 알릴 일이 있으면 showStatus 로
//   화면을 그린다 — 그린 것은 원장 사진으로 확인이 되지만, 안 뜬 토스트는
//   확인할 방법이 없다.

/**
 * 관리자 메뉴의 [단말기 상태]. 결제에는 일절 관여하지 않는 읽기 전용 동작이다.
 *
 * ── 0.3.12 에서 바뀐 것 ──
 *   0.3.11 은 notify() → openToast 로 한 줄 띄우고 곧바로 goIdle() 했다.
 *   그런데 이 펌웨어에서는 template.* 이 통째로 실패한다. openToast 도 예외가
 *   아니어서, 원장이 [단말기 상태]를 눌러도 아무것도 안 뜨고 대기화면으로
 *   되돌아갈 뿐이었다. [첫화면으로] 와 똑같은 증상이고 원인도 같다.
 *
 *   이제 자체 화면(showStatus)으로 그린다. 이 화면은 로그를 함께 보여 준다.
 *   학생이 보는 대기화면에서 로그를 뺀 대신, 원장이 원인을 찾을 때 여는 곳은
 *   여기다 — 원장이 PC 로 172.30.1.91:9900 을 열 수 없는 상황도 있다.
 */
function showTerminalStatus() {
  const connected = consecutivePollErrors === 0;
  const line = connected
    ? "서버 연결: 정상"
    : `서버 연결: 끊김 (연속 실패 ${consecutivePollErrors}회)`;

  log.info("단말기 상태 확인", `${line} · v${PLUGIN_VERSION}`);

  showStatus({
    tone: connected ? "idle" : "error",
    title: connected ? "단말기 정상" : "서버와 연결이 끊겼습니다",
    detail: [
      line,
      `플러그인 버전: v${PLUGIN_VERSION}`,
      `상점: ${merchantName || "(확인 안 됨)"}`,
      busy ? "지금 결제 진행 중입니다." : "결제 대기 중입니다.",
    ].join(" · "),
    actions: [{ label: "대기화면으로", kind: "primary", onClick: () => goIdle() }],
  });
}

/**
 * SDK 유휴화면이 있으면 그걸 쓰고, 없으면 자체 대기화면을 그린다.
 *
 * 0.3.8 까지는 `if (sdk?.template?.renderIdlePage) clearOwnScreen()` 이었다.
 * 함수의 "존재"만 확인하고 화면을 치운 것이다. Toss 문서는 플러그인 화면을
 * 반드시 Template API 로만 구성하라고 못 박고 있어서, 자체 DOM 은 단말기에서
 * 그려지지 않을 수 있다 — 그런데 우리는 그 사실을 확인도 안 하고 부팅 문구까지
 * 지웠다. 결과가 원장이 본 완전한 빈 화면이다.
 *
 * 이제 renderIdle 이 true 를 준 경우에만 치운다. 렌더에 실패했으면 자체 화면과
 * 부팅 문구가 둘 다 남는다. 보기 좋지는 않아도 단말기 앞에서 원인을 읽을 수 있다.
 */
function goIdle() {
  // 원장이 눌러서 돌아오는 길이다. 나간 상태를 여기서 푼다.
  exitedToHome = false;
  const rendered = renderIdle(sdk, () => showIdle({ onAdmin: openAdminMenu }), idleParams());
  if (rendered) confirmTemplateRendered();
}

// ─── 부팅 ──────────────────────────────────────────────────────────────

export async function bootstrap() {
  configureLogger({ serverUrl: SERVER_URL, onScreen: (line) => pushDiagLine(line) });
  installGlobalErrorHandlers();
  // 화면이 처음 그려지기 전에 버전을 알려 준다. 이 값이 화면 첫 줄에 찍히므로,
  // 원장이 보내는 단말기 사진 한 장으로 어느 ZIP 이 돌고 있는지 판별된다.
  setScreenVersion(PLUGIN_VERSION);

  log.info("plugin entry started", `version=${PLUGIN_VERSION} server=${SERVER_URL}`);

  // 1) SDK 확보. 못 찾으면 결제는 불가능하지만, 화면과 로그는 계속 살려 둔다.
  //    (여기서 return 해 버리면 다시 "아무 단서 없는 화면"이 된다)
  showIdle({ onAdmin: openAdminMenu });
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
      showFatal("단말기 등록 실패", humanErr(err), { onAdmin: openAdminMenu });
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
      "EduSyncPro 서버에 연결하지 못했습니다. 단말기 인터넷 연결과 등록 코드를 확인해 주세요.",
      { onAdmin: openAdminMenu }
    );
    log.error("backend connection 실패", err, "세션 발급 단계에서 중단되었습니다.");
    await log.flushNow();
    // 연결이 끊겼어도 폴링은 계속 돌린다. 네트워크가 돌아오면 스스로 복구된다.
  }

  // 4) 지난 부팅에서 서버까지 못 보낸 승인들을 먼저 밀어낸다.
  //
  //    backup 복구보다 이걸 먼저 하는 이유: 아웃박스에는 승인 응답이 통째로
  //    들어 있어 그대로 다시 보내면 되지만, backup 복구는 getPayment 로 단말기
  //    캐시를 다시 뒤져야 한다. 확실한 쪽을 먼저 처리한다.
  outbox = loadOutbox(outboxStorage, (msg) =>
    log.error("아웃박스 읽기 실패", new Error(msg), "이 부팅에서는 빈 아웃박스로 시작합니다."),
  );
  await mergeMirroredOutbox().catch(() => {});
  if (outbox.length > 0) {
    const total = outbox.reduce((s, e) => s + e.payload.amount, 0);
    log.warn(
      "미반영 승인 발견",
      `${outbox.length}건 합계 ${total}원이 아직 원장에 반영되지 않았습니다. 지금 다시 보냅니다.`,
    );
    await flushOutbox("부팅");
  }

  // 4-b) 못 보낸 취소 결과 + 취소 도중 종료 흔적.
  //
  //      결제 아웃박스 바로 뒤에 둔다. 여기 남아 있는 건은 "카드에서 돈이
  //      돌아갔는데 장부는 아직 모른다" 일 수 있어 승인 미반영과 무게가 같다.
  cancelOutbox = loadCancelOutbox(outboxStorage, (msg) =>
    log.error("취소 아웃박스 읽기 실패", new Error(msg), "이 부팅에서는 빈 상태로 시작합니다."),
  );
  if (cancelOutbox.length > 0) {
    log.warn(
      "미보고 취소 결과 발견",
      `${cancelOutbox.length}건이 아직 서버에 전달되지 않았습니다. 지금 다시 보냅니다.`,
    );
    await flushCancelOutbox("부팅");
  }
  await recoverInterruptedCancel().catch((err) => {
    log.error("중단된 취소 복구 실패", err, "결과를 모르는 취소가 남아 있을 수 있습니다.");
  });

  // 5) 앱이 결제 도중 꺼졌던 경우 backup 으로 마지막 결과 복구
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
      // backup 은 우리가 넘겼던 paymentKey 그 자체다. getPayment 응답에는
      // paymentKey 가 안 들어 있으므로(문서상 { paymentMethod, tid,
      // vanTransactionKey, card } 뿐) 여기서 알려 줘야 한다.
      await confirmPaymentFromSdk(result.response, { paymentKey: backup });
      handledPaymentKeys.add(backup);
      log.info("backup 복구 완료", "승인 결과를 아웃박스에 넣었습니다. 서버 반영까지 책임집니다.");
    } catch (err) {
      // 여기 오는 건 "보낼 내용을 못 만든" 경우뿐이다 (금액이 없는 등).
      // 그때는 backup 을 지우지 않는다 — 다음 부팅에서 다시 시도할 수 있다.
      // 전송 실패는 이제 여기로 오지 않는다. 아웃박스가 들고 계속 재시도한다.
      log.error("backup confirm 실패", err, "backup을 유지하고 다음 부팅에서 재시도합니다.");
      return;
    }
  }
  if (typeof p.resetBackupPaymentKey === "function") {
    await p.resetBackupPaymentKey();
  }
}

/**
 * 서버가 되물은 결제들을 getPayment 로 확인해서 자동으로 장부에 올린다.
 *
 * ── 왜 이게 필요한가 (2026-08-30, 원장 요청) ──
 *   원장이 말한 그대로다: "실제로는 승인이 되었는데 웹앱에서는 processing 이라고
 *   나왔다가 expired 로 바뀌고, 결국 사장님앱에서 승인번호를 확인해서 수기로
 *   눌러야 한다. 너무 번거롭다."
 *
 *   그 번거로움의 원인은 서버가 "카드가 긁혔다"는 사실을 알 수 있는 통로가
 *   confirm 요청 **하나뿐**이었다는 것이다. 그 한 번이 실패하면 서버는 영영
 *   모른다. 이제 서버가 되물을 수 있고, 답은 단말기 안에 있다.
 *
 * ── 근거 (docs.tossplace.com/reference/plugin-sdk/front/payment.html) ──
 *   getPayment 는 requestPayment 의 결과를 단말기에 14일간 캐시해 두고,
 *   "WebView reload, 페이지 이동, JS 런타임 재초기화 등으로 데이터를 유실했을
 *   경우" 다시 꺼내 쓰라고 만들어진 API 다. 우리 상황이 정확히 그것이다.
 *
 *   결정적으로 **SUCCESS 결과만 캐시된다.** 그래서 이 함수가 없는 돈을 장부에
 *   만들어 낼 방법이 없다 — 진짜 실패한 결제는 단말기가 모른다고 답한다.
 *
 * ⚠️ 결제 중에는 절대 실행하지 않는다. 학생이 카드를 대고 있는데 getPayment 를
 *    끼워 넣으면 결제 화면과 경합한다. 호출부에서 busy 를 확인한다.
 */
async function runRecoveryChecks(requests: RecoveryRequest[]) {
  if (!sdk || requests.length === 0) return;
  const p = sdk.payment;
  if (typeof p.getPayment !== "function") {
    // 이 펌웨어에 조회 API 가 없으면 자동 대사는 불가능하다. 수기 대사 경로는
    // 그대로 살아 있으므로 조용히 포기하되, 왜 자동이 안 되는지는 남긴다.
    log.warn("자동 대사 불가", "이 펌웨어에는 sdk.payment.getPayment 가 없습니다.");
    return;
  }

  for (const request of requests) {
    const paymentKey = request.paymentKey;
    // 이미 이번 부팅에서 처리한 건은 건너뛴다. 서버가 아직 장부 반영을 못 봤을
    // 뿐일 수 있는데, 그 사이 폴링이 여러 번 돌면 같은 걸 반복해서 묻게 된다.
    if (handledPaymentKeys.has(paymentKey)) continue;

    try {
      const result = await p.getPayment({ paymentKey });

      if (result && result.type === "SUCCESS") {
        // 승인 기록이 있었다. 평소 경로로 서버에 올린다 — 서버는 이걸
        // "지각 승인" 으로 받아 주고 장부에 넣는다.
        //
        // request 를 함께 넘기는 이유: getPayment 응답에는 금액도 주문번호도
        // paymentKey 도 없다. 서버가 확정해 준 값으로 그 구멍을 메운다.
        log.warn(
          "자동 대사: 승인 기록 발견",
          `paymentKey=${paymentKey} — 단말기에 승인 기록이 남아 있습니다. 장부에 올립니다.`
        );
        await confirmPaymentFromSdk(result.response, request);
        handledPaymentKeys.add(paymentKey);
        // 아웃박스에 들어갔으므로 여기서 놓칠 일은 없다. 아직 서버까지 못 갔다면
        // 아웃박스에 남아 계속 재시도되고, 그 사실은 위 flushOutbox 가 로그로 남긴다.
        const settled = !outbox.some((e) => e.payload.paymentKey === paymentKey);
        if (settled) log.info("자동 대사 완료", `${paymentKey} 를 수납에 자동 반영했습니다.`);
        else log.warn("자동 대사 접수", `${paymentKey} 를 아웃박스에 넣었습니다. 반영될 때까지 재시도합니다.`);
        continue;
      }

      // 조회는 됐는데 SUCCESS 가 아니다 = 승인된 적이 없다.
      await reportRecoveryNotFound({ paymentKey, code: result?.type ?? "NOT_SUCCESS" });
      handledPaymentKeys.add(paymentKey);
      log.info("자동 대사: 승인 없음", `${paymentKey} 는 실제로 승인되지 않았습니다.`);
    } catch (err) {
      // getPayment 가 PAYMENT_NOT_FOUND 로 throw 하는 펌웨어도 있다. 그 경우도
      // "승인 없음" 이지만, 네트워크 오류와 구분이 안 되면 멀쩡한 결제에
      // "승인 없음" 표식을 찍어 버릴 수 있다. 그래서 코드가 확실히
      // PAYMENT_NOT_FOUND 일 때만 보고하고, 나머지는 다음 폴링에 다시 시도한다.
      const code = errCode(err);
      if (isPaymentNotFound(err)) {
        try {
          await reportRecoveryNotFound({ paymentKey, code: PAYMENT_NOT_FOUND });
          handledPaymentKeys.add(paymentKey);
          log.info("자동 대사: 승인 없음", `${paymentKey} — 단말기에 기록이 없습니다.`);
        } catch (reportErr) {
          log.error("자동 대사 보고 실패", reportErr, "다음 폴링에서 다시 시도합니다.");
        }
      } else if (shouldLogRecoveryError(paymentKey, code ?? "unknown", Date.now())) {
        // 모르는 오류는 판단을 보류한다 (멀쩡한 결제에 "승인 없음" 을 찍지 않는다).
        // 다만 보류는 계속되므로 같은 줄을 1초마다 남기지는 않는다 — 5분에 한 번만.
        log.error(
          "자동 대사 확인 실패",
          err,
          `paymentKey=${paymentKey} — 판단을 보류하고 다음 폴링에서 다시 확인합니다. ` +
            `(같은 오류는 5분에 한 번만 기록합니다)`
        );
      }
    }
  }
}

/**
 * 같은 건의 같은 오류를 반복해서 ERROR 로 찍지 않기 위한 기록.
 *
 * 로그는 무한하지 않다. 1초마다 같은 줄을 쌓으면 정작 사고가 났을 때 그 앞뒤를
 * 볼 수 없다 — 이번에 카드취소를 진단하면서 실제로 겪었다.
 */
const loggedRecoveryErrors = new Map<string, number>();
const RECOVERY_ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

function shouldLogRecoveryError(paymentKey: string, code: string, now: number): boolean {
  const k = `${paymentKey}:${code}`;
  const prev = loggedRecoveryErrors.get(k);
  if (prev != null && now - prev < RECOVERY_ERROR_LOG_INTERVAL_MS) return false;
  loggedRecoveryErrors.set(k, now);
  return true;
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
    const { pending, recover, cancel } = await fetchPendingDispatch();

    if (consecutivePollErrors > 0) {
      log.info("backend connection 복구", `연속 실패 ${consecutivePollErrors}회 뒤 정상화되었습니다.`);
      consecutivePollErrors = 0;
      // 원장이 첫화면으로 나가 있으면 화면을 도로 뺏지 않는다. 복구 사실은
      // 로그로만 남긴다. 결제요청이 오면 아래에서 어차피 화면을 되찾는다.
      if (!exitedToHome) goIdle();
    }

    if (pending && !handledPaymentKeys.has(pending.paymentKey)) {
      handledPaymentKeys.add(pending.paymentKey);
      busy = true;
      // 결제요청은 화면을 되찾을 유일한 정당한 사유다. 학생이 카드를 대려고
      // 태블릿에서 금액을 띄운 상황이므로 단말기가 앞으로 나와야 한다.
      exitedToHome = false;
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
      // 결제를 막 끝냈다. 자동 대사는 다음 폴링으로 미룬다 — 방금 끝난 결제의
      // confirm 이 아직 서버에 반영되는 중일 수 있고, 그 사이에 같은 건을
      // 되물으면 쓸데없이 한 번 더 확인하게 된다.
      return;
    }

    // 원장이 걸어 둔 카드 취소. 결제가 없을 때만 집는다 — 단말기는 한 번에
    // 한 장의 카드만 다룰 수 있고, 결제와 취소가 겹치면 어느 쪽 카드인지
    // 알 수 없게 된다. (서버도 같은 배제를 걸어 두었다.)
    //
    // 취소 결과 보고를 먼저 밀어낸다. 못 보낸 보고가 있다는 것은 "카드에서는
    // 돈이 돌아갔는데 장부는 아직 모른다" 는 뜻이라 무엇보다 급하다.
    if (!busy) await flushCancelOutbox("폴링");

    if (cancel && !busy && !handledCancelIds.has(cancel.cancelId)) {
      handledCancelIds.add(cancel.cancelId);
      busy = true;
      exitedToHome = false;
      log.info(
        "카드 취소 요청 수신",
        `cancel=${cancel.cancelId} 금액=${cancel.amount}원 결제키=${cancel.paymentKey}`,
      );
      try {
        await handleCancelDispatch(cancel);
      } finally {
        busy = false;
        goIdle();
        log.info("waiting payment intent", "다음 결제 요청을 기다립니다.");
      }
      return;
    }

    // 못 보낸 승인이 있으면 먼저 그것부터 밀어낸다. 자동 대사보다 앞이다 —
    // 아웃박스에는 승인 내용이 통째로 들어 있어 그냥 다시 보내면 되지만,
    // 자동 대사는 단말기 캐시를 뒤져야 하는 더 비싼 길이다.
    //
    // flushOutbox 는 내부에서 백오프를 보고 아직 때가 아닌 건은 건너뛰므로,
    // 매 초 불러도 실제 요청은 1초 → 2초 → … → 5분 간격으로만 나간다.
    // 던지지 않는 함수라 아래 catch 가 이걸 "서버 연결 끊김" 으로 오해하지 않는다.
    if (!busy) await flushOutbox("폴링");

    // 결제 요청이 없을 때만 자동 대사를 돌린다. 단말기의 본업은 결제이고,
    // 대사는 한가할 때 하는 뒷정리다. 여기서 실패해도 폴링은 계속돼야 하므로
    // 오류를 밖으로 던지지 않는다 — 던지면 아래 catch 가 이걸 "서버 연결 끊김"
    // 으로 오해해서 "인터넷을 확인하세요" 화면을 띄운다.
    if (recover && recover.length > 0 && !busy) {
      try {
        await runRecoveryChecks(recover);
      } catch (err) {
        log.error("자동 대사 중 오류", err, "다음 폴링에서 다시 시도합니다.");
      }
    }
  } catch (err) {
    consecutivePollErrors += 1;
    // 매 초 같은 오류를 500줄씩 올리면 로그가 쓸모없어진다. 처음 3회와 이후 30회마다만 남긴다.
    if (consecutivePollErrors <= 3 || consecutivePollErrors % 30 === 0) {
      log.error("폴링 오류", err, `연속 실패 ${consecutivePollErrors}회`);
    }
    // 나가 있는 동안에는 이 경고 화면도 띄우지 않는다. 원장이 결제 취소를
    // 하러 나간 판을 "서버 연결 끊김" 이 덮어 버리면 나가기가 무효가 된다.
    if (consecutivePollErrors === 5 && !exitedToHome) {
      showFatal(
        "서버 연결 끊김",
        "EduSyncPro 서버와 통신하지 못하고 있습니다. 인터넷 연결을 확인해 주세요. 연결되면 자동으로 복구됩니다.",
        { onAdmin: openAdminMenu }
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
      // confirmPaymentFromSdk 는 이제 "아웃박스에 적고 한 번 보내 본다" 이다.
      // 전송이 실패해도 던지지 않는다 — 승인 기록은 이미 단말기에 남았고,
      // 폴링과 다음 부팅이 성공할 때까지 계속 다시 보낸다.
      await confirmPaymentFromSdk(result.response, {
        // dispatch 가 알고 있는 서버 확정값을 함께 넘긴다. SDK 응답에 금액이나
        // 주문번호가 비어 오는 펌웨어에서도 장부에 정확한 숫자가 들어가게 한다.
        paymentKey: d.paymentKey,
        orderId: d.orderId,
        amount: d.amount,
      });
      if (pendingConfirmCount() === 0) {
        log.info("원장 반영 완료", "수납 내역에 기록했습니다.");
      } else {
        // 승인은 났고 기록도 남겼는데 서버까지는 아직 못 갔다. 예전 같으면
        // 여기서 끝이었지만 이제는 "미룬 것" 이지 "잃은 것" 이 아니다.
        log.warn(
          "원장 반영 지연",
          `카드 승인은 완료되었고 단말기에 기록했습니다. 서버 전송이 아직 끝나지 않아 재시도합니다.` +
            ` (대기 ${pendingConfirmCount()}건)`
        );
      }
    } catch (err) {
      // 여기까지 오는 경우는 하나뿐이다: 승인 응답에 금액이나 paymentKey 가 없어
      // **보낼 내용을 만들지도 못한** 경우. 금액을 추측해 장부에 넣지 않는다는
      // 원칙 때문에 일부러 던진 것이다. 이건 아웃박스가 구제할 수 없다.
      log.error(
        "승인 후 원장 반영 실패",
        err,
        "카드 승인은 완료되었으나 승인 응답이 불완전해 수납 기록을 만들지 못했습니다. 원장 확인이 필요합니다."
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

// ─── 카드 취소 처리 (0.3.15~) ─────────────────────────────────────────

/** 결과 화면을 원장이 읽을 시간을 준다. 이 동안 폴링은 busy 로 잠겨 있다. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 원장이 걸어 둔 카드 취소를 단말기에서 집행한다.
 *
 * ══ 이 함수를 결제와 다르게 쓴 곳 세 군데 ══
 *
 *   1. requestPaymentCancel 은 **딱 한 번** 부른다. 어떤 경우에도 다시 부르지
 *      않는다. 결제는 실패하면 다시 걸면 되지만, 취소는 실패했는지조차 확실치
 *      않을 때가 있고 그때 다시 걸면 학부모 카드로 돈이 두 번 들어간다.
 *
 *   2. SDK 호출이 **예외로 끝나면 FAILED 가 아니라 TIMEOUT 으로 보고한다.**
 *      결제 쪽 handleDispatch 는 같은 상황에서 FAILED 로 보고하는데, 여기서
 *      그렇게 하면 서버가 "카드를 안 건드렸구나" 하고 재시도를 열어 준다.
 *      예외가 카드를 건드리기 전에 났는지 후에 났는지 우리는 알 수 없다.
 *      모르는 것은 모른다고 보고해야 한다. TIMEOUT 이 우리 체계에서 "모른다" 다.
 *
 *   3. 결과 보고는 **아웃박스를 거친다.** 카드에서 돈이 돌아갔다는 사실을
 *      서버가 알아야만 장부에 음수 행이 적힌다. 이 보고가 유실되면 원장이
 *      겪었던 그 사고 — "카드는 됐는데 장부는 모른다" — 가 방향만 바꿔 재현된다.
 */
async function handleCancelDispatch(c: PendingCancel) {
  // ── (a) 카드를 건드릴 수 없는 게 확실한 경우들. 여기서는 FAILED 가 맞다. ──
  //        ack 보다 앞에 둔다. 집어 놓고 못 하면 서버 쪽 행이 DELIVERED 로 묶여
  //        5분간 아무도 손대지 못하는 상태가 된다.
  if (!sdk) {
    log.error("카드 취소 불가", new Error("SDK 없음"), `cancel=${c.cancelId}`);
    await enqueueCancelReport(c, "FAILED", { reason: "sdk unavailable" });
    return;
  }
  if (typeof sdk.payment.requestPaymentCancel !== "function") {
    // 구형 펌웨어다. 카드는 확실히 건드려지지 않았으므로 FAILED 로 보고해도
    // 안전하다 (서버가 재시도를 허용하지만, 다시 걸어도 같은 자리에서 멈춘다).
    log.error(
      "카드 취소 불가",
      new Error("requestPaymentCancel 없음"),
      `cancel=${c.cancelId} — 이 단말기 펌웨어는 취소 API 를 제공하지 않습니다. ` +
        `토스 사장님 앱에서 직접 취소한 뒤 원장 화면에서 장부에만 반영해 주세요.`,
    );
    await enqueueCancelReport(c, "FAILED", {
      reason: "이 단말기 펌웨어에 requestPaymentCancel 이 없습니다.",
    });
    return;
  }

  // ── (b) 선점. 실패하면 절대 SDK 를 부르지 않는다. ──
  //        다른 폴링 사이클이 이미 집어갔다는 뜻이고, 그 사이클이 지금 카드를
  //        취소하는 중일 수 있다. 여기서 밀어붙이면 이중 취소다.
  try {
    await ackCancel(c.cancelId);
    log.info("카드 취소 ack", `cancel=${c.cancelId} DELIVERED 로 표시했습니다.`);
  } catch (err) {
    log.warn(
      "카드 취소 ack 실패",
      `cancel=${c.cancelId} — 다른 사이클이 이미 집어간 것으로 보고 취소를 걸지 않습니다. ` +
        `[${describeErr(err).slice(0, 160)}]`,
    );
    return;
  }

  showCancelBusy(c.amount);

  // ── (c) 진행중 표식. SDK 를 부르기 **전에** 남긴다. ──
  //        여기서 앱이 죽으면 카드 상태를 아무도 모른다. 표식이 있어야 다음
  //        부팅에서 "취소를 걸다 끊겼다" 는 사실이라도 서버에 알릴 수 있다.
  const marked = markInflight(
    outboxStorage,
    { cancelId: c.cancelId, paymentKey: c.paymentKey, startedAt: Date.now() },
    (msg) => log.warn("취소 표식 실패", msg),
  );
  if (!marked) {
    // 표식을 못 남겼다고 취소를 포기하지는 않는다. 원장이 요청한 일이고,
    // 표식이 없으면 "앱이 죽었을 때" 만 손해다. 다만 그 사실은 남긴다.
    log.warn(
      "취소 표식 없이 진행",
      `cancel=${c.cancelId} — 취소 도중 앱이 종료되면 결과를 복구하지 못합니다.`,
    );
  }

  // ── (d) 단 한 번의 호출. ──
  let result: PaymentResult;
  try {
    log.info(
      "requestPaymentCancel 호출",
      `cancel=${c.cancelId} 금액=${c.amount} 원승인번호=${c.approvalNumber} ` +
        `공급가=${c.supplyValue} 세액=${c.tax} 할부=${c.installment}`,
    );
    result = await sdk.payment.requestPaymentCancel({
      paymentKey: c.paymentKey,
      paymentMethod: c.paymentMethod,
      // 문서: "원거래와 동일한 tax, supplyValue, taxExemptValue 를 전달해요".
      // 전부 서버가 승인 당시 확정한 값이다. 단말기가 다시 계산하지 않는다.
      tax: c.tax,
      supplyValue: c.supplyValue,
      taxExemptValue: c.taxExemptValue,
      tip: c.tip,
      timestamp: c.approvedTimestamp,
      approvalNumber: c.approvalNumber,
      installment: c.installment,
      tid: c.tid,
      timeoutMs: PAYMENT_TIMEOUT_MS,
      localeCode: "ko",
    });
  } catch (err: any) {
    clearInflight(outboxStorage);
    // ⚠️ 여기서 FAILED 로 보고하면 안 된다. 위 (2) 참고.
    log.error(
      "requestPaymentCancel 예외",
      err,
      `cancel=${c.cancelId} — 카드가 취소됐는지 알 수 없습니다. ` +
        `자동 재시도를 막기 위해 TIMEOUT 으로 보고합니다. 사장님 앱에서 실물을 확인해 주세요.`,
    );
    await enqueueCancelReport(c, "TIMEOUT", {
      // 후보를 전부 남긴다. 예외 하나에서 최대한 건져야 한다.
      reason: `SDK 예외: ${errCodeCandidates(err).join(" | ") || String(err)}`.slice(
        0,
        MAX_REASON_LEN,
      ),
    });
    showFatal(
      "취소 결과를 확인하지 못했습니다",
      "카드가 취소됐는지 알 수 없습니다. 토스 사장님 앱에서 취소 여부를 확인해 주세요. " +
        "확인 전까지 같은 건을 다시 취소하지 마세요.",
      { onAdmin: openAdminMenu },
    );
    await sleep(6000);
    return;
  }
  clearInflight(outboxStorage);

  // ── (e) 결과 보고. 성공했을 때만 서버가 장부에 음수 행을 쓴다. ──
  const type = result.type as CancelReportResult;
  let detail: {
    cancelApprovalNumber?: string;
    cancelTid?: string;
    reason?: string;
    raw?: unknown;
  };
  // 성공이든 실패든 응답 요약을 남긴다. 허용목록을 통과한 필드만 들어간다
  // (카드번호·정체불명의 raw 는 걸러진다). 서버 raw_response_json 으로 간다.
  const rawSummary = safeRawSummary(result);

  if (result.type === "SUCCESS") {
    // 취소 승인번호·TID 는 원승인의 것이 아니라 **취소 거래의 것**이다.
    // 나중에 사장님 앱 내역과 대조할 때 이 번호로 찾는다.
    detail = {
      cancelApprovalNumber: result.response.approvalNumber ?? undefined,
      cancelTid: result.response.tid ?? undefined,
      raw: rawSummary ?? undefined,
    };
    log.info(
      "카드 취소 완료",
      `cancel=${c.cancelId} 금액=${c.amount}원 취소승인번호=${result.response.approvalNumber ?? "-"}`,
    );
  } else {
    // ?? 사슬을 쓰지 않는다. code 와 message 가 같이 오면 둘 다 남겨야 한다 —
    // 어느 쪽이 결정적 단서인지 지금은 모르고, 시험할 결제는 1,000원 한 건뿐이다.
    detail = {
      reason: describeFailure(result),
      raw: rawSummary ?? undefined,
    };
    log.warn("카드 취소 미완료", `cancel=${c.cancelId} 결과=${result.type} · ${detail.reason}`);
  }

  await enqueueCancelReport(c, type, detail);

  // 화면. cardWasCancelled 로 판단한다 — result.type === "CANCELED" 는
  // "취소 성공" 이 아니라 "사용자가 취소 진행을 물렀다" 이므로 헷갈리면 안 된다.
  if (cardWasCancelled(type)) {
    showStatus({
      title: `${c.amount.toLocaleString()}원 결제취소 완료`,
      detail:
        "카드사로 취소 요청이 접수되었습니다. 수납 장부에도 환불로 반영됩니다.\n" +
        "카드사에 따라 실제 입금까지 2~5영업일이 걸릴 수 있습니다.",
      actions: [],
    });
  } else if (type === "TIMEOUT") {
    showFatal(
      "취소 결과를 확인하지 못했습니다",
      "단말기가 시간 안에 응답하지 못했습니다. 카드가 취소됐는지 알 수 없으므로 " +
        "토스 사장님 앱에서 확인해 주세요. 확인 전까지 다시 취소하지 마세요.",
      { onAdmin: openAdminMenu },
    );
  } else {
    showStatus({
      tone: "error",
      title: "결제취소가 되지 않았습니다",
      detail:
        `카드는 취소되지 않았습니다. (사유: ${String(detail.reason ?? "-").slice(0, 80)})\n` +
        "원장 화면에서 다시 요청할 수 있습니다.",
      actions: [],
    });
  }
  await sleep(6000);
}

/**
 * 취소 결과를 아웃박스에 적고 즉시 한 번 보내 본다.
 *
 * 적는 것이 먼저다. 보내다 실패해도 내용이 단말기에 남아야 다시 보낼 수 있다.
 * 결제 아웃박스(confirmPaymentFromSdk)와 같은 순서이고, 같은 이유다.
 */
async function enqueueCancelReport(
  c: PendingCancel,
  result: CancelReportResult,
  extra: { cancelApprovalNumber?: string; cancelTid?: string; reason?: string; raw?: unknown },
) {
  cancelOutbox = addCancelReport(
    cancelOutbox,
    {
      cancelId: c.cancelId,
      paymentKey: c.paymentKey,
      result,
      cancelApprovalNumber: extra.cancelApprovalNumber,
      cancelTid: extra.cancelTid,
      reason: extra.reason,
      raw: extra.raw,
    },
    Date.now(),
  );
  persistCancelOutbox();
  await flushCancelOutbox("취소 직후");
}

function persistCancelOutbox() {
  saveCancelOutbox(outboxStorage, cancelOutbox, (msg) =>
    log.error(
      "취소 아웃박스 저장 실패",
      new Error(msg),
      "앱이 꺼지면 취소 결과 보고가 유실될 수 있습니다.",
    ),
  );
}

/**
 * 못 보낸 취소 결과를 서버로 밀어낸다. 절대 던지지 않는다.
 *
 * 이 재시도는 **안전하다.** 다시 보내는 것은 취소 요청이 아니라 이미 끝난
 * 취소의 결과이고, 서버는 같은 cancelId 를 두 번 받아도 장부를 한 번만
 * 움직인다 (금액을 payments 에서 다시 세기 때문이다).
 */
async function flushCancelOutbox(reason: string) {
  if (flushingCancels || cancelOutbox.length === 0) return;
  flushingCancels = true;
  try {
    const due = dueCancelReports(cancelOutbox, Date.now());
    if (due.length === 0) return;

    log.info(
      "취소 결과 전송 시작",
      `대상 ${due.length}건 / 전체 ${cancelOutbox.length}건 · 계기=${reason}`,
    );

    for (const entry of due) {
      const { cancelId, paymentKey, result } = entry.payload;
      const { status, bodyText } = await reportCancelResultRaw(cancelId, {
        result,
        cancelApprovalNumber: entry.payload.cancelApprovalNumber,
        cancelTid: entry.payload.cancelTid,
        reason: entry.payload.reason,
        raw: entry.payload.raw,
      });

      if (isCancelReportSettled(status)) {
        cancelOutbox = removeCancelReport(cancelOutbox, cancelId);
        persistCancelOutbox();
        log.info(
          "취소 결과 반영 완료",
          `cancel=${cancelId} 결제키=${paymentKey} 결과=${result}` +
            (entry.attempts > 0 ? ` · 재시도 ${entry.attempts}회 만에 성공` : "") +
            (cardWasCancelled(result) ? " — 장부에 환불로 반영되었습니다." : ""),
        );
        continue;
      }

      cancelOutbox = markCancelAttempt(cancelOutbox, cancelId, Date.now(), bodyText);
      persistCancelOutbox();
      const attempts =
        cancelOutbox.find((e) => e.payload.cancelId === cancelId)?.attempts ?? entry.attempts + 1;

      // 카드가 취소된 건의 보고 실패는 그냥 실패가 아니다. 돈은 돌아갔는데
      // 장부가 모르는 상태이므로 수위를 올린다.
      if (cardWasCancelled(result)) {
        log.error(
          "취소 장부 반영 지연",
          new Error(bodyText.slice(0, 200)),
          `cancel=${cancelId} 결제키=${paymentKey} — 카드는 취소됐는데 서버에 알리지 못했습니다.` +
            ` ${attempts}번째 실패. 성공할 때까지 계속 재시도합니다.`,
        );
      } else if (attempts <= 3 || attempts % 10 === 0) {
        log.warn(
          "취소 결과 전송 재시도 예정",
          `cancel=${cancelId} 결과=${result} · ${attempts}번째 실패 · ${bodyText.slice(0, 160)}`,
        );
      }
    }
  } catch (err) {
    log.error("취소 결과 전송 중 오류", err, "다음 폴링에서 다시 시도합니다.");
  } finally {
    flushingCancels = false;
  }
}

/**
 * 부팅 시, 취소를 걸다가 앱이 죽은 흔적이 있으면 서버에 알린다.
 *
 * TIMEOUT 으로 보고하는 이유는 cancelOutbox.ts 헤더에 적었다. 요약하면:
 * 카드가 취소됐는지 우리는 모르고, SUCCESS 도 FAILED 도 각각 다른 방향의
 * 사고를 만든다. "모른다" 만이 사실이다.
 */
async function recoverInterruptedCancel() {
  const inflight = readInflight(outboxStorage);
  if (!inflight) return;

  log.error(
    "취소 도중 종료 흔적 발견",
    new Error("cancel inflight marker"),
    `cancel=${inflight.cancelId} 결제키=${inflight.paymentKey} — 취소를 거는 중에 앱이 종료되었습니다.` +
      ` 카드 취소 여부를 알 수 없어 TIMEOUT 으로 보고합니다. 사장님 앱에서 실물을 확인해 주세요.`,
  );

  cancelOutbox = addCancelReport(
    cancelOutbox,
    {
      cancelId: inflight.cancelId,
      paymentKey: inflight.paymentKey,
      result: "TIMEOUT",
      reason: "취소 요청 도중 단말기 앱이 종료되어 결과를 받지 못했습니다.",
    },
    Date.now(),
  );
  persistCancelOutbox();
  clearInflight(outboxStorage);
  // 같은 건을 이 부팅에서 다시 집지 않는다.
  handledCancelIds.add(inflight.cancelId);
  await flushCancelOutbox("부팅 · 중단된 취소");
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

// ─── 아웃박스 (승인 → 원장 반영 보장) ─────────────────────────────────
//
// 설계 근거와 배경은 outbox.ts 머리말에 전부 적어 두었다. 여기 있는 것은
// 그 순수 로직을 단말기의 저장소·네트워크·로그에 연결하는 배선뿐이다.

/**
 * 아웃박스의 실제 저장 장소.
 *
 * ── 왜 localStorage 를 주 저장소로 쓰는가 ──
 *   승인 직후, 서버로 보내기 **전에** 동기적으로 적어야 한다. sdk.storage 는
 *   Promise 라서 그 사이에 앱이 죽으면 아무것도 안 남는다. localStorage.setItem
 *   은 그 자리에서 끝난다. 우리가 지키려는 것이 정확히 "그 사이" 구간이다.
 *
 * ── 그러면 sdk.storage 는 왜 같이 쓰는가 ──
 *   WebView 저장소는 펌웨어 업데이트나 캐시 정리로 날아갈 수 있다. sdk.storage
 *   는 단말기 앱이 관리하므로 더 오래 산다. 그래서 **거울**로 함께 남기고,
 *   부팅할 때 양쪽을 합친다(mergeMirroredOutbox). 어느 한쪽이 지워져도 승인
 *   기록은 살아남는다.
 *
 *   sdk.storage 에는 삭제 API 가 없어서 비울 때는 "[]" 를 쓴다. loadOutbox 는
 *   빈 배열을 그대로 빈 아웃박스로 읽으므로 결과가 같다.
 */
const outboxStorage: OutboxStorage = {
  getItem(key) {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch (err) {
      // 여기서 던지면 승인 직후 흐름이 끊긴다. 메모리 사본은 살아 있으므로
      // 이번 부팅 동안의 재시도는 계속된다.
      log.error("아웃박스 localStorage 저장 실패", err, "메모리 사본으로 계속 재시도합니다.");
    }
    void storage.setItem(sdk, key, value).catch(() => {});
  },
  removeItem(key) {
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(key);
    } catch {
      /* 지우기 실패는 다음 저장에서 덮어써진다 */
    }
    void storage.setItem(sdk, key, "[]").catch(() => {});
  },
};

function persistOutbox() {
  saveOutbox(outboxStorage, outbox, (msg) =>
    log.error("아웃박스 저장 실패", new Error(msg), "메모리 사본으로 계속 재시도합니다."),
  );
}

/**
 * 부팅 시 sdk.storage 쪽 거울을 읽어 localStorage 사본과 합친다.
 * 중복은 addEntry 가 paymentKey 로 걸러 준다 (기존 재시도 이력이 이긴다).
 */
async function mergeMirroredOutbox() {
  let mirrored: OutboxEntry[] = [];
  try {
    const raw = await storage.getItem(sdk, OUTBOX_KEY);
    if (!raw) return;
    mirrored = loadOutbox({ getItem: () => raw, setItem: () => {}, removeItem: () => {} });
  } catch {
    return;
  }
  let added = 0;
  for (const e of mirrored) {
    const before = outbox.length;
    outbox = addEntry(outbox, e.payload, e.firstSeenAt);
    if (outbox.length > before) added += 1;
  }
  if (added > 0) {
    log.warn(
      "아웃박스 거울 복구",
      `단말기 저장소에만 남아 있던 미반영 승인 ${added}건을 되살렸습니다.`,
    );
    persistOutbox();
  }
}

/**
 * 승인 한 건을 아웃박스에 적는다. **서버로 보내기 전에** 부른다.
 * 저장이 끝나야 "이 승인은 잃어버리지 않는다" 가 성립한다.
 */
function enqueueConfirm(payload: ConfirmPayload) {
  const before = outbox.length;
  outbox = addEntry(outbox, payload, Date.now());
  if (outbox.length === before) {
    // 이미 있던 건이다 (재시도 중이거나, 자동 대사가 같은 건을 또 집었거나).
    // 덮지 않는다 — 덮으면 백오프가 처음으로 되돌아간다.
    return;
  }
  persistOutbox();
  log.info(
    "승인 기록 저장",
    `paymentKey=${payload.paymentKey} 금액=${payload.amount}원 — 단말기에 먼저 적었습니다.`,
  );
}

/**
 * 아웃박스를 서버로 밀어낸다. 성공(또는 "이미 장부에 있음")한 건만 지운다.
 *
 * 절대 던지지 않는다. 호출부는 폴링 루프와 부팅 경로이고, 둘 다 여기서 올라온
 * 예외를 "서버 연결 끊김" 으로 오해해 화면을 덮어 버린다.
 */
async function flushOutbox(reason: string) {
  if (flushingOutbox || outbox.length === 0) return;
  flushingOutbox = true;
  try {
    const now = Date.now();
    const due = dueEntries(outbox, now);
    if (due.length === 0) return;

    log.info("아웃박스 전송 시작", `대상 ${due.length}건 / 전체 ${outbox.length}건 · 계기=${reason}`);

    for (const entry of due) {
      const key = entry.payload.paymentKey;
      try {
        const r = await confirmPayment(entry.payload);
        outbox = removeEntry(outbox, key);
        persistOutbox();
        log.info(
          "원장 반영 완료",
          `paymentKey=${key} 금액=${entry.payload.amount}원` +
            (r?.idempotent ? " (서버에 이미 있던 건)" : "") +
            (entry.attempts > 0 ? ` · 재시도 ${entry.attempts}회 만에 성공` : ""),
        );
      } catch (err: any) {
        const status: number | null =
          typeof err?.status === "number" ? err.status : null;
        const body = describeErr(err);

        if (isSettled(status, body)) {
          // 서버가 "그건 이미 장부에 있다" 고 답했다. 지운다.
          outbox = removeEntry(outbox, key);
          persistOutbox();
          log.info("원장 반영 확인", `paymentKey=${key} — 서버에 이미 기록되어 있습니다.`);
          continue;
        }

        outbox = markAttempt(outbox, key, Date.now(), body);
        persistOutbox();

        const updated = outbox.find((e) => e.payload.paymentKey === key);
        const attempts = updated?.attempts ?? entry.attempts + 1;

        if (updated && isStale(updated, Date.now())) {
          // 14일이 넘었다. 자동 복구 가능 구간(getPayment 캐시 수명)을 벗어났으므로
          // 사람이 봐야 한다. 그래도 데이터는 지우지 않는다 — 수기 대사에 필요하다.
          log.error(
            "미반영 승인 장기 방치",
            err,
            `paymentKey=${key} 금액=${entry.payload.amount}원 승인번호=${entry.payload.approvalNumber}` +
              ` — 14일 넘게 원장에 반영되지 못했습니다. 원장이 직접 확인해야 합니다.`,
          );
        } else if (attempts <= 3 || attempts % 10 === 0) {
          // 매 시도마다 로그를 올리면 5분 간격이라도 며칠이면 로그가 이걸로 덮인다.
          log.warn(
            "원장 반영 재시도 예정",
            `paymentKey=${key} 금액=${entry.payload.amount}원 · ${attempts}번째 실패 · ${body.slice(0, 160)}`,
          );
        }
      }
    }
  } catch (err) {
    log.error("아웃박스 전송 중 오류", err, "다음 폴링에서 다시 시도합니다.");
  } finally {
    flushingOutbox = false;
  }
}

/** 아직 장부에 못 올린 승인이 있는가. 화면·로그 판단에 쓴다. */
function pendingConfirmCount(): number {
  return outbox.length;
}

/**
 * SDK 승인 응답을 서버 원장 형식으로 옮긴다.
 *
 * ── 0.3.11 에서 손본 이유 (원장 단말기 로그) ──
 *   단말기에 이 줄이 찍혀 있었다:
 *     backup confirm 실패 … ApiError: API /api/toss-front/payments/confirm 400: {"error":"Required"}
 *
 *   "Required" 는 zod 가 값이 undefined 일 때 쓰는 기본 문구다. 그러니까 SDK 가
 *   준 응답에 서버가 요구하는 필드 하나가 통째로 없었다는 뜻이다. 그런데 어느
 *   필드인지는 응답에 안 담겨 있었다. 하필 이 실패가 난 자리는 backup 복구 경로 —
 *   "카드 승인은 이미 났는데 서버 원장에 못 올린 결제" 를 되살리는 길이다.
 *   여기서 막히면 돈은 빠져나갔는데 장부에는 없는 상태가 그대로 굳는다.
 *
 *   requestPayment 직후의 응답과 getPayment(backup) 로 다시 읽은 응답이 같은
 *   모양이라는 보장은 어디에도 없다. 그래서 보내기 전에 무엇이 비어 있는지
 *   먼저 로그로 남긴다. 서버도 이제 어느 필드인지 이름을 돌려준다.
 *
 * 원칙: amount 는 절대 추측하지 않는다.
 *   나머지는 라벨이라 기본값을 채워도 장부의 숫자가 틀리지 않지만, 금액을
 *   추측해서 채우면 틀린 금액이 원장에 박힌다. 없으면 올리지 않고 실패시킨다 —
 *   backup 은 그대로 남으므로 다음 부팅에서 다시 시도할 수 있고, 그동안 우리는
 *   "장부에 없다" 는 사실을 알고 있는 상태가 된다. 틀린 숫자가 조용히 들어가
 *   맞는 것처럼 보이는 쪽이 훨씬 위험하다.
 */
async function confirmPaymentFromSdk(
  r: PaymentResponseSuccess,
  // RecoveryRequest 를 그대로 받을 수 있으면서, backup 복구처럼 paymentKey 하나만
  // 아는 경로도 쓸 수 있게 나머지는 optional 로 둔다.
  known?: { paymentKey: string; orderId?: string; amount?: number },
) {
  // ⚠️ known 이 왜 있나 (0.3.13 에서 고친 진짜 버그):
  //   getPayment 로 다시 읽은 캐시 응답에는 **paymentKey 도 orderId 도 amount 도
  //   없다.** 문서상 그 응답은 { paymentMethod, tid, vanTransactionKey, card } 뿐이다
  //   (docs.tossplace.com/reference/plugin-sdk/front/payment.html).
  //   그래서 SDK 응답만 들고 confirm 을 부르던 예전 복구 경로는 아래 amount 검사에
  //   걸려 죽거나, 서버까지 갔다가 400 {"error":"Required"} 를 맞았다. 0.3.11 때
  //   단말기 로그에 찍혔던 그 오류의 정체가 이것이다.
  //
  //   그래서 복구 경로에서는 서버가 확정해 둔 값(intent)을 그대로 들고 온다.
  //   금액은 원래도 서버가 정한 값만 신뢰해야 하는 것이라, 이쪽이 오히려 정석이다.
  //   서버 confirm 은 이 금액을 다시 intent.amount 와 대조하므로 이중으로 걸린다.
  const paymentKey = r.paymentKey || known?.paymentKey;
  const amount = typeof r.amount === "number" ? r.amount : known?.amount;

  const missing: string[] = [];
  if (typeof amount !== "number") missing.push("amount");
  if (!r.paymentMethod) missing.push("paymentMethod");
  if (!r.approvedAt) missing.push("approvedAt");
  if (!r.orderId && !known?.orderId) missing.push("orderId");
  if (!r.approvalNumber && !r.card?.approveNo) missing.push("approvalNumber");
  if (missing.length > 0) {
    // 값은 찍지 않는다 (카드번호가 섞일 수 있다). 어떤 키가 있었는지 이름만 남긴다.
    log.warn(
      "승인 응답에 빠진 필드",
      `없음=[${missing.join(", ")}] · 응답 키=[${Object.keys(r ?? {}).join(",")}]` +
        (known ? " · 서버 확정값으로 보완합니다." : "")
    );
  }

  if (!paymentKey) {
    throw new Error("승인 응답에도 서버 요청에도 paymentKey 가 없습니다.");
  }

  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new Error(
      "승인 응답에 결제 금액(amount)이 없습니다. 금액을 추측해 원장에 기록하지 않습니다."
    );
  }

  const payload: ConfirmPayload = {
    paymentKey,
    // 서버는 min(1) 을 요구한다. 빈 문자열이면 "Required" 가 아니라 길이 오류가
    // 나서 원인이 또 흐려지므로, 없을 때는 paymentKey 를 주문번호로 대신 쓴다.
    // paymentKey 는 우리가 intent 를 만들 때 발급한 값이라 대사에 문제가 없다.
    orderId: r.orderId || known?.orderId || paymentKey,
    amount,
    // 이 단말기는 requestPayment 에서 CASH 를 제외하고 카드만 받는다.
    paymentMethod: r.paymentMethod || "CARD",
    approvalNumber: r.approvalNumber ?? r.card?.approveNo ?? "복구",
    // 승인 시각을 모를 때 지금 시각을 쓴다. 복구 경로에서만 발생하며 몇 분
    // 어긋날 수 있다. 그래도 원장에 아예 안 들어가는 것보다 낫고, 위 경고
    // 로그가 "이 건은 시각이 추정치" 라는 사실을 남긴다.
    approvedTimestamp: r.approvedAt || new Date().toISOString(),
    van: r.van ?? null,
    tid: r.tid ?? null,
    vanTransactionKey: r.vanTransactionKey ?? null,
    maskedCardNumber: r.card?.number ?? null,
    issuerName: r.card?.issuerName ?? null,
    acquirerName: r.card?.acquirerName ?? null,
    cardType: r.card?.cardType ?? null,
    installment: r.card?.installmentMonths ?? 0,
    rawResponse: r.raw,
  };

  // ⚠️ 순서가 전부다. 적고 나서 보낸다.
  //
  //   0.3.13 까지는 여기서 곧장 confirmPayment 를 불렀다. 그 한 번이 실패하면
  //   payload 는 함수와 함께 사라지고, 카드에서 나간 돈은 장부에 영영 안 들어갔다.
  //   지금은 저장이 먼저다. 이 줄을 지나면 그 승인은 앱을 껐다 켜도 살아 있다.
  enqueueConfirm(payload);

  // 보내기는 실패해도 던지지 않는다. 아웃박스가 책임지고 계속 다시 보낸다.
  // (호출부의 "실패했다" 처리는 이제 의미가 달라졌다 — 아래 주석 참고)
  await flushOutbox(`승인 직후 (${paymentKey})`);
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
      showFatal(
        "플러그인 시작 실패",
        "관리자에게 문의해 주세요. 자세한 내용은 아래 로그를 확인하세요.",
        { onAdmin: openAdminMenu }
      );
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
