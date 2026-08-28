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

export interface TossFrontSdk {
  template?: {
    renderIdlePage?(): void;
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
 * 유휴 화면을 그린다.
 *
 * 공식 SDK 의 renderIdlePage 가 있으면 그것을 쓴다 (Toss 표준 대기화면·심사 정책 준수).
 * 없으면 자체 대기화면으로 대체한다. 여기서 아무것도 안 하면 다시 검은 화면이 된다.
 */
export function renderIdle(sdk: TossFrontSdk | null, fallback: () => void) {
  if (sdk?.template && typeof sdk.template.renderIdlePage === "function") {
    try {
      sdk.template.renderIdlePage();
      return;
    } catch (err) {
      log.error("renderIdlePage 실패", err, "자체 대기화면으로 대체합니다.");
    }
  } else {
    log.warn("renderIdlePage 없음", "SDK 유휴화면을 쓸 수 없어 자체 대기화면을 표시합니다.");
  }
  fallback();
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
