/**
 * Toss Front 2 Plugin SDK 런타임 바인딩.
 *
 * ── 0.2.x 검은 화면의 직접 원인이 여기였다 ──
 *   index.ts 가 `declare const sdk: {...}` 로만 SDK 를 선언하고 있었다.
 *   TypeScript 의 `declare` 는 타입만 만들고 자바스크립트를 단 한 줄도 내보내지 않는다.
 *   즉 번들에는 `sdk` 라는 변수가 존재하지 않았고, bootstrap() 의 첫 줄
 *   `sdk.storage.getItem("deviceKey")` 에서 곧바로 ReferenceError 가 났다.
 *   그 예외는 `.catch(err => console.error(...))` 한 줄에 삼켜졌고, 화면에는
 *   index.html 의 `background:#000` 만 남았다. 그래서 "플러그인 실행중" 다음이
 *   완전한 검은 화면이었다.
 *
 * ── 이 파일이 하는 일 ──
 *   1. 단말기가 주입한 전역 객체를 런타임에 찾는다.
 *   2. 못 찾으면 어떤 전역이 실제로 있는지를 로그로 남긴다. 이름을 추측해서
 *      조용히 실패하는 대신, 현장 로그만 보고 정확한 이름을 알 수 있게 한다.
 *   3. 존재하지 않는 SDK 메서드는 절대 만들어 쓰지 않는다. 없으면 없다고 로그하고
 *      그 기능만 건너뛴다 (예: renderIdlePage 가 없으면 자체 대기화면으로 대체).
 */

import { describeError, log } from "./logger";

/**
 * CARD 승인 성공 응답. **공식 문서 기준으로 다시 썼다 (0.3.19).**
 *
 * ⚠️ 0.3.18 까지 이 타입은 우리가 상상해서 쓴 것이었다. 이렇게 적혀 있었다:
 *
 *      approvalNumber?: string;      // ← 최상위에 없다
 *      approvedAt: string;           // ← 아예 존재하지 않는다
 *      card?: { approveNo?: string; installmentMonths?: number };
 *      van?: string;                 // ← card 안에 있다
 *
 *    문서의 실제 구조는 아래와 같다:
 *
 *      response.paymentMethod
 *      response.tid
 *      response.vanTransactionKey
 *      response.card.timestamp        ← 승인 시각 (원거래 조회 키)
 *      response.card.approvalNumber   ← 승인번호  (원거래 조회 키)
 *      response.card.installment
 *      response.card.van
 *      response.card.shopCode
 *
 *    존재하지 않는 필드를 읽으면 undefined 가 나오고, 우리 코드는 그 자리에
 *    "복구" 와 `new Date()` 를 채워 넣었다. 그 두 값이 그대로 취소 조회 키가 되어
 *    현장에서 "원거래 없음" 을 세 번 만들었다. 이 저장소에서 **네 번째** 로
 *    "내가 쓴 타입 선언이 사실인 줄 알았다" 가 사고의 원인이 된 사례다.
 *
 *    그래서 필수/선택 표기도 문서를 따른다. amount·paymentKey·orderId 는
 *    응답에 없다 — 그 값들은 우리가 요청할 때 쓴 값을 그대로 들고 있어야 한다.
 */
export type PaymentResponseSuccess = {
  paymentMethod: "CARD" | "CASH" | "BARCODE";
  tid?: string;
  vanTransactionKey?: string;
  card?: {
    /** 승인 시각(epoch ms). **원거래 조회 키.** 예) 1723628943812 */
    timestamp?: number;
    /** 승인번호. **원거래 조회 키.** 앞자리 0 이 의미를 가지므로 문자열로 다룬다. */
    approvalNumber?: string;
    /** 할부 개월. 일시불은 0. */
    installment?: number;
    van?: string;
    shopCode?: string;
    /** 마스킹된 카드번호. 표시용이며 저장·전송하지 않는 편이 안전하다. */
    number?: string;
    issuerName?: string;
    acquirerName?: string;
    cardType?: string;
  };

  // ── 아래는 "있으면 쓰고 없으면 만다" 는 대비용이다. 문서에는 없다. ──
  //    approval.ts 가 공식 필드를 먼저 보고, 이 이름들은 그 다음에만 본다.
  //    ⚠️ 이 필드들이 **있을 것이라고 가정하고 코드를 쓰면 안 된다.** 그게 이번 사고다.
  paymentKey?: string;
  orderId?: string;
  amount?: number;
  approvalNumber?: string;
  approvedAt?: string;
  van?: string;
  raw?: any;
};

