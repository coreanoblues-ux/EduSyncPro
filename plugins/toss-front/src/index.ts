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
  resetSession,
  ApiError,
  type PendingDispatch,
  type PendingCancel,
  type RecoveryRequest,
} from "./api";
import { isLongIdleGap, isPollStuck } from "./net";
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
  renderResult,
  renderSelect,
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
  isOriginalTxNotFound,
  isPaymentNotFound,
  safeRawSummary,
} from "./sdkError";
import { cancelTidField, toEpochMillis } from "./cancelPayload";
import {
  UNKNOWN_APPROVAL_NUMBER,
  describeResponseShape,
  extractApproval,
  formatCancelDiag,
  type TerminalKnownView,
} from "./approval";
import {
  showStaticNotice,
  hideStaticNotice,
  pushDiagLine,
  setScreenVersion,
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
/**
 * SDK 가 timeoutMs 를 넘기고도 답이 없을 때, 이만큼 더 기다렸다가 기록을 남긴다.
 * 결제 앱이 느린 것과 아예 끊긴 것을 가르는 선이다. 기록만 하고 흐름은 안 바꾼다.
 */
const SDK_GRACE_MS = 20_000;
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
 * 원장이 [토스 설정 열기] 로 화면을 플러그인 밖에 넘긴 상태인가.
 * (0.3.28 부터 나가는 경로는 openSetting 하나다 — setIdle 경유 나가기는 지웠다.)
 *
 * ── 이 플래그가 없으면 나가기는 여전히 안 된 것과 같다 ──
 *   폴링 루프는 우리 화면을 스스로 다시 그리는 자리가 두 곳 있다:
 *     · 연결이 끊겼다 복구되면  goIdle()
 *     · 연속 실패 5회가 되면     showResultScreen(persist)
 *   둘 다 #app 컨테이너에 화면을 새로 그린다 (0.3.26 부터는 표준 화면이지만,
 *   설정 화면을 덮어쓰는 것은 마찬가지다). 즉 원장이 설정 화면으로 잘
 *   나갔더라도, 몇 초 뒤 와이파이가 한 번 출렁이면 우리 화면이 그 위를 덮으며
 *   도로 끌고 들어온다. 원장이 신고한 "나갈 방법이 없다" 와 결과가 똑같다.
 *
 *   그래서 나간 뒤에는 폴링이 화면을 건드리지 못하게 막는다. 예외는 하나,
 *   실제 결제요청이 도착했을 때다. 그건 학생이 카드를 대려고 태블릿에서
 *   금액을 띄운 상황이라 단말기가 화면을 되찾는 것이 맞다.
 */
let exitedToHome = false;

/**
 * 화면 세대 번호 (0.3.24 — 2026-09-09 검수 반려 대응으로 표준 화면을 늘리며 도입).
 *
 * 표준 결과 화면(renderResultPage)의 onTimeout 은 SDK 타이머가 부른다. 즉 우리
 * 화면이 이미 다른 것으로 바뀐 **뒤에** 옛 화면의 타이머가 뒤늦게 깨어날 수 있다.
 * 예: 취소완료 화면의 타이머가, 그 뒤에 뜬 영수증 선택 화면을 goIdle 로 덮으면
 * 자동 출력이 통째로 사라진다. 그래서 화면을 새로 잡는 쪽(goIdle·관리자 메뉴·
 * 결제 진행·영수증 선택·showResultScreen)이 이 번호를 올리고, 뒤늦게 깨어난
 * 콜백은 번호가 다르면 아무것도 하지 않는다.
 */
let screenSeq = 0;

/**
 * 결과·안내 화면을 공식 renderResultPage 로 그리는 공용 입구 (0.3.24).
 *
 * 2026-09-09 검수 반려의 (1-b) 대응이다: 버튼이 필요한 상태·오류 화면은 전부
 * 여기로 온다. 표준 화면이 실패하면 폴백은 **조작 요소 없는 안내 텍스트**뿐이다
 * (showStaticNotice — index.html 의 정적 노드 글자만 바꾼다). 폴백에는 버튼이
 * 못 나가는 대신 화면이 스스로 사라지지 않으므로, persist 가 아닌 화면은
 * 타이머와 같은 시간 뒤에 기본 동작을 setTimeout 으로 이어 준다.
 *
 * persist=true 는 "원장이 조치할 때까지 남아야 하는" 화면용이다 (등록 실패·
 * 서버 연결 끊김 등). renderResultPage 는 timerMs(최대 10초) 뒤 반드시 onTimeout
 * 을 부르므로, 상주하려면 onTimeout 에서 같은 화면을 다시 그리는 수밖에 없다.
 * goIdle 등 다음 화면 주인이 screenSeq 를 올리면 이 반복은 저절로 멈춘다.
 */
function showResultScreen(opts: {
  status: "success" | "error";
  title: string;
  description?: string;
  /** 표준 화면에 얹을 버튼들. 폴백(텍스트 전용)에는 나타나지 않는다. */
  buttons?: Array<{ label: string; onClick: () => void }>;
  /** 3000~10000ms (renderResultPage 허용 범위). 생략하면 8000. */
  timerMs?: number;
  /** 타이머 만료 동작. 생략 시 "결제 중·나가 있는 중이 아니면 goIdle". persist 면 무시. */
  onTimeout?: () => void;
  /** true 면 타이머마다 같은 화면을 다시 그려 사실상 상주시킨다. */
  persist?: boolean;
}): void {
  const seq = ++screenSeq;
  const timerMs = Math.min(10_000, Math.max(3_000, opts.timerMs ?? 8_000));

  const fireTimeout = () => {
    if (seq !== screenSeq) return; // 이미 다른 화면이 주인이다 — 아무것도 하지 않는다
    if (opts.persist) {
      render();
      return;
    }
    if (opts.onTimeout) {
      opts.onTimeout();
      return;
    }
    if (!busy && !exitedToHome) goIdle();
  };

  const render = () => {
    if (seq !== screenSeq) return;
    const ok = renderResult(
      sdk,
      () => {
        // 오류 화면은 원장이 원인을 읽는 자리다 — 진단 로그를 함께 보인다.
        showStaticNotice({
          title: opts.title,
          detail: opts.description ?? "",
          showDiag: opts.status === "error",
        });
        // 폴백에는 SDK 타이머가 없으니 기본 동작을 우리가 이어 준다.
        // persist 화면의 폴백은 다시 그릴 필요가 없다 — 정적 안내는 숨기기
        // 전까지 스스로 사라지지 않는다.
        if (!opts.persist) setTimeout(fireTimeout, timerMs);
      },
      {
        type: "image",
        status: opts.status,
        title: opts.title,
        description: opts.description,
        buttons: opts.buttons?.map((b) => ({
          label: b.label,
          onClick: () => {
            if (seq !== screenSeq) return; // 뒤늦게 도착한 옛 화면의 클릭은 무시
            b.onClick();
          },
        })),
        timerMs,
        onTimeout: fireTimeout,
      },
    );
    if (ok) hideStaticNotice();
  };

  render();
}

/**
 * 대기화면에 뭘 띄울지. (0.3.29 부터 default — 함수 안 주석 참조.
 * 아래 oneButton 이력은 세 타입의 차이 기록으로 남긴다.)
 *
 * ── 왜 oneButton 이었나 (2026-08-29, 문서 확인 후 twoButton 에서 변경) ──
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
  // ── 0.3.29: oneButton → default (원장 요청 2026-09-11) ──
  //   "관리자 버튼 필요 없어. 화면 상단 7번 치면 관리자 모드로 갈 수 있고,
  //    대기화면이 좀 더 이뻤으면 해."
  //   type:"default" 는 토스 기본 대기화면 그대로다 — 프론트 꾸미기 배경 사진이
  //   문구·버튼에 가려지지 않고 온전히 나온다. renderIdlePage 에는 이미지·색상
  //   파라미터가 없으므로, 꾸미기 사진이 이 화면에서 가능한 디자인의 전부다.
  //   관리자 메뉴(단말기 상태 등)는 오류 화면의 [관리자 메뉴] 버튼으로 여전히
  //   들어갈 수 있다 — 진단이 필요한 순간은 어차피 오류가 떠 있는 순간이다.
  return { type: "default" };
}

/**
 * 관리자 메뉴.
 *
 * ── 0.3.29: 대기화면의 [관리자] 버튼을 지웠다 (원장 요청) ──
 *   이제 들어오는 길은 오류 화면들([단말기 등록 실패]·[서버 연결 실패]·연속 폴링
 *   실패)의 [관리자 메뉴] 버튼뿐이다. 진단([단말기 상태])이 필요한 순간은 어차피
 *   오류가 떠 있는 순간이고, 평상시 단말기 관리는 원장이 확인한 단말기 제스처
 *   (관리자 모드 진입)로 한다. 대기화면은 꾸미기 배경만 남아 제일 예쁜 상태가 됐다.
 *
 * ── 0.3.24 에서 바뀐 것 (2026-09-09 검수 반려 대응) ──
 *   0.3.11~0.3.23 은 템플릿이 실패하면 자체 DOM 메뉴(버튼 3개)를 그렸다.
 *   심사 기준상 폴백에 조작 요소를 둘 수 없으므로 그 메뉴는 지웠다. 대신
 *   표준 화면을 두 겹으로 시도한다:
 *     1순위  renderSelectPage — 목록형 메뉴. 이 화면을 위해 만들어진 API 다.
 *     2순위  renderIdlePage(twoButton) — 0.3.10 부터 검증된 기존 경로.
 *   둘 다 실패하면 조작 요소 없는 안내 문구를 띄우고 잠시 뒤 대기화면으로
 *   자동 복귀한다. 이 단말기(ensureTemplateContainer 적용 후)에서 표준 화면이
 *   둘 다 실패하는 경우는 관찰된 적이 없다.
 */
