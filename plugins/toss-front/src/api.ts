/**
 * Toss Front 2 플러그인 → EduSyncPro 서버 통신 얇은 래퍼 (결제 단말기 모드).
 *
 * 이 플러그인은 학생 조회·청구서 선택 UI를 갖지 않는다. 그런 흐름은 태블릿 웹
 * (/student-kiosk) 에서 이루어지고, 서버가 "지금 결제하라" 는 dispatch를 만들어
 * 이 단말기로 밀어 준다.
 *
 * 여기서 통신하는 엔드포인트는 전부 /api/toss-front/... 이고 deviceGuard 로 보호된다.
 * 태블릿 쪽 /api/toss-kiosk/... (kioskGuard) 와 인증 경로가 완전히 분리되어 있다.
 *
 * 인증 흐름:
 *   1. 부팅 시 저장된 deviceKey 로 /session 호출 → 15분 accessToken
 *   2. 이후 모든 요청 헤더에 Bearer accessToken
 *   3. 401 을 받으면 자동 재세션 후 1회 재시도
 */

export const SERVER_URL =
  (globalThis as any).TOSS_PLUGIN_SERVER_URL ||
  "https://edusyncpro-production-dcfe.up.railway.app";

export interface DeviceInfo {
  id: string;
  tenantId: string;
  displayName: string;
}

/** 사람이 읽고 바로 행동할 수 있는 실패. message 에 "무엇을 해야 하는가"까지 담는다. */
export class ApiError extends Error {
  constructor(
    message: string,
    /** "network" = 요청이 서버에 닿지도 못함. 그 외는 서버가 준 HTTP 상태. */
    readonly kind: "network" | "http",
    readonly status?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 로그·화면에 띄울 서버 호스트. 전체 URL 은 길어서 화면을 덮는다. */
function serverHost(): string {
  try {
    return new URL(SERVER_URL).host;
  } catch {
    return SERVER_URL;
  }
}

/**
 * fetch 자체가 거부된 경우를 "네트워크 실패"로 번역한다.
 *
 * 2026-08 단말기 등록 실패에서 배운 것:
 *   웹뷰가 요청을 막으면 fetch 는 그냥 TypeError("Failed to fetch") 를 던진다.
 *   원인(허용 도메인 미등록 / CORS / 인터넷 끊김)이 전혀 구분되지 않는다. 그래서
 *   화면에는 "서버에 연결하지 못했습니다" 라는 말만 남았고, 서버 로그에는 아무 흔적도
 *   없어서 어디를 봐야 할지조차 알 수 없었다. 최소한 "무엇을 확인하라"는 남겨야 한다.
 */
async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e: any) {
    throw new ApiError(
      `서버에 닿지 못했습니다 (${serverHost()}). ` +
        `단말기가 인터넷에 연결됐는지, 그리고 토스 개발자센터의 허용 도메인(ACL)에 ` +
        `${serverHost()} 가 등록됐는지 확인해 주세요. ` +
        `ACL 을 바꾼 뒤에는 단말기를 로그아웃하고 다시 온보딩해야 반영됩니다. ` +
        `[원문: ${e?.message ?? e}]`,
      "network"
    );
  }
}

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let deviceKey: string | null = null;
let lastDevice: DeviceInfo | null = null;

export function setDeviceKey(key: string) {
  deviceKey = key;
}

async function refreshSession(): Promise<DeviceInfo> {
  if (!deviceKey) {
    throw new Error("deviceKey가 없습니다. 관리자 화면에서 등록 코드를 받으세요.");
  }
  const res = await safeFetch(`${SERVER_URL}/api/toss-front/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceKey }),
  });
  if (!res.ok) {
    // 본문에 원인이 담겨 있다 (비활성 단말기 / 키 불일치). 로그에 그대로 남기면
    // 현장에서 "등록을 다시 해야 하는지"를 바로 판단할 수 있다.
    const detail = await res.text().catch(() => "");
    const advice =
      res.status === 401
        ? "이 단말기의 등록이 해지됐거나 키가 바뀌었습니다. 원장 화면에서 재발급 후 다시 등록해 주세요."
        : res.status >= 500
          ? "서버에 일시적인 오류가 있습니다. 잠시 후 다시 시도해 주세요."
          : "단말기 등록 상태를 원장 화면에서 확인해 주세요.";
    throw new ApiError(
      `${advice} (세션 발급 HTTP ${res.status}${detail ? ` · ${detail.slice(0, 120)}` : ""})`,
      "http",
      res.status
    );
  }
  const j: { accessToken: string; expiresInSeconds: number; device: DeviceInfo } = await res.json();
  accessToken = j.accessToken;
  accessTokenExpiresAt = Date.now() + (j.expiresInSeconds - 60) * 1000;
  lastDevice = j.device;
  return j.device;
}

/**
 * 부팅 시 서버 연결과 단말기 인증을 한 번에 확인한다.
 * 실패하면 던진다 — 호출부가 화면과 로그에 원인을 남긴다.
 */
export async function pingServer(): Promise<DeviceInfo> {
  const device = await refreshSession();
  // 세션만으로는 라우팅까지 정상인지 알 수 없으니 실제 폴링 경로를 한 번 두드린다.
  await fetchPendingDispatch();
  return device;
}

/** 마지막으로 인증된 단말기 정보. 로그 태깅용. */
export function getDeviceInfo(): DeviceInfo | null {
  return lastDevice;
}

async function ensureAccessToken(): Promise<string> {
  if (!accessToken || Date.now() > accessTokenExpiresAt) {
    await refreshSession();
  }
  return accessToken!;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await ensureAccessToken();
  const doFetch = async (t: string) =>
    safeFetch(`${SERVER_URL}${path}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        "content-type": "application/json",
        authorization: `Bearer ${t}`,
      },
    });
  let res = await doFetch(token);
  if (res.status === 401) {
    await refreshSession();
    res = await doFetch(accessToken!);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new ApiError(`API ${path} ${res.status}: ${errBody.slice(0, 200)}`, "http", res.status);
  }
  return res.json();
}