export type PaymentResult =
  | { type: "SUCCESS"; response: PaymentResponseSuccess }
  | { type: "CANCELED"; reason?: string }
  | { type: "TIMEOUT"; reason?: string }
  | { type: "FAILED"; code?: string; message?: string };

/**
 * renderIdlePage 파라미터.
 *
 * ⚠️ 이전 버전은 이 함수를 `renderIdlePage?(): void` 로 선언해 두고 있었다. 그건 틀렸다.
 *    공식 문서(docs.tossplace.com · Template API)를 직접 확인한 결과 인자를 받는다.
 *    선언이 틀려 있었기 때문에 "대기화면은 Toss 가 그리는 거라 우리가 못 바꾼다"고
 *    결론 내렸었고, 그래서 단말기에 빨간 IP 주소만 뜨는 화면을 방치했다.
 *    타입 선언 하나가 기능 하나를 통째로 없앤 셈이다.
 *
 * 인자를 생략하면 type:"default" 와 같다 — 지금까지 보던 그 화면이다.
 */
export type IdlePageParams =
  | { type: "default" }
  | {
      type: "oneButton";
      button: { text: string; subText?: string; onClick: () => void };
      description?: { text: string; subText?: string };
    }
  | {
      type: "twoButton";
      title: { text1: string; text2: string; text3?: string };
      description?: { text: string; subText?: string };
      primaryButton: { text: string; onClick: () => void };
      secondaryButton: { text: string; onClick: () => void };
    };