function openAdminMenu() {
  log.info("관리자 메뉴", "오류 화면의 [관리자 메뉴] 버튼으로 들어왔습니다.");
  screenSeq++; // 이제 화면 주인은 관리자 메뉴다

  const opened = renderSelect(sdk, {
    title: merchantName || "관리자",
    subtitle:
      "태블릿 없이 직접 결제하려면 [토스 설정 열기] → 플러그인을 끄세요. " +
      "결제 취소는 단말기가 아니라 토스플레이스 판매자센터(PC)에서 하세요.",
    options: [
      {
        title: "단말기 상태",
        subtitle: "서버 연결·플러그인 버전 확인 (읽기 전용)",
        onClick: () => showTerminalStatus(),
      },
      {
        title: "토스 설정 열기",
        subtitle: "단말기 설정으로 이동합니다 (플러그인 해제 후 직접 결제 가능)",
        onClick: () => openTossSetting(),
      },
    ],
    onBack: () => goIdle(),
  });
  if (opened) {
    hideStaticNotice();
    return;
  }

  const params: IdlePageParams = {
    type: "twoButton",
    title: { text1: merchantName || "관리자", text2: "무엇을 할까요?" },
    description: {
      text: "태블릿 없이 직접 결제하려면 [토스 설정 열기] → 플러그인을 끄세요.",
      subText: "결제 취소는 단말기가 아니라 토스플레이스 판매자센터(PC)에서 하세요.",
    },
    primaryButton: { text: "단말기 상태", onClick: () => showTerminalStatus() },
    secondaryButton: { text: "토스 설정 열기", onClick: () => openTossSetting() },
  };

  const rendered = renderIdle(
    sdk,
    () => {
      // 마지막 폴백: 조작 요소 없는 안내만. 6초 뒤 대기화면으로 자동 복귀 —
      // 여기 갇히면 학생 결제까지 같이 멈추기 때문이다.
      const seq = screenSeq;
      showStaticNotice({
        title: "관리자 메뉴를 열 수 없습니다",
        detail:
          "이 단말기에서 표준 메뉴 화면을 그리지 못했습니다. 잠시 후 대기화면으로 돌아갑니다. " +
          "단말기 관리는 태블릿의 원장 화면에서 할 수 있습니다.",
        showDiag: true,
      });
      setTimeout(() => {
        if (seq === screenSeq && !busy && !exitedToHome) goIdle();
      }, 6000);
    },
    params
  );
  if (rendered) hideStaticNotice();
}

// exitToTossHome() (sdk.app.setIdle 경유) 은 0.3.28 에서 지웠다.
//   2026-09-11 단말기 로그: 원장이 [첫화면으로] 를 세 번 눌렀고 setIdle 은 세 번
//   모두 성공을 응답했지만 화면은 한 번도 바뀌지 않았다. 결제 단말기 모드에서는
//   플러그인 화면이 곧 첫화면이라 setIdle 이 시각적으로 아무 일도 하지 않는 것이
//   이 펌웨어의 실제 동작이다. "토스가 실제로 그렸는지" 검증(#app 자식 노드 확인)도
//   우리 자신의 대기화면을 토스 화면으로 오인하는 가짜 양성이었다.
//   SDK 문서(sdk.app 6개 메서드)에 플러그인을 종료하는 API 는 없다. 문서에 있는
//   유일한 실제 탈출구는 openSetting 뿐이므로 관리자 메뉴 버튼을 그리로 바꿨다.
//   reportExitFailed · EXIT_WATCHDOG_MS · EXIT_VERIFY_MS 도 함께 지웠다.

/**
 * 관리자 메뉴의 [토스 설정 열기]. 0.3.28 부터 플러그인 밖으로 나가는 유일한 경로다.
 *
 * SDK 문서(sdk.app)에서 화면을 플러그인 밖으로 옮기는 API 는 openSetting 하나뿐이다.
 * 태블릿 장애 시 원장은 여기로 나가 단말기 설정에서 플러그인을 끄고, 토스 기본
 * 화면에서 금액을 직접 입력해 결제한다(토스 프론트 공식 기본 기능). 상황이 끝나면
 * 설정에서 플러그인을 다시 켠다.
 *
 * ⚠️ 아직 이 단말기에서 실제로 눌러 본 적 없는 API 다. 설정 화면이 정말 열리는지,
 *    플러그인 해제 후 직접 결제가 되는지는 단말기에서 확인해야 한다.
 */
function openTossSetting() {
  if (!sdk?.app?.openSetting) return;
  log.info("토스 설정 열기", "sdk.app.openSetting() 을 호출합니다.");
  // 설정 화면은 남에게 넘긴 화면이다. 옛 화면 타이머가 덮지 못하게 세대를 올린다.
  screenSeq++;
  hideStaticNotice();
  // 폴링이 설정 화면 위를 덮지 않게 막는다. 실패하면 아래 catch 에서 도로 푼다.
  // (결제요청이 오면 폴링 루프가 exitedToHome 을 풀고 화면을 되찾는다 — 설정을
  //  보던 중이어도 학생 결제가 막히지는 않는다.)
  exitedToHome = true;
  void sdk.app.openSetting().catch((err) => {
    exitedToHome = false;
    log.error("openSetting 실패", err, "대기화면으로 되돌립니다.");
    showResultScreen({
      status: "error",
      title: "설정 화면을 열지 못했습니다",
      description:
        "단말기에서 직접 설정으로 들어가셔야 합니다. 진입 방법은 " +
        "태블릿 화면(단말기 모드 안내)에 적어 두었습니다. " +
        "직접 결제는 설정에서 플러그인을 끈 뒤 토스 기본 화면에서 할 수 있습니다.",
      buttons: [{ label: "대기화면으로", onClick: () => goIdle() }],
      timerMs: 10_000,
      persist: true,
    });
  });
}

// notify() 는 0.3.12 에서 지웠다.
//   openToast 로 한 줄 띄우는 함수였는데, 이 펌웨어에서는 template.* 이 통째로
//   실패해서 사실상 아무것도 안 보여 주는 함수였다. 남겨 두면 다음에 또
//   "알렸다고 착각하는" 코드를 쓰게 된다. 알릴 일이 있으면 showResultScreen
//   (표준 화면, 폴백은 정적 안내)으로 그린다 — 그린 것은 원장 사진으로 확인이
//   되지만, 안 뜬 토스트는 확인할 방법이 없다.

/**
 * 관리자 메뉴의 [단말기 상태]. 결제에는 일절 관여하지 않는 읽기 전용 동작이다.
 *
 * ── 0.3.12 에서 바뀐 것 ──
 *   0.3.11 은 notify() → openToast 로 한 줄 띄우고 곧바로 goIdle() 했다.
 *   그런데 이 펌웨어에서는 template.* 이 통째로 실패한다. openToast 도 예외가
 *   아니어서, 원장이 [단말기 상태]를 눌러도 아무것도 안 뜨고 대기화면으로
 *   되돌아갈 뿐이었다. [첫화면으로] 와 똑같은 증상이고 원인도 같다.
 *
 *   이제 showResultScreen(표준 renderResultPage, 실패 시 정적 안내 폴백)으로
 *   그린다. 폴백일 때는 진단 로그도 함께 보인다. 학생이 보는 대기화면에서 로그를
 *   뺀 대신, 원장이 원인을 찾을 때 여는 곳은 여기다 — 원장이 PC 로
 *   172.30.1.91:9900 을 열 수 없는 상황도 있다.
 */
function showTerminalStatus() {
  const connected = consecutivePollErrors === 0;
  const line = connected
    ? "서버 연결: 정상"
    : `서버 연결: 끊김 (연속 실패 ${consecutivePollErrors}회)`;

  log.info("단말기 상태 확인", `${line} · v${PLUGIN_VERSION}`);

  showResultScreen({
    status: connected ? "success" : "error",
    title: connected ? "단말기 정상" : "서버와 연결이 끊겼습니다",
    description: [
      line,
      `플러그인 버전: v${PLUGIN_VERSION}`,
      `상점: ${merchantName || "(확인 안 됨)"}`,
      busy ? "지금 결제 진행 중입니다." : "결제 대기 중입니다.",
    ].join(" · "),
    buttons: [{ label: "대기화면으로", onClick: () => goIdle() }],
    timerMs: 10_000,
    // 타이머가 끝나면 기본 동작(goIdle)으로 돌아간다 — 읽기 전용 화면이라
    // 여기 상주할 이유가 없고, 학생 결제 화면을 가리면 안 된다.
  });
}

/**
 * 대기화면. 표준 renderIdlePage **만** 그린다 (0.3.26 — 2026-09-10 검수 반려 대응).
 *
 * 0.3.25 까지는 renderIdlePage 가 실패하면 자체 브랜드 대기화면(showIdle:
 * 로고·SVG 그래픽·애니메이션)을 그렸고, 그것이 "화면을 직접 구성하는 수준"
 * 으로 반려됐다. 이제 실패 시 폴백은 조작 요소 없는 정적 안내 텍스트뿐이다.
 * 안내가 떠 있어도 폴링과 결제 처리는 그대로 돈다 — 결제요청이 오면
 * handleDispatch 가 안내를 걷고 SDK 결제 UI 에 화면을 넘긴다.
 *
 * "성공했을 때만 안내를 걷는다" 는 0.3.9 원칙은 유지한다: renderIdle 이 true 를
 * 준 경우에만 hideStaticNotice(). 실패했으면 안내가 남아 단말기 앞에서 원인을
 * 읽을 수 있다 (0.3.8 까지는 함수의 "존재"만 확인하고 화면을 치워서, 렌더가
 * 터지면 완전한 빈 화면이 됐다).
 */
function goIdle() {
  // 원장이 눌러서 돌아오는 길이다. 나간 상태를 여기서 푼다.
  exitedToHome = false;
  // 이제 화면 주인은 대기화면이다. 옛 결과 화면의 타이머·persist 반복을 멈춘다.
  screenSeq++;
  const rendered = renderIdle(
    sdk,
    () => {
      // 표준 대기화면 실패. 손님이 볼 수 있는 화면이므로 진단 로그는 끈다 —
      // 원장은 [단말기 상태]·서버 로그로 원인을 본다.
      showStaticNotice({
        title: "대기화면을 표시하지 못했습니다",
        detail:
          "결제 기능은 정상 동작합니다. 학생 태블릿에서 결제 항목을 선택하면 " +
          "이 단말기에서 바로 결제가 진행됩니다. 화면이 계속 이 상태면 단말기를 재시작해 주세요.",
      });
    },
    idleParams()
  );
  if (rendered) hideStaticNotice();
}