// ─── Dispatch (결제 명령) ─────────────────────────────────────────────

/**
 * 서버가 이 단말기에 대기시켜 놓은 결제 명령이 있으면 반환한다.
 * 없으면 { pending: null }. 1초마다 폴링한다.
 */
export interface PendingDispatch {
  // 상관관계 ID. dispatch 결과 통지 시 서버에 그대로 되돌려 준다.
  requestId: string;
  // 서버 내부 라우팅 키. 현 스키마에선 requestId 와 동일한 값이지만 API 이름은 분리.
  dispatchId: string;
  paymentKey: string;
  orderId: string;
  orderName: string;
  // sdk.payment.requestPayment 는 아래 4개 값을 서버가 확정한 값으로만 넘겨야 한다.
  amount: number;
  tax: number;
  supplyValue: number;
  taxExemptValue: number;
  tip: number;
  status: "PENDING";
  deviceId: string;
  createdAt: string;
  expiresAt: string;
}

export function fetchPendingDispatch(): Promise<{ pending: PendingDispatch | null }> {
  return apiFetch("/api/toss-front/dispatch/pending");
}

/** 단말기가 dispatch 를 받아 결제창을 띄우기 직전에 호출 (DELIVERED 로 표시). */
export function ackDispatch(dispatchId: string) {
  return apiFetch<{ ok: true }>(`/api/toss-front/dispatch/${dispatchId}/ack`, {
    method: "POST",
  });
}

/** 결제창이 끝난 뒤 결과를 서버에 전달 (APPROVED / CANCELED / TIMEOUT / FAILED). */
export interface DispatchResult {
  status: "APPROVED" | "CANCELED" | "TIMEOUT" | "FAILED";
  reason?: string;
}
export function reportDispatchResult(dispatchId: string, body: DispatchResult) {
  return apiFetch<{ ok: true }>(`/api/toss-front/dispatch/${dispatchId}/result`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ─── Payment confirm (승인 성공 시 서버 원장 반영) ────────────────────

export function confirmPayment(body: {
  paymentKey: string;
  orderId: string;
  amount: number;
  paymentMethod: "CARD" | "CASH" | "BARCODE";
  approvalNumber: string;
  approvedTimestamp: string;
  van?: string | null;
  tid?: string | null;
  vanTransactionKey?: string | null;
  maskedCardNumber?: string | null;
  issuerName?: string | null;
  acquirerName?: string | null;
  cardType?: string | null;
  installment?: number;
  rawResponse?: any;
}) {
  return apiFetch<{
    idempotent: boolean;
    intentId: string;
    paymentKey: string;
    amount: number;
    approvalNumber: string;
  }>("/api/toss-front/payments/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function cancelPayment(paymentKey: string, reason?: string) {
  return apiFetch<{ ok: true }>("/api/toss-front/payments/cancel", {
    method: "POST",
    body: JSON.stringify({ paymentKey, reason }),
  });
}

// ─── 페어링 교환 (0.3.2~) ─────────────────────────────────────────────
/**
 * 온보딩에서 사람이 입력한 [매장코드 + PIN] + SDK 가 준 serialNumber 를
 * 서버로 보내 raw deviceKey 를 받아온다. 이 요청은 인증 헤더 없이 나간다 —
 * 지금 인증 자격 자체를 발급받는 중이라 accessToken 이 없다.
 * 응답의 deviceKey 는 이후 setDeviceKey() 로 심고 /session 을 정상 흐름으로 밟는다.
 */
export interface PairingExchangeResult {
  deviceKey: string;
  device: { id: string; displayName: string };
}

export async function exchangePairing(input: {
  pairingCode: string;
  pin: string;
  serialNumber: string;
}): Promise<PairingExchangeResult> {
  const res = await safeFetch(`${SERVER_URL}/api/toss-front/devices/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    // 서버가 준 상태코드를 "원장이 지금 할 일"로 번역한다. 숫자만 보여 주면
    // 현장에서는 재발급을 해야 하는지 다시 입력해야 하는지 판단할 수 없다.
    // (상태코드의 의미는 server/toss-front/routes.ts 의 /devices/exchange 참고)
    const body = await res.text().catch(() => "");
    const serverMsg = (() => {
      try {
        return String(JSON.parse(body)?.error ?? "").trim();
      } catch {
        return body.slice(0, 120).trim();
      }
    })();

    const guide: Record<number, string> = {
      400: "입력 형식이 올바르지 않습니다. 매장 코드 6자와 PIN 4자리를 확인해 주세요.",
      401: "매장 코드 또는 PIN이 맞지 않습니다. 코드는 발급 후 시간이 지나면 만료되니, 원장 화면에서 새로 발급받아 주세요.",
      409: "이 매장 코드는 이미 다른 단말기에 등록되어 있습니다. 원장 화면에서 재발급해 주세요.",
      410: "이 페어링은 더 이상 사용할 수 없습니다. 원장 화면에서 재발급해 주세요.",
    };
    const advice =
      guide[res.status] ??
      (res.status >= 500
        ? "서버에 일시적인 오류가 있습니다. 잠시 후 다시 시도해 주세요."
        : "원장 화면에서 코드를 다시 확인해 주세요.");

    throw new ApiError(
      `${advice} (HTTP ${res.status}${serverMsg ? ` · ${serverMsg}` : ""})`,
      "http",
      res.status
    );
  }

  return (await res.json()) as PairingExchangeResult;
}