export interface TossFrontSdk {
  template?: {
    renderIdlePage?(params?: IdlePageParams): void;
    /** 짧은 안내 문구. 화면 전환 없이 뜬다. */
    openToast?(params: { message: string }): void;
  };
  /**
   * 프린터 모듈. 공식 문서 signature 를 그대로 옮겼다.
   *   sdk.printer.printReceipt({ paymentKey, count, orderInfo?, additionalText? })
   *
   * 이번 버전은 승인 완료 후 사용자가 선택(또는 8초 자동)했을 때 { paymentKey, count: 1 } 만
   * 넘겨 승인 영수증 1장을 뽑는 최소 사용만 한다. orderInfo / additionalText 는 추후 필요 시.
   *
   * 런타임에 이 모듈이 없을 수 있어(구형 펌웨어 / 프린터 미연결 단말) optional 로 둔다.
   * 호출부는 반드시 존재 여부를 확인하고 부재 시 조용히 건너뛴다.
   */
  printer?: {
    printReceipt(input: {
      paymentKey: string;
      count: number;
      orderInfo?: Record<string, unknown>;
      additionalText?: string;
    }): Promise<void>;
  };
  payment: {
    requestPayment(input: {
      paymentKey: string;
      tax: number;
      supplyValue: number;
      taxExemptValue: number;
      tip: number;
      /**
       * 할부 개월. **선택 값이고 기본값은 0(일시불)** 이다.
       *
       * 출처: docs.tossplace.com/reference/plugin-sdk/front/payment.html
       *       (파라미터 표 `installment | number | 선택 | 기본값 0 | 할부 개월`)
       *
       * ⚠️ 0.3.20 까지 이 줄이 없었다. requestPaymentCancel 쪽에는 진작
       *    선언돼 있었는데(188행) 결제 쪽에만 빠져 있어서, 할부를 보내려면
       *    SDK 를 고쳐야 하는 줄 알기 쉬운 상태였다. 실제로는 **SDK 는 처음부터
       *    지원했고 우리 타입 선언에만 구멍이 있었다** — timestamp 가 string 으로
       *    잘못 적혀 있어 "원거래 없음" 을 받던 0.3.17 사고와 정확히 같은 종류다.
       *    타입 선언은 사실이 아니라 주장이다. 문서와 대조해야 사실이 된다.
       *
       * 허용 개월수 목록은 문서에 없다. 카드사·VAN 이 정하기 때문이다. 그래서
       * 요청한 개월수와 **승인된 개월수**(응답 card.installment)를 반드시 따로
       * 기록한다. 취소는 승인된 값으로 걸어야 원거래를 찾는다.
       */
      installment?: number;
      timeoutMs?: number;
      localeCode?: string;
      excludePaymentTypes?: Array<"CASH" | "CARD" | "BARCODE">;
    }): Promise<PaymentResult>;
    getBackupPaymentKey?(): Promise<string | null>;
    getPayment?(input: { paymentKey: string }): Promise<PaymentResult | null>;
    resetBackupPaymentKey?(): Promise<void>;
    /**
     * 카드 취소. 원거래 승인 정보를 그대로 되돌려 준다.
     *
     * ⚠️ 0.3.14 까지 이 선언이 없었다. 그래서 "Front SDK 로는 단말기 취소가
     *    불가능하다" 고 잘못 결론 내렸었다 — renderIdlePage 때와 똑같은 실수다.
     *    타입 선언이 없는 것과 SDK 에 기능이 없는 것은 전혀 다른 사실이다.
     *    출처: docs.tossplace.com/reference/plugin-sdk/front/payment.html
     *
     * 문서가 "원거래와 동일한 tax, supplyValue, taxExemptValue 를 전달해요" 라고
     * 못박으므로 **부분 취소는 불가능하다.** 서버가 전액만 내려보내는 이유다.
     *
     * optional 인 이유: 구형 펌웨어에 이 메서드가 없을 수 있다. 없으면 취소를
     * 걸지 않고 서버에 FAILED 로 보고한다. 있는 척 부르면 예외가 나는데, 그
     * 예외 시점에 카드가 건드려졌는지 아닌지를 알 수 없어 최악이다.
     */
    requestPaymentCancel?(input: {
      paymentKey: string;
      paymentMethod: "CARD" | "CASH" | "BARCODE";
      tax: number;
      supplyValue: number;
      taxExemptValue: number;
      tip: number;
      /**
       * 원승인 시각 (밀리초). 원거래 조회 키다.
       *
       * ⚠️ **number 다. string 이 아니다.** 0.3.17 까지 이 줄이 `string` 으로
       *    잘못 선언돼 있었고, 그래서 문자열 "1756555555000" 을 보내며
       *    "원거래 없음" 을 받고 있었다. 값이 아니라 타입이 틀린 것이었다.
       *    출처: docs.tossplace.com · Front SDK · payment
       *          (파라미터 표 `timestamp | number | 필수`, 예 1723628943812)
       */
      timestamp: number;
      /** 원승인번호. */
      approvalNumber: string;
      installment: number;
      /**
       * 결제 TID (CAT ID). 문서상 **선택** 값이다 (`tid | string | 선택`).
       * 그러므로 없을 때는 빈 문자열을 채워 넣지 말고 키 자체를 빼야 한다.
       * 빈 문자열은 "없음" 이 아니라 "빈 값으로 찾아라" 로 읽힐 수 있다.
       */
      tid?: string;
      timeoutMs?: number;
      localeCode?: string;
    }): Promise<PaymentResult>;
    /**
     * 카드 없이 취소 (NICE VAN 전용). 카드 재삽입이 필요 없다.
     * 지금은 쓰지 않는다 — VAN 사가 NICE 인지 확인되지 않았고, 확인 못 한 채
     * 부르면 실패하는데 그 실패 시점의 카드 상태를 알 수 없다.
     */
    requestCardlessPaymentCancel?(input: Record<string, unknown>): Promise<PaymentResult>;
    /** 취소 이력 조회 (복구용). TTL 14일. 3단계에서 실물 응답을 본 뒤 붙인다. */
    getPaymentCancel?(input: { paymentKey: string }): Promise<PaymentResult | null>;
  };
  /**
   * Toss 공식 sdk.storage 는 객체 인자를 받는다:
   *   await sdk.storage.set({ key: "token", value: "..." });
   *   const { value } = await sdk.storage.get({ key: "token" });
   * 일부 펌웨어에 legacy 스타일(getItem/setItem) 이 남아 있을 수 있어 둘 다 지원한다.
   */
  storage?: {
    get?(input: { key: string }): Promise<{ value: string | null } | null>;
    set?(input: { key: string; value: string }): Promise<void>;
    getItem?(key: string): Promise<string | null>;
    setItem?(key: string, value: string): Promise<void>;
  };
  app?: {
    getSerialNumber?(): Promise<{ serialNumber: string }>;
    getMerchant?(): Promise<{ id: number; name: string; businessNumber: string }>;
    isDebugMode?(): Promise<{ isDebugMode: boolean }>;
    restartOnboarding?(): Promise<void>;
    openSetting?(): Promise<void>;
    setIdle?(): Promise<void>;
  };
}