// ─── 부팅 ──────────────────────────────────────────────────────────────

export async function bootstrap() {
  configureLogger({ serverUrl: SERVER_URL, onScreen: (line) => pushDiagLine(line) });
  installGlobalErrorHandlers();
  // 화면이 처음 그려지기 전에 버전을 알려 준다. 이 값이 화면 첫 줄에 찍히므로,
  // 원장이 보내는 단말기 사진 한 장으로 어느 ZIP 이 돌고 있는지 판별된다.
  setScreenVersion(PLUGIN_VERSION);

  log.info("plugin entry started", `version=${PLUGIN_VERSION} server=${SERVER_URL}`);

  // 1) SDK 확보.
  //
  //    ── 0.3.26: 여기서 화면을 그리지 않는다 (2026-09-10 검수 반려 대응) ──
  //      0.3.25 까지는 SDK 를 기다리기도 전에 자체 브랜드 대기화면(showIdle)을
  //      먼저 그렸다 — 즉 자체 화면이 "부팅 정상 흐름"의 일부였고, 그게 반려
  //      사유의 중심이었다. SDK 확보 전의 화면은 index.html 이 정적으로 선언한
  //      부팅 안내("플러그인을 시작하는 중")가 이미 맡고 있다. 코드는 아무것도
  //      안 그려도 검은 화면이 아니다.
  //
  //    못 찾으면 결제는 불가능하지만, 안내와 로그는 계속 살려 둔다.
  //    (여기서 조용히 return 해 버리면 다시 "아무 단서 없는 화면"이 된다)
  sdk = await waitForSdk(10_000);
  if (!sdk) {
    // SDK 자체가 없으니 표준 화면은 시도할 수 없다. 정적 안내가 유일한 수단이다.
    showStaticNotice({
      title: "결제 단말기 연결 실패",
      detail:
        "Toss Front SDK를 찾지 못했습니다. 단말기를 재시작하거나 플러그인을 다시 설치해 주세요.",
      showDiag: true,
    });
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
      showResultScreen({
        status: "error",
        title: "단말기 등록 실패",
        description: humanErr(err),
        buttons: [{ label: "관리자 메뉴", onClick: () => openAdminMenu() }],
        timerMs: 10_000,
        persist: true, // 등록이 안 된 단말기는 할 수 있는 일이 없다. 원장이 볼 때까지 남긴다.
      });
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
    showResultScreen({
      status: "error",
      title: "서버 연결 실패",
      description:
        "EduSyncPro 서버에 연결하지 못했습니다. 단말기 인터넷 연결과 등록 코드를 확인해 주세요. " +
        "연결되면 자동으로 복구됩니다.",
      buttons: [{ label: "관리자 메뉴", onClick: () => openAdminMenu() }],
      timerMs: 10_000,
      persist: true, // 네트워크가 돌아와 폴링이 복구되면 goIdle 이 이 화면을 걷는다.
    });
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
  // 감시부터 켜고 사슬을 시작한다. 첫 폴링이 곧바로 매달리는 경우까지 잡기 위해서다.
  startPollWatchdog();
  scheduleNextPoll(pollGeneration);
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

/**
 * 살아 있는 폴링 사슬의 세대 번호.
 *
 * ── 왜 필요한가 (0.3.23) ──
 *   폴링은 `setTimeout(pollOnce)` 로 자기 자신을 이어 가는 사슬이다. 사슬이
 *   한 번 끊기면 되살릴 방법이 없었다 — 그것이 "아침 첫 결제 실패" 의 실제
 *   구조였다 (net.ts 헤더 참고).
 *
 *   아래 워치독이 멈춘 사슬을 버리고 새 사슬을 시작한다. 그때 옛 사슬이 뒤늦게
 *   깨어나면 사슬이 둘이 되어 초당 두 번씩 폴링하게 되고, 그 둘이 같은 결제요청을
 *   두고 경합한다. 세대 번호가 그걸 막는다: 번호가 다른 사슬은 스스로 조용히
 *   끝난다. 되살리기보다 겹치지 않게 하는 것이 더 중요하다.
 */
let pollGeneration = 0;
/** 지금 폴링 한 바퀴가 시작된 시각. 끝나면 null. 워치독이 이걸 본다. */
let inFlightSince: number | null = null;
/**
 * 마지막으로 폴링이 살아 움직인 시각 (한 바퀴의 시작과 끝 양쪽에서 갱신).
 *
 * 끝에서도 갱신하는 이유: 60초짜리 결제가 막 끝난 직후를 "오래 쉬었다" 로 세면
 * 안 된다. 결제 중에 폴링이 멈춰 있는 것은 정상이기 때문이다. 재려는 것은
 * "한 바퀴가 끝나고 다음 바퀴가 시작되기까지" 이고, 그 정상값은 1초다.
 */
let lastPollAt: number | null = null;
let pollWatchdogTimer: ReturnType<typeof setInterval> | null = null;

function scheduleNextPoll(gen: number) {
  if (!running) return;
  // 세대가 바뀌었으면 이 사슬은 여기서 끝난다.
  if (gen !== pollGeneration) return;
  setTimeout(() => void pollOnce(gen), POLL_INTERVAL_MS);
}

/**
 * 멈춘 폴링 사슬을 버리고 새로 시작한다.
 *
 * 이 함수가 하는 일은 "다시 시도" 가 아니라 "포기하고 새로 시작" 이다. 매달려
 * 있는 요청·SDK 호출을 취소할 방법은 없으므로(그건 그대로 두고) 우리 쪽 사슬만
 * 새로 건다. 옛 사슬은 세대 번호 때문에 스스로 끝난다.
 */
function restartPollChain(why: string) {
  pollGeneration += 1;
  inFlight = false;
  inFlightSince = null;
  // 새 사슬의 첫 바퀴가 "밤새 쉬었다" 로 오해받지 않게 시계를 여기서 맞춰 둔다.
  // 세션은 바로 아래에서 어차피 새로 맺는다.
  lastPollAt = Date.now();
  // 멈춘 원인이 연결이었다면 같은 세션을 다시 쓰는 것은 같은 실패를 다시 밟는 일이다.
  resetSession();
  log.error(
    "폴링 멈춤 감지 — 다시 시작합니다",
    new Error(why),
    "결제 요청을 못 받는 상태였습니다. 단말기를 껐다 켜지 않아도 여기서 복구됩니다.",
  );
  scheduleNextPoll(pollGeneration);
}

/**
 * 폴링 사슬이 살아 있는지 감시한다.
 *
 * setTimeout 사슬과 **독립된** setInterval 이라는 점이 핵심이다. 사슬이 통째로
 * 멈춰도 이 타이머는 계속 돈다. 마지막 방어선이므로 판단은 최대한 보수적으로
 * 한다 — 결제창이 떠 있는 동안(busy)에는 무슨 일이 있어도 개입하지 않는다.
 */
const POLL_WATCHDOG_INTERVAL_MS = 5_000;

function startPollWatchdog() {
  if (pollWatchdogTimer != null) return;
  pollWatchdogTimer = setInterval(() => {
    if (!running) return;
    if (!isPollStuck(inFlightSince, Date.now(), busy)) return;
    const stuckFor = Math.round((Date.now() - (inFlightSince ?? Date.now())) / 1000);
    restartPollChain(`폴링 한 바퀴가 ${stuckFor}초째 끝나지 않았습니다.`);
  }, POLL_WATCHDOG_INTERVAL_MS);
}

async function pollOnce(gen: number) {
  if (!running) return;
  if (gen !== pollGeneration) return;
  if (busy || inFlight) {
    scheduleNextPoll(gen);
    return;
  }

  // ── 밤샘 유휴 감지 ──
  //   화면이 꺼져 웹뷰가 멈춰 있었거나 네트워크가 끊겼다 돌아온 경우다. 그
  //   상태에서 들고 있던 세션·연결은 살아 있다고 믿을 근거가 없다. 첫 결제가
  //   그 위에서 시작되지 않도록 여기서 미리 새로 맺는다. 이 한 줄이 원장이
  //   신고한 "아침 첫 결제" 를 정면으로 겨냥한다.
  const now = Date.now();
  if (isLongIdleGap(lastPollAt, now)) {
    const idleFor = Math.round((now - (lastPollAt ?? now)) / 1000);
    resetSession();
    log.warn(
      "장시간 유휴 후 첫 통신",
      `폴링이 ${idleFor}초 만에 돌아왔습니다. 서버 세션을 새로 맺고 이어 갑니다.`,
    );
  }
  lastPollAt = now;

  inFlight = true;
  inFlightSince = now;
  try {
    const { pending, recover, cancel } = await fetchPendingDispatch();

    if (consecutivePollErrors > 0) {
      log.info("backend connection 복구", `연속 실패 ${consecutivePollErrors}회 뒤 정상화되었습니다.`);
      consecutivePollErrors = 0;
      // 원장이 설정 화면으로 나가 있으면 화면을 도로 뺏지 않는다. 복구 사실은
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
      showResultScreen({
        status: "error",
        title: "서버 연결 끊김",
        description:
          "EduSyncPro 서버와 통신하지 못하고 있습니다. 인터넷 연결을 확인해 주세요. " +
          "연결되면 자동으로 복구됩니다.",
        buttons: [{ label: "관리자 메뉴", onClick: () => openAdminMenu() }],
        timerMs: 10_000,
        persist: true, // 연결이 복구되면 위쪽의 goIdle 이 이 화면을 걷는다.
      });
    }
  } finally {
    // 세대가 바뀌었다면(워치독이 이미 새 사슬을 시작했다면) 여기서 조용히 끝난다.
    // 깃발을 건드리지도, 다음 폴링을 예약하지도 않는다 — 새 사슬의 상태를
    // 뒤늦게 깨어난 옛 사슬이 덮어쓰면 그게 더 나쁜 고장이다.
    if (gen === pollGeneration) {
      inFlight = false;
      inFlightSince = null;
      // 끝난 시각도 "살아 있었다" 로 친다 (lastPollAt 선언부 주석 참고).
      lastPollAt = Date.now();
      scheduleNextPoll(gen);
    }
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

  // 화면 세대를 먼저 잡는다.
  //
  // ── 0.3.26: 자체 진행 화면(showBusy)은 지웠다 (2026-09-10 검수 반려 대응) ──
  //   "금액 + 카드를 대주세요" 를 우리가 그리는 것은 SDK 결제 UI 의 역할을
  //   흉내내는 것이고, 정확히 반려된 지점이다. 카드 삽입 안내는 아래
  //   requestPayment 가 자기 UI 로 띄운다. 우리는 화면 주인 표식(screenSeq)만
  //   올려서 남아 있던 결과 화면 타이머를 무효화하고, 정적 안내가 떠 있었다면
  //   걷어서 SDK 결제 UI 를 덮지 않게 한다.
  //   (0.3.23 에 "ack 전에 화면부터" 로 옮겼던 이유 — ack 가 매달리면 대기화면이
  //    그대로라 진행 여부를 알 수 없다 — 는 SDK UI 시대에는 성립하지 않는다.
  //    ack 는 보통 1초 안이고, 그 사이 화면은 표준 대기화면이 유지된다.)
  screenSeq++;
  hideStaticNotice();

  // ack 못 하면 다른 단말이 같은 dispatch 를 잡을 수도 있으니 실패 시 중단한다.
  try {
    await ackDispatch(d.dispatchId);
    log.info("dispatch ack", `dispatch=${d.dispatchId} DELIVERED 로 표시했습니다.`);
  } catch (err) {
    // ── 네트워크로 실패했으면 이 결제요청을 다시 집을 수 있게 풀어 준다 (0.3.23) ──
    //   pollOnce 가 handledPaymentKeys 에 먼저 넣어 두기 때문에, 여기서 그냥
    //   돌아가면 이 dispatch 는 **이 부팅 동안 두 번 다시 시도되지 않는다.**
    //   태블릿은 3분 내내 "통신 중" 만 띄우다 시간초과로 끝난다.
    //
    //   다시 집어도 이중결제가 되지 않는 근거: ack 는 PENDING → DELIVERED 조건부
    //   UPDATE 다(서버 dispatch.ts). 이미 누군가 집어갔으면 409 가 돌아오고,
    //   /dispatch/pending 은 PENDING 인 건만 내려주므로 애초에 다시 오지도 않는다.
    //   즉 "서버가 아직 아무에게도 안 준 요청" 일 때만 다시 시도된다.
    //
    //   HTTP 오류(409 등)는 서버가 내린 판단이므로 그대로 접는다. 여기서 되풀이하면
    //   남이 집어간 결제를 우리가 가로채려 드는 꼴이 된다.
    const retryable = err instanceof ApiError && err.kind === "network";
    if (retryable) handledPaymentKeys.delete(d.paymentKey);
    log.error(
      "dispatch ack 실패",
      err,
      `dispatch=${d.dispatchId} — 결제창을 띄우지 않습니다.` +
        (retryable ? " 통신 문제로 보여 다음 폴링에서 다시 시도합니다." : " 서버가 거절했으므로 접습니다."),
    );
    return;
  }

  let result: PaymentResult;
  try {
    // 할부 개월. 서버가 정규화해 내려준 값을 그대로 쓴다 — 단말기는 판정하지 않는다.
    //
    // `?? 0` 이 필요한 이유: 이 필드를 안 내려주는 구버전 서버에 붙을 수 있다.
    // undefined 를 그대로 넘기면 SDK 기본값(0)으로 처리되긴 하지만, 아래 로그에
    // "undefined" 가 찍혀 나중에 현장 로그를 읽는 사람이 헷갈린다. 여기서 확정한다.
    const installment = d.installment ?? 0;
    log.info(
      "requestPayment 호출",
      `금액=${d.amount} 공급가=${d.supplyValue} 세액=${d.tax} 할부=${installment === 0 ? "일시불" : installment + "개월"}`
    );
    // ── 응답 없는 SDK 를 기록만 해 둔다 (0.3.23) ──
    //   requestPayment 는 timeoutMs 안에 스스로 끝나야 정상이다. 그 시간을 한참
    //   넘겨도 아무 답이 없다면 단말기와 결제 앱 사이가 끊긴 것이다. 그 상태는
    //   지금까지 아무 흔적도 남기지 않아서, 원장이 "카드 넣으라는 화면이 안 뜬다"
    //   고 해도 우리가 확인할 방법이 없었다.
    //
    //   ⚠️ 기록만 하고 흐름은 건드리지 않는다. 여기서 우리가 먼저 포기하면,
    //      뒤늦게 승인이 나 있을 때 "카드는 긁혔는데 실패로 보고된" 최악이 된다.
    //      화면도 건드리지 않는다 — 결제창 위에 우리 판을 덮으면 진짜로 카드를
    //      못 넣게 만든다.
    const sdkWatchdog = setTimeout(() => {
      log.error(
        "requestPayment 무응답",
        new Error(`${Math.round((PAYMENT_TIMEOUT_MS + SDK_GRACE_MS) / 1000)}초 경과`),
        `dispatch=${d.dispatchId} — 결제 앱이 응답하지 않습니다. 계속 기다립니다. ` +
          `이 줄이 보이면 단말기 재시작이 필요한 상태였다는 뜻입니다.`,
      );
    }, PAYMENT_TIMEOUT_MS + SDK_GRACE_MS);
    try {
      result = await sdk.payment.requestPayment({
        paymentKey: d.paymentKey,
        tax: d.tax,
        supplyValue: d.supplyValue,
        taxExemptValue: d.taxExemptValue,
        tip: d.tip,
        installment,
        timeoutMs: PAYMENT_TIMEOUT_MS,
        localeCode: "ko",
        excludePaymentTypes: ["CASH"],
      });
    } finally {
      clearTimeout(sdkWatchdog);
    }
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
    // ── 승인 로그 (0.3.27 수정) ──
    //   0.3.26 까지 result.response.approvalNumber / .amount 를 직접 읽어서
    //   실기기에서 "승인번호=- 금액=undefined" 로 찍혔다 (승인번호는 공식 구조상
    //   response.card.approvalNumber 에 있고, amount 는 승인 응답에 아예 없는
    //   펌웨어가 있다). 저장 경로(confirmPaymentFromSdk)와 **같은 기준**으로 읽는다:
    //     승인번호 → extractApproval (공통 추출 로직, card.approvalNumber 우선)
    //     금액     → 응답에 숫자로 있으면 그 값, 없으면 서버 확정값 d.amount
    //   누락이면 "(확인 불가)" 로 적는다 — 임의 생성·추측 금지. 로그 실패가
    //   결제 성공 처리를 막지 않도록 try 로 감싼다.
    try {
      const logApproval = extractApproval(result.response, { paymentKey: d.paymentKey });
      const rawAmount = (result.response as Record<string, unknown>).amount;
      const logAmount =
        typeof rawAmount === "number" && Number.isFinite(rawAmount) ? rawAmount : d.amount;
      log.info(
        "결제 승인",
        `승인번호=${logApproval.approvalNumber ?? "(확인 불가)"} ` +
          `금액=${typeof logAmount === "number" && Number.isFinite(logAmount) ? `${logAmount}원` : "(확인 불가)"}`,
      );
    } catch {
      log.info("결제 승인", `paymentKey=${d.paymentKey} (상세값 추출 실패 — 승인 처리는 계속)`);
    }
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
      // ★ 우리가 보낸 d.paymentKey 를 쓴다. 응답의 paymentKey 가 아니다.
      //   공식 CARD SUCCESS 응답에는 paymentKey 가 없다 (0.3.19 에서 확인).
      //   여기서 result.response.paymentKey 를 읽으면 undefined 가 흘러들어가
      //   영수증을 엉뚱한 키로 뽑으려 한다. 원본은 언제나 **우리가 보낸 값**이다.
      await promptReceiptPrintAfterApproval(d.paymentKey);
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

  // 원거래 조회 키를 SDK 가 받는 밀리초 숫자로 바꾼다. 못 바꾸면 부르지 않는다 —
  // 틀린 키로 부르면 "원거래 없음" 이 나는데, 그때 카드가 건드려졌는지 아닌지를
  // 우리가 확신할 수 없어진다. 부르지 않으면 확신할 수 있다.
  const timestampMs = toEpochMillis(c.approvedTimestamp);
  if (timestampMs === null) {
    log.error(
      "카드 취소 불가",
      new Error(`승인 시각을 해석할 수 없음: ${String(c.approvedTimestamp)}`),
      `cancel=${c.cancelId} — 원거래를 찾을 키가 없어 단말기를 부르지 않았습니다. ` +
        `토스 사장님 앱에서 직접 취소한 뒤 원장 화면에서 장부에만 반영해 주세요.`,
    );
    await enqueueCancelReport(c, "FAILED", {
      reason: `승인 시각을 밀리초로 해석할 수 없습니다: ${String(c.approvedTimestamp)}`,
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

  // 취소 흐름이 새 화면 주인 — 남아 있던 결과 화면 타이머를 무효화하고,
  // 정적 안내가 떠 있었다면 걷는다. 카드 안내 화면은 아래 requestPaymentCancel
  // 이 자기 UI 로 띄운다 (0.3.26: 자체 진행 화면 showCancelBusy 제거 —
  // handleDispatch 의 같은 자리 주석 참고).
  screenSeq++;
  hideStaticNotice();

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

  // ── (c-2) 부르기 전에 단말기에게 먼저 **물어본다.** 읽기 전용이라 안전하다. ──
  //
  //   왜 취소 전에 하나:
  //     "원거래 없음" 이 두 번 났고 두 번 다 내가 추측으로 원인을 정했다. 원장님이
  //     ZIP 을 올리고 단말기 앞에 서는 왕복은 싸지 않은데, 시험할 결제는 1,000원
  //     한 건뿐이다. 그러니 한 번의 왕복에서 **사실도 얻고 고칠 기회도 얻어야** 한다.
  //     실패한 뒤에 물어보면 사실만 얻는다. 부르기 전에 물어보면, 단말기가 아는
  //     조회 키(tid)를 그대로 받아 이번 시도에 쓸 수 있다.
  //
  //   왜 조회 결과로 취소를 막지는 않나:
  //     getPayment 은 14일 캐시이고 SUCCESS 만 남는다. 캐시에 없다고 해서 취소가
  //     안 된다는 보장은 없다. 조회를 통과 조건으로 삼으면 정당한 환불을 막을 수
  //     있다. 그래서 이 조회는 **기록만 하고 길은 막지 않는다.**
  //
  //   ★ 그리고 이 결과를 취소 payload 에 끼워 넣지도 않는다. 진단 전용이다.
  const probed = await probeOriginalTransaction(c, timestampMs);

  // ── (c-3) 보낼 값을 **한 번만** 만든다. ──
  //
  //   로그와 실제 호출이 같은 객체를 봐야 한다. 따로 만들면 로그는 맞는데 호출은
  //   틀린 상황이 생기고, 그러면 로그가 우리를 속인다. 이번 사고에서 우리를
  //   가장 오래 붙잡은 것이 정확히 그런 종류의 거짓말이었다 (sdk.ts 의 틀린
  //   타입 선언).
  //
  //   전부 **승인 당시 서버가 받아 적은 원본**이다. 여기서 다시 계산하는 값은
  //   하나도 없다. 지금 시각도, 수강료에서 되뽑은 세액도 쓰지 않는다.
  //
  //   tid 는 문서상 **선택** 값이다. 0.3.18 까지 우리는 값이 없어도 무조건
  //   실어 보냈는데, 빈 문자열은 "없음" 이 아니라 "tid 가 '' 인 거래를 찾아라"
  //   로 읽힐 수 있다. 없는 값은 키째로 뺀다.
  const payload = {
    paymentKey: c.paymentKey, // ★ 환불 요청 ID(c.cancelId)가 아니다. 원결제 키다.
    paymentMethod: c.paymentMethod,
    // 문서: "원거래와 동일한 tax, supplyValue, taxExemptValue 를 전달해요".
    tax: c.tax,
    supplyValue: c.supplyValue,
    taxExemptValue: c.taxExemptValue,
    tip: c.tip,
    timestamp: timestampMs, // number 여야 한다. 문자열로 보내면 원거래를 못 찾는다.
    approvalNumber: c.approvalNumber,
    installment: c.installment,
    ...cancelTidField(c.tid), // 값이 없으면 키 자체가 빠진다.
  };

  // ── (c-4) [CANCEL-DIAG] — 호출 **직전** 한 덩어리. ──
  //   원장님은 단말기 로그를 사진으로 찍어 보낸다. 값이 흩어져 있으면 한 장에
  //   안 들어오고, 그러면 우리는 또 추측을 시작한다.
  log.warn(
    "취소 직전 진단",
    formatCancelDiag({
      cancelRequestId: c.cancelId,
      originalPaymentKey: c.paymentKey,
      payload,
      terminal: probed,
      van: c.van ?? null,
      vanTransactionKey: c.vanTransactionKey,
      originalCreatedAt: c.originalCreatedAt ?? null,
      rawStoredTimestamp: String(c.approvedTimestamp),
    }),
  );

  // ── (d) 단 한 번의 호출. ──
  let result: PaymentResult;
  try {
    result = await sdk.payment.requestPaymentCancel({
      ...payload,
      timeoutMs: PAYMENT_TIMEOUT_MS,
      localeCode: "ko",
    });
  } catch (err: any) {
    clearInflight(outboxStorage);
    // 후보를 전부 남긴다. 예외 하나에서 최대한 건져야 한다.
    const detail = `SDK 예외: ${errCodeCandidates(err).join(" | ") || String(err)}`.slice(
      0,
      MAX_REASON_LEN,
    );

    // ── 예외 중 딱 한 부류만 FAILED 로 보고한다 ──
    //    "원거래 없음" 은 단말기가 원거래를 특정하지 못했다는 뜻이고, 특정하지
    //    못했으면 취소를 보내지도 못했다. 카드가 건드려지지 않은 것이 확실하다.
    //    나머지 예외는 지금까지처럼 TIMEOUT 이다 — 모르면 잠그는 쪽이 맞다.
    if (isOriginalTxNotFound(err)) {
      log.error(
        "requestPaymentCancel — 원거래 없음",
        err,
        `cancel=${c.cancelId} — 단말기가 원거래를 찾지 못했습니다. 취소가 시작되지 ` +
          `않았으므로 카드는 그대로입니다. 조회 키를 고친 뒤 다시 시도할 수 있게 ` +
          `FAILED 로 보고합니다.`,
      );
      await enqueueCancelReport(c, "FAILED", { reason: detail });
      // 무엇으로 찾았는지·단말기가 그 결제를 아는지는 (c-2) 에서 이미 로그에 남았다.
      // 여기서 다시 묻지 않는다 — 같은 사실을 두 번 적으면 로그만 흐려진다.
      showResultScreen({
        status: "error",
        title: "원거래를 찾지 못했습니다",
        description:
          "단말기가 이 결제의 원거래를 찾지 못해 취소가 시작되지 않았습니다. " +
          "카드에서는 아무것도 빠져나가지 않았습니다. 원장 화면에서 다시 요청할 수 있습니다.",
        timerMs: 6000,
      });
      await sleep(6000);
      return;
    }

    // ⚠️ 그 밖의 예외에서 FAILED 로 보고하면 안 된다. 위 (2) 참고.
    log.error(
      "requestPaymentCancel 예외",
      err,
      `cancel=${c.cancelId} — 카드가 취소됐는지 알 수 없습니다. ` +
        `자동 재시도를 막기 위해 TIMEOUT 으로 보고합니다. 사장님 앱에서 실물을 확인해 주세요.`,
    );
    await enqueueCancelReport(c, "TIMEOUT", { reason: detail });
    showResultScreen({
      status: "error",
      title: "취소 결과를 확인하지 못했습니다",
      description:
        "카드가 취소됐는지 알 수 없습니다. 토스 사장님 앱에서 취소 여부를 확인해 주세요. " +
        "확인 전까지 같은 건을 다시 취소하지 마세요.",
      timerMs: 6000,
    });
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
    showResultScreen({
      status: "success",
      title: `${c.amount.toLocaleString()}원 결제취소 완료`,
      description:
        "카드사로 취소 요청이 접수되었습니다. 수납 장부에도 환불로 반영됩니다. " +
        "카드사에 따라 실제 입금까지 2~5영업일이 걸릴 수 있습니다.",
      // 2.5초 뒤 영수증 선택 화면이 이 자리를 이어받는다 (아래 sleep). 그 화면이
      // screenSeq 를 올리므로, 여기 타이머(최소 3초)가 뒤늦게 깨어나도 무해하다.
      timerMs: 3000,
    });

    // ── 취소 영수증 (서버 보고까지 끝난 뒤에만 진입) ──
    //
    // 순서를 결제 흐름과 똑같이 맞춘다: 카드 → 서버 보고 → 영수증. 영수증을
    // 먼저 뽑으면, 종이는 나왔는데 장부에는 없는 상태가 생길 수 있다.
    //
    // 여기서 어떤 예외가 나도 취소는 이미 확정이다. 프린터 실패가 위로 전파돼
    // 취소를 FAILED 로 뒤집는 일은 절대 없어야 한다 — 카드는 실제로 취소됐는데
    // 서버가 실패로 알면 원장이 같은 건을 또 취소하려 든다.
    await sleep(2500); // 취소 완료 문구를 읽을 시간
    try {
      // ★ 원거래의 paymentKey 다. 취소 거래에는 별도의 paymentKey 가 없고,
      //   문서상 printReceipt 가 받는 것도 "결제된 건의 paymentKey" 뿐이다.
      await promptReceiptPrintAfterApproval(c.paymentKey, "cancel");
    } catch (err) {
      log.error(
        "취소 영수증 흐름 예외 (무시)",
        err,
        "카드 취소와 장부 반영은 이미 완료되었습니다. 영수증 흐름 오류는 취소 결과를 바꾸지 않습니다."
      );
    }
    return; // 결제 흐름과 동일하게, 영수증 뒤에는 곧바로 유휴로 돌아간다
  } else if (type === "TIMEOUT") {
    showResultScreen({
      status: "error",
      title: "취소 결과를 확인하지 못했습니다",
      description:
        "단말기가 시간 안에 응답하지 못했습니다. 카드가 취소됐는지 알 수 없으므로 " +
        "토스 사장님 앱에서 확인해 주세요. 확인 전까지 다시 취소하지 마세요.",
      timerMs: 6000,
    });
  } else {
    showResultScreen({
      status: "error",
      title: "결제취소가 되지 않았습니다",
      description:
        `카드는 취소되지 않았습니다. (사유: ${String(detail.reason ?? "-").slice(0, 80)}) ` +
        "원장 화면에서 다시 요청할 수 있습니다.",
      timerMs: 6000,
    });
  }
  await sleep(6000);
}

/**
 * 취소를 걸기 **전에** 단말기에게 "이 결제, 너 알고 있니?" 하고 물어본다.
 *
 * ── 왜 이 함수가 생겼나 ──
 *   0.3.17 에서 timestamp 형식(ISO→밀리초)을 고쳤는데 현장에서 또 "원거래 없음"
 *   이 났다. 0.3.18 에서 타입(string→number)을 고쳤는데 **또** 났다. 두 번 다
 *   내가 추측으로 원인을 정하고 원장님께 ZIP 을 올리게 했다. 시험할 수 있는
 *   결제는 1,000원 한 건뿐이고, 단말기 앞까지 가는 왕복은 싸지 않다.
 *   그러니 이제 추측을 그만두고 **사실을 가져온다.**
 *
 * ── 왜 이 조회가 안전한가 ──
 *   getPayment 은 단말기 캐시(14일)를 **읽기만** 한다. 카드에 아무 일도 일으키지
 *   않는다. 그래서 취소 직전에 불러도 이중 취소 위험이 없다. 문서상 SUCCESS
 *   결과만 캐시에 남는다.
 *
 * ── 무엇이 갈리나 ──
 *   • 기록이 있으면 → 단말기는 이 결제를 **알고 있다.** 그러면 "원거래 없음" 의
 *     원인은 조회 키(tid·승인번호·시각) 중 하나가 틀린 것이다. 어느 것이 틀렸는지는
 *     [CANCEL-DIAG] 의 MATCH/MISMATCH 줄이 알려 준다.
 *   • 기록이 없으면 → 키를 아무리 고쳐도 소용없다는 뜻이다 (다른 단말기에서
 *     승인됐거나 보관 기간이 지났거나). 그때는 사장님 앱에서 취소하고 장부만
 *     맞추는 길로 간다. 다만 **이 조회 결과로 취소를 막지는 않는다** — 캐시가
 *     비었다고 취소가 불가능하다는 보장은 어디에도 없고, 정당한 환불을 우리
 *     추측으로 막는 쪽이 더 나쁘다.
 *
 * ── ★ 이 함수는 취소의 해결책이 아니다 (0.3.19 에서 좁혔다) ──
 *   한때 여기서 읽은 tid 를 취소 payload 에 **대신 끼워 넣었다.** 그건 원인을
 *   모르는 채 덧붙인 fallback 이었다. 값이 우연히 맞아 취소가 됐어도 우리는
 *   무엇이 틀렸었는지 영영 모르고, 다음 결제에서 또 같은 일이 난다.
 *   getPayment 은 **진단**과, 우리 DB 에 값이 아예 비었을 때의 **복구 보고**
 *   용도로만 쓴다. 취소에 실어 보내는 값은 언제나 승인 당시 우리가 받아 적은
 *   원본이다. 그래야 "받아 적기가 틀렸다" 는 사실이 드러난다 — 이번 사고의
 *   진짜 원인이 정확히 그것이었다.
 *
 * 절대 던지지 않는다. 진단이 본류를 망가뜨리면 안 된다.
 *
 * @returns 단말기가 아는 조회 키들. 모르면 null. **진단 전용.**
 */
async function probeOriginalTransaction(
  c: PendingCancel,
  sentTimestamp: number,
): Promise<TerminalKnownView | null> {
  // 무엇으로 찾았는지를 먼저 남긴다. 조회가 실패해도 이 줄은 남는다.
  //
  // 서버가 준 원문 문자열을 그대로 같이 찍는 이유: 저장된 승인 시각에 시간대가
  // 빠져 있으면 Date.parse 가 KST 기준으로 9시간을 밀어 버린다. 변환값만 봐서는
  // 그게 보이지 않는다. 원문·밀리초·사람이 읽는 시각을 나란히 놓아야 보인다.
  let human = "(해석 불가)";
  try {
    human = new Date(sentTimestamp).toISOString();
  } catch {
    /* 무시 */
  }
  log.warn(
    "원거래 조회 키 점검",
    `cancel=${c.cancelId} paymentKey=${c.paymentKey} ` +
      `원문승인시각="${String(c.approvedTimestamp)}" → ${sentTimestamp} (${human}) ` +
      `원승인번호=${c.approvalNumber} tid=${c.tid || "(없음)"} ` +
      `vanTxKey=${c.vanTransactionKey || "(없음)"} 금액=${c.amount}`,
  );

  const p = sdk?.payment;
  if (!p || typeof p.getPayment !== "function") {
    log.warn(
      "원거래 조회 불가",
      "이 단말기 펌웨어는 getPayment 를 제공하지 않습니다. 우리 기록의 조회 키로 그대로 겁니다.",
    );
    return null;
  }

  try {
    const found = await p.getPayment({ paymentKey: c.paymentKey });
    if (!found || found.type !== "SUCCESS") {
      // 단말기가 이 paymentKey 를 모른다. 그래도 취소는 걸어 본다 (위 주석 참고).
      log.warn(
        "원거래 조회 — 단말기에 기록 없음",
        `cancel=${c.cancelId} getPayment 결과=${found ? found.type : "null"} — ` +
          `단말기 캐시(14일·승인 성공분)에 이 결제가 없습니다. 여기서 또 "원거래 없음" 이 ` +
          `나면 조회 키 문제가 아니라 단말기에 원거래가 남아 있지 않은 것입니다. ` +
          `그때는 사장님 앱에서 취소한 뒤 원장 화면 [장부만] 을 쓰시면 됩니다. ` +
          `일단은 우리 기록의 키로 취소를 걸어 봅니다.`,
      );
      return null;
    }

    // 단말기는 알고 있다. 그러면 "원거래 없음" 의 원인은 조회 키다.
    // 응답에서 허용목록을 통과한 필드만 찍는다 (카드번호는 목록에 없다).
    const summary = safeRawSummary(found);
    log.warn(
      "원거래 조회 — 단말기가 알고 있음",
      `cancel=${c.cancelId} 단말기가아는값=${JSON.stringify(summary ?? {})} · ` +
        `우리가보낼값={"tid":"${c.tid || ""}","approvalNumber":"${c.approvalNumber}",` +
        `"timestamp":${sentTimestamp}}`,
    );

    // 승인 응답과 **같은 구조**이므로 같은 해석기를 쓴다. 여기만 따로 손으로
    // 파싱하면 그 자리가 또 틀릴 수 있는 자리가 된다 (이번 사고가 그랬다).
    const a = extractApproval(found.response, {
      paymentKey: c.paymentKey,
      paymentMethod: c.paymentMethod,
    });
    return {
      timestamp: a.timestamp,
      approvalNumber: a.approvalNumber,
      installment: a.installment,
      tid: a.tid,
      vanTransactionKey: a.vanTransactionKey,
    };
  } catch (err) {
    // 조회 자체가 예외로 끝났다. 이것도 사실이므로 남긴다. 카드는 그대로다.
    log.warn(
      "원거래 조회 실패",
      `cancel=${c.cancelId} — getPayment 가 예외로 끝났습니다. 우리 기록의 키로 그대로 겁니다. ` +
        `[${describeErr(err).slice(0, 160)}]`,
    );
    return null;
  }
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
 * 영수증 흐름의 종류. 문구만 다르고 절차는 완전히 같다.
 *
 * ── 왜 굳이 구분하나 ──
 *   프린터 실패 안내에 "결제는 정상적으로 완료되었습니다" 라고 적어 두었는데,
 *   취소 흐름에서 그 문장이 그대로 나오면 원장·학부모가 정반대로 읽는다.
 *   돈을 돌려준 자리에서 "결제 완료" 를 보여 주면 안 된다.
 */
type ReceiptFlow = "approval" | "cancel";

/**
 * 승인 또는 취소 완료 후 영수증 선택 화면을 띄우고, 결정에 따라 프린터를 호출한다.
 *
 * 사양 요약:
 *   - 사용자가 "영수증 출력" 을 누르면 즉시 printReceipt 1회.
 *   - "영수증 생략" 을 누르면 프린터를 호출하지 않고 종료.
 *   - 아무것도 안 누르고 8초가 지나면 자동으로 printReceipt 1회.
 *   - 위 세 진입점 중 최초 하나만 실제로 프린터를 호출한다 (중복 출력 방지).
 *
 * ── 0.3.24: 화면을 sdk.template.renderResultPage 로 전환 (2026-09-09 검수 반려 1-a) ──
 *   0.3.23 까지는 자체 DOM(버튼 2개 + 250ms setInterval 카운트다운)으로 그렸고,
 *   그것이 반려의 첫 번째 사유였다. 이제:
 *     · 1순위: renderResultPage — buttons: [영수증 출력, 영수증 생략],
 *       timerMs: 8000, onTimeout: 자동 출력. 카운트다운 표시는 SDK 타이머가
 *       대신한다 (setInterval 제거).
 *     · 폴백(표준 화면 실패 시): 조작 요소 없는 정적 안내 텍스트 + 8초 뒤 자동
 *       출력 (showStaticNotice + 단발 setTimeout). 버튼이 없으니 "생략" 은 못
 *       하지만, 자동 출력이라는 기존 기본 동작은 그대로 산다.
 *
 * ── 0.3.26: 출력 실패 안내를 **기다린다** (2026-09-10 검수 반려 대응 C) ──
 *   0.3.25 까지 doPrint 는 실패 안내(showResultScreen, 5초)를 띄우자마자
 *   resolve 했다. 그런데 이 함수의 호출부(handleDispatch / handleCancelDispatch)
 *   는 resolve 직후 finally 에서 goIdle 을 부르므로, 5초짜리 안내가 뜨자마자
 *   대기화면에 덮여 사람이 읽을 수 없었다. 이제 showReceiptFailureAndWait 가
 *   "타이머 만료 또는 [확인] 버튼" 까지 기다린 뒤에 resolve 한다. 최종 goIdle
 *   은 그대로 호출부 finally 한 곳이 책임진다 — 여기서는 부르지 않는다.
 *   영수증 실패는 결제·취소 실패로 바뀌지 않는다 (예외를 밖으로 안 던진다).
 *
 * ── 0.3.27: 종료 조건을 두 단계로 분리 ──
 *   · 선택 단계 상한 12초 — 화면 전환 등으로 버튼·타이머 콜백이 전부 무시될 때
 *     선택 없이 접는다 (출력 안 함).
 *   · 출력 단계 상한 20초(PRINT_RESULT_WAIT_MS) — 출력을 선택한 뒤 printReceipt
 *     가 응답하지 않을 때 "미확인" 으로 기록하고 흐름을 접는다. 0.3.26 까지는
 *     이 경우 promise 가 영구 pending 으로 남아 호출부 finally(busy 해제)가
 *     멈추고 다음 결제 수신까지 막혔다. 재출력하지 않고, 뒤늦은 완료·실패
 *     콜백은 로그만 남긴다 (화면 갱신 금지).
 *
 * 이중 안전 guard:
 *   1) 이 함수의 로컬 `printCalledForThisPayment` 플래그 — race 시 최종 방어선.
 *   2) 로컬 `decided` 플래그 — 출력/생략/타임아웃 세 진입점 중 최초 1개만 통과.
 *      (0.3.23 까지 screen.ts 내부에 있던 guard 를 여기로 옮겼다. 화면이 SDK
 *       소유가 되면서 버튼 disabled 처리를 우리가 못 하기 때문에, 진입점 잠금이
 *       유일한 방어가 됐다.)
 *
 * 이 함수는 예외를 밖으로 던지지 않는다. 프린터가 없거나 실패해도 결제 상태는
 * 이미 확정이므로 로그만 남기고 조용히 종료. resolve 는 항상 발생한다.
 *
 * ── 취소 영수증에 대해 (0.3.22) ──
 *   공식 문서(docs.tossplace.com/reference/plugin-sdk/front/printer.html)에 프린터
 *   메서드는 printReceipt 하나뿐이다. **취소 전용 메서드도, "취소본으로 뽑아라"
 *   같은 파라미터도 없다.** 파라미터는 paymentKey · count · orderInfo · additionalText
 *   네 개가 전부다.
 *
 *   그래서 취소도 같은 메서드를 같은 paymentKey 로 부른다. 단말기가 그 결제건의
 *   현재 상태(취소됨)를 보고 취소 전표를 뽑아 주기를 기대하는 것이다. 다만 그건
 *   **문서에 적혀 있지 않고 우리가 확인한 사실도 아니다.** 확인 못 한 것을 확인한
 *   것처럼 다루지 않기 위해 additionalText 로 취소 사실을 한 줄 박아 둔다.
 *
 *   이 한 줄이 하는 일:
 *     · 단말기가 취소 전표를 뽑아 주면 → 같은 말이 한 번 더 적힐 뿐, 해가 없다.
 *     · 단말기가 원승인 전표를 그대로 뽑으면 → 그 종이가 "결제 영수증" 으로
 *       읽히는 최악을 막는다. 환불해 준 자리에서 승인 전표를 건네면 나중에
 *       "결제한 적 없다" 와 "영수증 있다" 가 정면으로 부딪힌다.
 *   실물 확인 전까지는 이 문구가 유일한 안전장치다.
 */
/** 영수증 실패 안내를 사람이 읽을 최소 시간. renderResultPage 허용 범위(3~10초) 안. */
const RECEIPT_FAIL_NOTICE_MS = 5_000;

/**
 * printReceipt 응답을 기다리는 상한 (0.3.27).
 * 실측상 영수증 한 장은 수 초면 끝난다. 20초가 지나도 응답이 없으면 프린터 쪽이
 * 멈춘 것인데, 그때 결제 흐름까지 같이 잡아 두면 다음 결제 수신이 막힌다.
 * 상한 도달은 "출력 미확인" 이지 "출력 실패" 가 아니다 — doPrint 안의 주석 참고.
 */
const PRINT_RESULT_WAIT_MS = 20_000;

/**
 * "영수증 출력 실패" 안내를 띄우고, 안내가 제 역할을 다할 때까지 **기다린다**.
 *
 * resolve 조건 (최초 1개만 유효 — finished 플래그로 중복 통과 차단):
 *   1) renderResultPage 타이머 만료 (5초)
 *   2) [확인] 버튼 — 다 읽었으면 기다릴 이유가 없다
 *   3) 상한 setTimeout (5초+2초) — 다른 화면이 주인이 되어(screenSeq 변경)
 *      1·2 의 콜백이 영원히 오지 않는 경우에도 promise 를 pending 으로
 *      남겨 두지 않는다. 호출부의 finally(goIdle)가 멈추면 폴링 복귀까지
 *      같이 멈추기 때문이다.
 *
 * goIdle 은 부르지 않는다. 유휴 복귀는 결제·취소 흐름의 finally 한 곳이
 * 책임진다 (책임을 두 곳에 두면 이번에 고친 "안내를 덮는" 경쟁이 재발한다).
 */
function showReceiptFailureAndWait(description: string): Promise<void> {
  return new Promise<void>((resolveWait) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolveWait();
    };
    showResultScreen({
      status: "error",
      title: "영수증 출력 실패",
      description,
      buttons: [{ label: "확인", onClick: finish }],
      timerMs: RECEIPT_FAIL_NOTICE_MS,
      onTimeout: finish,
    });
    // 표준 화면 실패(정적 안내 폴백) 시에도 showResultScreen 이 같은 시간 뒤
    // fireTimeout → onTimeout(finish) 을 이어 주므로 폴백 역시 유한하다.
    setTimeout(finish, RECEIPT_FAIL_NOTICE_MS + 2_000);
  });
}

async function promptReceiptPrintAfterApproval(
  paymentKey: string,
  flow: ReceiptFlow = "approval"
): Promise<void> {
  const isCancel = flow === "cancel";
  // 프린터를 못 쓸 때 보여 줄 문장. 흐름에 따라 사실이 정반대라 반드시 갈라야 한다.
  const doneSentence = isCancel
    ? "결제취소는 정상적으로 접수되었습니다."
    : "결제는 정상적으로 완료되었습니다.";
  // 최종 방어선: 같은 paymentKey 에 대해 이번 흐름에서 printReceipt 는 최대 1회.
  let printCalledForThisPayment = false;

  return new Promise<void>((resolve) => {
    // 영수증 선택 화면이 새 화면 주인이다. 직전 화면(취소완료 등)의 타이머가
    // 뒤늦게 깨어나 이 화면을 goIdle 로 덮는 것을 막는다.
    const seq = ++screenSeq;

    // 출력/생략/타임아웃 세 진입점 중 최초 1개만 통과시키는 guard.
    let decided = false;
    const decide = (fire: () => void) => {
      if (decided) return;
      decided = true;
      try {
        fire();
      } catch (err) {
        log.error("영수증 선택 콜백 예외", err, "결제 상태에는 영향이 없습니다.");
        resolve();
      }
    };

    const doPrint = async (trigger: "user" | "timeout") => {
      if (printCalledForThisPayment) {
        // race 로 두 경로가 거의 동시에 진입해도 여기서 컷.
        log.info("영수증 중복 호출 방지", `paymentKey=${paymentKey} trigger=${trigger} 이미 처리됨`);
        resolve();
        return;
      }
      printCalledForThisPayment = true;
      log.info(
        isCancel ? "취소 영수증 출력 요청" : "영수증 출력 요청",
        `paymentKey=${paymentKey} trigger=${trigger}`
      );

      if (!sdk?.printer || typeof sdk.printer.printReceipt !== "function") {
        // 프린터 미도착·구형 펌웨어 등. 결제·취소 성공에는 영향 없음.
        log.warn(
          "printer.printReceipt 미지원",
          "SDK 에 printer 모듈이 없습니다. 실제 프린터가 연결된 뒤에 재검증합니다."
        );
        // 안내가 사람에게 읽힐 때까지 기다린 뒤 resolve — 곧장 resolve 하면
        // 호출부 finally 의 goIdle 이 이 안내를 즉시 덮는다 (0.3.26 수정 C).
        await showReceiptFailureAndWait(`${doneSentence} 프린터를 사용할 수 없습니다.`);
        resolve();
        return;
      }

      try {
        // ── 출력 단계 상한 (0.3.27) ──
        //   아래 12초 상한은 **선택 단계**만 지킨다 (decided=true 면 비켜 간다).
        //   그래서 사용자가 [출력] 을 누른 뒤 printReceipt 가 영원히 응답하지
        //   않으면 이 promise 가 pending 으로 남고, 호출부 finally(busy 해제 ·
        //   goIdle)가 멈춰 **다음 결제 수신까지 막혔다**. 출력 단계에 별도 상한을
        //   둔다. 상한 원칙:
        //     · 시간 초과 ≠ 출력 취소. 성공도 실패도 단정하지 않고 "미확인" 으로
        //       기록한다. 재출력하지 않는다 (이중 출력 위험).
        //     · 뒤늦게 도착한 완료·실패 콜백은 **로그만** 남긴다 — 그 시점의
        //       화면 주인은 다음 결제일 수 있으므로 화면을 절대 갱신하지 않는다.
        const printPromise = sdk.printer.printReceipt({
          paymentKey,
          count: 1,
          // 승인 흐름은 지금까지처럼 아무것도 덧붙이지 않는다 (현장에서 검증된 출력물이다).
          // 취소일 때만 한 줄 붙인다 — 이유는 함수 헤더 참고.
          ...(isCancel ? { additionalText: "※ 결제취소 건입니다." } : {}),
        });
        const outcome = await Promise.race([
          Promise.resolve(printPromise).then(() => "done" as const),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), PRINT_RESULT_WAIT_MS)),
        ]);
        if (outcome === "timeout") {
          log.warn(
            isCancel ? "취소 영수증 출력 응답 지연" : "영수증 출력 응답 지연",
            `paymentKey=${paymentKey} — ${Math.round(PRINT_RESULT_WAIT_MS / 1000)}초가 지나도 ` +
              `프린터 응답이 없습니다. 출력 여부는 미확인입니다 (성공·실패 단정 안 함, 재출력 안 함). ` +
              `결제 흐름은 정상 종료합니다.`,
          );
          // 뒤늦은 결과는 기록만 한다. 화면은 이미 다음 주인의 것이다.
          Promise.resolve(printPromise).then(
            () => log.info("영수증 출력 지연 완료", `paymentKey=${paymentKey} — 상한 이후 완료 응답. 화면은 갱신하지 않습니다.`),
            (err) => log.error("영수증 출력 지연 실패", err, `paymentKey=${paymentKey} — 상한 이후 실패 응답. 화면은 갱신하지 않습니다.`),
          );
          resolve();
          return;
        }
        log.info(isCancel ? "취소 영수증 출력 완료" : "영수증 출력 완료", `paymentKey=${paymentKey}`);
        // 성공 시 별도 안내 화면을 오래 띄우지 않는다. 유휴 복귀가 자연스럽다.
      } catch (err) {
        // 종이 없음 / 프린터 오프라인 / 권한 거부 등. 결제·취소 상태와 완전히 분리.
        log.error(
          isCancel ? "취소 영수증 출력 실패" : "영수증 출력 실패",
          err,
          isCancel
            ? "카드 취소와 장부 반영은 이미 끝난 상태이며 이 오류는 취소 결과를 되돌리지 않습니다."
            : "카드 승인·원장 반영은 이미 완료된 상태이며 이 오류는 결제에 영향을 주지 않습니다."
        );
        // 위와 같은 이유로, 안내를 다 보여 준 뒤에야 resolve 로 넘어간다.
        await showReceiptFailureAndWait(`${doneSentence} 영수증 출력에 실패했습니다.`);
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
      log.info(
        isCancel ? "취소 영수증 생략" : "영수증 생략",
        `paymentKey=${paymentKey} 사용자가 생략을 선택`
      );
      resolve();
    };

    // 취소한 자리에서 "결제가 완료되었습니다" 가 뜨면 사실과 정반대다.
    // 승인 흐름은 현장에서 검증된 기존 문구를 그대로 쓴다.
    const title = isCancel ? "결제가 취소되었습니다" : "결제가 완료되었습니다";

    const rendered = renderResult(
      sdk,
      () => {
        // 폴백: 조작 요소 없는 정적 안내 + 8초 뒤 자동 출력 (기존 기본 동작 유지).
        // 버튼이 없으니 "생략"은 못 하지만 자동 출력은 산다. 타이머는 seq 가드
        // 아래에 있다 — 화면 주인이 바뀐 뒤 깨어난 옛 타이머가 프린터를 부르거나
        // 화면을 덮는 일이 없게 한다 (남는 경우는 아래 상한이 접는다).
        showStaticNotice({
          title,
          detail: "잠시 후 영수증이 자동으로 출력됩니다. (약 8초)",
        });
        setTimeout(() => {
          if (seq !== screenSeq) return;
          decide(() => void doPrint("timeout"));
        }, 8_000);
      },
      {
        type: "image",
        status: "success",
        title,
        description: "영수증을 출력하시겠습니까? 8초 후 자동으로 출력됩니다.",
        buttons: [
          {
            label: "영수증 출력",
            onClick: () => {
              if (seq !== screenSeq) return;
              decide(() => void doPrint("user"));
            },
          },
          {
            label: "영수증 생략",
            onClick: () => {
              if (seq !== screenSeq) return;
              decide(() => doSkip());
            },
          },
        ],
        timerMs: 8_000,
        onTimeout: () => {
          if (seq !== screenSeq) return;
          decide(() => void doPrint("timeout"));
        },
      },
    );
    if (rendered) hideStaticNotice();

    // 상한 (0.3.26): 화면 주인이 바뀌어(seq 변경) 버튼·타이머 콜백이 전부
    // 무시되는 경우, 이 promise 가 pending 으로 영원히 남으면 호출부 finally
    // (busy 해제·goIdle)까지 같이 멈춘다. 그 경우 선택 단계만 조용히 접는다 —
    // 프린터는 부르지 않는다 (자동 출력을 상한에서 하면 이중 출력 위험만 는다).
    setTimeout(() => {
      if (decided) return;
      decided = true;
      log.warn(
        "영수증 선택 종료",
        `paymentKey=${paymentKey} — 화면이 전환되어 선택 없이 종료합니다 (출력 안 함).`
      );
      resolve();
    }, 12_000);
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

  // 등록 화면은 공식 sdk.template.renderOnboardingPage **만** 쓴다.
  //
  // ── 0.3.24 에서 자체 폴백 폼을 지운 이유 (2026-09-09 검수 반려 1-b) ──
  //   0.3.5~0.3.23 은 표준 화면이 실패하면 자체 입력폼(매장코드·PIN input)으로
  //   폴백했다. 심사 기준상 폴백에 허용되는 것은 조작 요소 없는 안내 텍스트까지다.
  //   입력폼은 그 선을 넘고, 실제로 반려 사유에 "6개 입력 필드" 로 명시됐다.
  //
  //   표준 화면이 실패하면 이제 그냥 던진다. bootstrap 의 catch 가 원인을
  //   "단말기 등록 실패" 화면(표준 renderResultPage, persist)에 띄운다. 등록은
  //   첫 부팅에 한 번뿐인 흐름이고, ensureTemplateContainer 적용(0.3.7~) 이후
  //   renderOnboardingPage 가 실패하는 단말기는 관찰된 적이 없다. 폼을 되살리면
  //   다시 반려된다 — pack 스크립트 가드가 이를 빌드 단계에서 막는다.
  const t = sdk?.template;
  if (!t || typeof t.renderOnboardingPage !== "function") {
    throw new Error(
      "이 단말기 펌웨어에서 표준 등록 화면(renderOnboardingPage)을 열 수 없습니다. " +
        "단말기를 재시작한 뒤에도 반복되면 플러그인을 다시 설치해 주세요."
    );
  }

  // 정적 안내(#boot)는 position:fixed 전체화면이라 그대로 두면 SDK 등록 화면을
  // 덮는다. 넘겨주기 전에 숨긴다 (0.3.26: 0.3.25 까지는 여기서 자체 화면만
  // 치우고 #boot 은 남겨서, 부팅 안내가 등록 화면을 덮을 수 있었다 — 문제 D.
  // renderOnboardingPage 가 실패하면 아래 catch → bootstrap 의 showResultScreen
  // persist 폴백이 안내를 되살리므로 빈 화면으로 끝나지 않는다).
  hideStaticNotice();
  return await new Promise<string>((resolve, reject) => {
    try {
      t.renderOnboardingPage!({
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
        onSubmit: async (values) => {
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
      // renderOnboardingPage 가 그 자리에서 던졌다 (React #299 등).
      // 자체 폼으로 대체하지 않는다 — bootstrap catch 가 표준 오류 화면을 띄운다.
      reject(
        err instanceof Error
          ? err
          : new Error("표준 등록 화면을 그리지 못했습니다: " + describeErr(err))
      );
    }
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
  const paymentKey = known?.paymentKey || r.paymentKey;
  const amount = typeof r.amount === "number" ? r.amount : known?.amount;

  if (!paymentKey) {
    throw new Error("승인 응답에도 서버 요청에도 paymentKey 가 없습니다.");
  }

  // ★ 0.3.19 의 핵심 한 줄.
  //   지금까지는 여기서 r.approvedAt / r.approvalNumber 처럼 **존재하지 않는
  //   필드**를 읽고, 없으면 `new Date()` 와 "복구" 로 메웠다. 그 두 값이 그대로
  //   취소 조회 키가 되어 현장에서 "원거래 없음" 을 만들었다.
  //   이제 공식 구조(response.card.timestamp / card.approvalNumber)에서 읽고,
  //   없으면 **없다고 적는다.** 자세한 경위는 approval.ts 머리주석에 있다.
  const approval = extractApproval(r, { paymentKey });

  // 응답에 실제로 어떤 키가 있었는지 이름만 남긴다 (값은 카드번호가 섞일 수 있다).
  // 이번 사고에서 우리에게 없었던 단서가 정확히 이 한 줄이다.
  log.info(
    "승인 응답 구조",
    `${describeResponseShape(r)} · 시각출처=${approval.timestampSource ?? "(없음)"} ` +
      `승인번호출처=${approval.approvalNumberSource ?? "(없음)"}`,
  );

  if (approval.missing.length > 0) {
    log.warn(
      "승인 응답에 취소용 조회 키가 없음",
      `없음=[${approval.missing.join(", ")}] — 이 결제는 장부에는 정상 기록되지만 ` +
        `단말기 카드취소를 걸 수 없습니다. 환불이 필요하면 토스 사장님 앱에서 취소한 뒤 ` +
        `원장 화면에서 [장부만] 반영해 주세요.`,
    );
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
    orderId: known?.orderId || r.orderId || paymentKey,
    amount,
    paymentMethod: approval.paymentMethod,
    // ⚠️ 아래 두 값은 **원거래 조회 키**다. 추측해서 채우면 취소가 영구히 불가능해진다.
    //    모를 때는 표식을 보낸다 — 서버가 이 표식을 보고 카드취소를 거절하고,
    //    원장에게 "사장님 앱에서 취소하고 장부만 반영하라" 고 안내한다.
    //    (장부 기록 자체는 막지 않는다. 카드에서 나간 돈은 반드시 기록되어야 한다.)
    approvalNumber: approval.approvalNumber ?? UNKNOWN_APPROVAL_NUMBER,
    // 단말기가 준 epoch 밀리초를 **문자열 그대로** 보낸다 (컬럼이 text 인 이유이자
    // 정밀도를 잃지 않는 방법이다). 모르면 "UNKNOWN" — 서버가 걸러 낸다.
    approvedTimestamp:
      approval.timestamp !== null ? String(approval.timestamp) : UNKNOWN_APPROVAL_NUMBER,
    van: approval.van,
    tid: approval.tid,
    vanTransactionKey: approval.vanTransactionKey,
    maskedCardNumber: approval.maskedCardNumber,
    issuerName: approval.issuerName,
    acquirerName: approval.acquirerName,
    cardType: approval.cardType,
    installment: approval.installment,
    // 감사용. 허용목록을 통과한 필드만 담긴다 (카드번호는 목록에 없다).
    // 지금까지 r.raw 를 보냈는데 그건 존재하지 않는 필드라 늘 null 이었다 —
    // 그래서 사고 후에 되짚어 볼 원본이 한 건도 남아 있지 않았다.
    rawResponse: safeRawSummary({ type: "SUCCESS", response: r }) ?? undefined,
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
      showResultScreen({
        status: "error",
        title: "플러그인 시작 실패",
        description: "관리자에게 문의해 주세요. 자세한 내용은 단말기 로그를 확인하세요.",
        timerMs: 10_000,
        persist: true, // 시작에 실패한 단말기는 돌아갈 화면이 없다. 원장이 볼 때까지 남긴다.
      });
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
