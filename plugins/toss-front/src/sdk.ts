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

import { log } from "./logger";

// SDK 공식 응답 형태 (Toss Front 2 Plugin SDK 문서 기준).
export type PaymentResponseSuccess = {
  paymentKey: string;
  orderId?: string;
  amount: number;
  paymentMethod: "CARD" | "CASH" | "BARCODE";
  approvalNumber?: string;
  approvedAt: string; // ISO
  card?: {
    number?: string; // masked
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
      /** 원승인 시각 (밀리초). 원거래 조회 키다. */
      timestamp: string;
      /** 원승인번호. */
      approvalNumber: string;
      installment: number;
      tid: string;
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
    try {
      sdk.template.renderIdlePage(params);
      log.info("renderIdlePage 호출 성공", `type=${params?.type ?? "(인자 없음)"}`);
      return true;
    } catch (err) {
      log.error("renderIdlePage 실패", err, "인자 없이 기본 대기화면으로 다시 시도합니다.");
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