/**
 * SDK 전역 이름 후보.
 *
 * ── 이번 회차에서 확정된 사실 (Toss 공식 템플릿 sdk.js 인용) ──
 *   var sdk = window.TossFrontSDK;
 *
 *   출처: github.com/tossplace/toss-front-plugin-template
 *         → front-plugin-js/sdk.js
 *         → front-plugin-js/index.html (< script src="https://cdn.tossplace.com/toss-front-sdk/v0/index.js">)
 *
 *   즉 표준 이름은 정확히 `TossFrontSDK` 하나이며, 이건 CDN 스크립트가 실행돼야 생긴다.
 *   0.3.0 로그가 `실제 전역 후보=[TossFront]` 만 남긴 이유는 CDN 스크립트를 로드하지
 *   않아 `TossFrontSDK` 가 생성되지 않았기 때문이다. index.html 에 script 태그를
 *   붙여 그 문제는 해결했고, 여기서는 표준 이름을 맨 앞으로 올려 명확히 우선한다.
 *
 *   나머지 후보는 만에 하나 펌웨어 별칭이 있을 경우의 안전망이지, 이제 기본 경로는 아니다.
 */
const SDK_GLOBAL_CANDIDATES = [
  "TossFrontSDK", // Toss 공식 이름 (CDN 스크립트가 만든다)
  "sdk",          // 공식 예제 코드는 `var sdk = window.TossFrontSDK` 로 alias 를 만들어 이 이름을 함께 쓴다
  "TossFront",    // 일부 펌웨어에 남아 있는 legacy 별칭 관찰
  "tossFront",
  "tossFrontSdk",
  "__tossFront",
  "tossplace",
  "TossPlace",
];

/** SDK 라고 부를 수 있는 최소 조건: payment.requestPayment 가 함수여야 한다. */
function looksLikeSdk(candidate: any): candidate is TossFrontSdk {
  return (
    candidate &&
    typeof candidate === "object" &&
    candidate.payment &&
    typeof candidate.payment.requestPayment === "function"
  );
}

let cached: TossFrontSdk | null = null;

/** 지금 이 순간 SDK 를 찾는다. 못 찾으면 null. */
export function findSdk(): TossFrontSdk | null {
  if (cached) return cached;
  const g = globalThis as any;
  for (const name of SDK_GLOBAL_CANDIDATES) {
    if (looksLikeSdk(g[name])) {
      cached = g[name];
      log.info("SDK initialized", `전역 "${name}" 에서 SDK 를 찾았습니다.`);
      return cached;
    }
  }
  return null;
}

/**
 * SDK 가 주입될 때까지 기다린다.
 *
 * 플러그인 스크립트가 SDK 주입보다 먼저 실행되는 경우가 있어 즉시 포기하면 안 된다.
 * 100ms 간격으로 최대 timeoutMs 까지 재확인한다.
 */
export async function waitForSdk(timeoutMs = 10_000): Promise<TossFrontSdk | null> {
  const started = Date.now();
  let announcedWait = false;
  while (Date.now() - started < timeoutMs) {
    const found = findSdk();
    if (found) return found;
    if (!announcedWait) {
      announcedWait = true;
      log.info("SDK 주입 대기", `아직 SDK 전역이 없습니다. 최대 ${timeoutMs}ms 기다립니다.`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // 실패했을 때 "무엇이 있었는지" 를 남긴다. 이게 있어야 다음 시도에서 이름을 맞춘다.
  log.error(
    "SDK 미발견",
    new Error("Toss Front SDK 전역을 찾지 못했습니다."),
    `찾아본 이름=[${SDK_GLOBAL_CANDIDATES.join(", ")}] / 실제 전역 후보=[${describeGlobals()}]`
  );
  return null;
}

/**
 * 전역에서 SDK 로 보일 만한 것들의 이름을 추려 로그에 남긴다.
 * 값은 절대 찍지 않는다 (토큰이 섞여 있을 수 있다). 이름과 타입만 남긴다.
 */
function describeGlobals(): string {
  try {
    const g = globalThis as any;
    const names = Object.getOwnPropertyNames(g)
      .filter((n) => {
        if (/^(window|self|globalThis|document|location|navigator|top|parent|frames)$/.test(n)) return false;
        const v = g[n];
        return v && typeof v === "object" && !Array.isArray(v);
      })
      .filter((n) => /toss|front|sdk|plugin|pay/i.test(n));
    return names.length > 0 ? names.join(", ") : "(관련 이름 없음)";
  } catch {
    return "(전역 열거 실패)";
  }
}

/**
 * sdk.template 이 실제로 무엇을 제공하는지 한 줄로 적는다.
 *
 * 왜 남겨 두나:
 *   시그니처는 이제 공식 문서로 확인했다(renderIdlePage 는 params 를 받는다).
 *   그래도 이 진단은 계속 둔다 — 펌웨어 버전마다 template 에 있는 메서드가 다를 수 있고,
 *   "우리 대기화면이 왜 안 나오지" 를 단말기 앞에서 판단하려면 그 단말기가 실제로
 *   무엇을 갖고 있는지 봐야 한다. 함수의 `length` 는 선언된 인자 개수다. 0 이 찍히면
 *   그 펌웨어는 구형이라 커스터마이즈가 안 되는 것이고, 그때는 기본 화면으로 내려간다.
 *
 * 결과는 로그로 서버에 올라가고 대기화면 진단 줄에도 찍히므로, 단말기 앞에서
 * 바로 읽을 수 있다.
 */
function describeTemplateApi(template: NonNullable<TossFrontSdk["template"]>): string {
  try {
    const parts: string[] = [];
    for (const key of Object.keys(template)) {
      const value = (template as Record<string, unknown>)[key];
      parts.push(typeof value === "function" ? `${key}(${(value as Function).length})` : key);
    }
    return parts.length > 0 ? parts.join(", ") : "(빈 객체)";
  } catch {
    return "(열거 실패)";
  }
}

/** template API 모양은 부팅당 한 번만 남긴다. 대기화면은 자주 다시 그려지므로 로그가 밀린다. */
let templateApiLogged = false;

/** SDK 의 React 앱이 마운트하는 컨테이너. index.html 이 만들어 두는 노드다. */
const TEMPLATE_CONTAINER_ID = "root";

/**
 * renderIdlePage 를 부르기 **전에** 마운트 지점이 실제로 문서에 붙어 있는지 본다.
 *
 * ── 왜 (React #299) ──
 *   sdk.template.* 는 내부에서 createRoot(document.getElementById("root")) 를 한다.
 *   그 노드가 없으면 createRoot(null) 이 되어 단말기에 이 문구가 뜬다:
 *       Minified React error #299 = "Target container is not a DOM element"
 *
 *   index.html 은 이 노드를 스크립트보다 위에 두고, 우리 코드는 이 노드를 절대
 *   지우지 않는다(screen.ts 는 자기 전용 #edusync-front-root 만 만들고 지운다).
 *   그런데도 여기서 한 번 더 확인하는 이유는 두 가지다:
 *
 *     1. 우리가 확인할 수 없는 것이 남아 있다. 단말기 웹뷰가 문서를 다시 그리거나
 *        SDK 가 자기 화면을 넘겨받으며 노드를 치우는 경우를 우리는 못 본다.
 *     2. **없을 때 할 수 있는 일이 있다.** div 하나 만들어 붙이는 것은 공짜이고
 *        되돌릴 필요도 없다. 없는 채로 부르면 예외로 죽고 대기화면이 사라진다.
 *
 *   즉 이 함수는 추측으로 덧붙인 fallback 이 아니라, **실패가 확정된 호출을 하지
 *   않기 위한 관문**이다. 취소 쪽에서 "해석 못 하면 부르지 않는다" 와 같은 결이다.
 *
 * 만들어 넣기만 하고 지우지 않는다. 내용도 건드리지 않는다 — 그 안은 SDK 것이다.
 *
 * @returns 컨테이너를 확보했으면 true.
 */
function ensureTemplateContainer(): boolean {
  if (typeof document === "undefined") return false;
  const existing = document.getElementById(TEMPLATE_CONTAINER_ID);
  // isConnected: 노드가 만들어져 있어도 문서에서 떨어져 있으면 createRoot 는 같은
  // 이유로 실패한다. "있다" 와 "붙어 있다" 는 다른 사실이다.
  if (existing && existing.isConnected) return true;

  if (!document.body) {
    log.warn(
      "템플릿 컨테이너 없음",
      `#${TEMPLATE_CONTAINER_ID} 를 만들 body 가 아직 없습니다. 자체 대기화면으로 갑니다.`,
    );
    return false;
  }

  // 떨어져 있는 헌 노드가 있으면 치우고 새로 붙인다. 둘이 공존하면
  // getElementById 가 어느 쪽을 주는지에 따라 증상이 오락가락한다.
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.id = TEMPLATE_CONTAINER_ID;
  // 부팅 문구(#boot, position:fixed)보다 뒤에 붙는다. 덮개는 렌더 성공이
  // 확인된 뒤에 confirmTemplateRendered 가 걷는다 — 순서는 0.3.9 그대로다.
  document.body.appendChild(el);
  log.warn(
    "템플릿 컨테이너 재생성",
    `#${TEMPLATE_CONTAINER_ID} 가 문서에 없어 다시 만들었습니다. ` +
      `이 줄이 보이면 index.html 의 노드가 어딘가에서 사라진 것입니다 — ` +
      `React #299(Target container is not a DOM element) 로 죽기 전에 막았습니다.`,
  );
  return true;
}

/**
 * 유휴 화면을 그린다.
 *
 * 공식 SDK 의 renderIdlePage 를 쓴다 (Toss 표준 컴포넌트 = 심사 정책 준수).
 * 없으면 자체 대기화면으로 대체한다. 여기서 아무것도 안 하면 다시 검은 화면이 된다.
 *
 * 왜 params 를 받게 바꿨나:
 *   원장이 본 "빨간 IP 주소만 있는 화면" 은 type:"default" 대기화면이다. 우리가
 *   renderIdlePage 를 인자 없이 불렀기 때문에 Toss 기본 화면이 그대로 나온 것이다.
 *   (빨간 IP 줄 자체는 디버그 빌드에서만 붙는 것이라 운영 빌드에는 나오지 않는다.)
 *   이제 문구와 버튼을 넘겨서 학원 이름이 뜨는 대기화면을 그린다.
 *
 * params 를 넣은 호출이 실패하면 인자 없는 호출로 한 번 더 시도한다. 펌웨어가 구형이라
 * 인자를 모르더라도 최소한 Toss 기본 대기화면은 나와야 하기 때문이다. 그것마저
 * 실패할 때만 자체 화면으로 내려간다.
 *
 * @returns 공식 Template API 로 실제 렌더가 성공했으면 true, 자체 화면으로
 *   대체했으면 false.
 *
 *   호출부는 이 값으로만 부팅 문구를 지워야 한다. "renderIdlePage 라는 함수가
 *   존재한다"와 "그것이 그려졌다"는 서로 다른 사실인데, 0.3.8 까지 그 둘을 같은
 *   것으로 취급했다 (`if (sdk?.template?.renderIdlePage) clearOwnScreen()`).
 *   그래서 함수만 있고 렌더가 안 되면 화면에서 모든 것이 사라졌다.
 */
export function renderIdle(
  sdk: TossFrontSdk | null,
  fallback: () => void,
  params?: IdlePageParams
): boolean {
  if (sdk?.template && typeof sdk.template.renderIdlePage === "function") {
    if (!templateApiLogged) {
      templateApiLogged = true;
      log.info(
        "template API 확인",
        `renderIdlePage 선언 인자수=${sdk.template.renderIdlePage.length} · template=${describeTemplateApi(sdk.template)}`
      );
    }
    // 마운트 지점이 없으면 부르지 않는다. 부르면 React #299 로 죽고, 죽으면
    // 대기화면이 통째로 사라진다. 확보에 실패했을 때만 자체 화면으로 내려간다.
    if (!ensureTemplateContainer()) {
      fallback();
      return false;
    }
    try {
      sdk.template.renderIdlePage(params);
      log.info("renderIdlePage 호출 성공", `type=${params?.type ?? "(인자 없음)"}`);
      return true;
    } catch (err) {
      // warn 이다. 여기서 끝난 것이 아니라 바로 아래에서 한 번 더 시도한다.
      // error 로 찍으면 원장 화면 진단 줄이 빨갛게 차서, 정작 봐야 할 줄을 덮는다.
      log.warn(
        "renderIdlePage 실패 — 기본 화면으로 재시도",
        `${describeError(err)} · 이 펌웨어가 params 를 모를 수 있습니다.`,
      );
      try {
        sdk.template.renderIdlePage();
        log.info("renderIdlePage 기본 호출 성공", "인자 없는 기본 대기화면으로 그렸습니다.");
        return true;
      } catch (err2) {
        log.error("renderIdlePage 기본 호출도 실패", err2, "자체 대기화면으로 대체합니다.");
      }
    }
  } else {
    log.warn("renderIdlePage 없음", "SDK 유휴화면을 쓸 수 없어 자체 대기화면을 표시합니다.");
  }
  fallback();
  return false;
}

/**
 * SDK storage 가 없는 단말기를 위한 대체 저장소.
 * deviceKey 는 단말기에 남아야 재부팅 후에도 페어링이 유지된다.
 *
 * 우선순위:
 *   1) sdk.storage.get / set  (공식 객체 인자 형태, Toss 템플릿과 동일)
 *   2) sdk.storage.getItem / setItem  (legacy 스타일이 남아 있을 수 있어 지원)
 *   3) localStorage  (개발용 브라우저 fallback)
 */
export const storage = {
  async getItem(sdk: TossFrontSdk | null, key: string): Promise<string | null> {
    if (sdk?.storage?.get && typeof sdk.storage.get === "function") {
      try {
        const r = await sdk.storage.get({ key });
        return r?.value ?? null;
      } catch (err) {
        log.error("sdk.storage.get 실패", err, `key=${key} — 다음 경로로 대체합니다.`);
      }
    }
    if (sdk?.storage?.getItem && typeof sdk.storage.getItem === "function") {
      try {
        return await sdk.storage.getItem(key);
      } catch (err) {
        log.error("sdk.storage.getItem 실패", err, `key=${key} — localStorage 로 대체합니다.`);
      }
    }
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  async setItem(sdk: TossFrontSdk | null, key: string, value: string): Promise<void> {
    if (sdk?.storage?.set && typeof sdk.storage.set === "function") {
      try {
        await sdk.storage.set({ key, value });
        return;
      } catch (err) {
        log.error("sdk.storage.set 실패", err, `key=${key} — 다음 경로로 대체합니다.`);
      }
    }
    if (sdk?.storage?.setItem && typeof sdk.storage.setItem === "function") {
      try {
        await sdk.storage.setItem(key, value);
        return;
      } catch (err) {
        log.error("sdk.storage.setItem 실패", err, `key=${key} — localStorage 로 대체합니다.`);
      }
    }
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch {
      /* 저장 실패는 다음 부팅에서 관리자 재등록으로 복구 */
    }
  },
};
