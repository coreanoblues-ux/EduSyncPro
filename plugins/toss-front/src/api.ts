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

const SERVER_URL =
  (globalThis as any).TOSS_PLUGIN_SERVER_URL ||
  "https://edusyncpro-production-dcfe.up.railway.app";

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let deviceKey: string | null = null;

export function setDeviceKey(key: string) {
  deviceKey = key;
}

async function refreshSession(): Promise<void> {
  if (!deviceKey) {
    throw new Error("deviceKey가 없습니다. 관리자 화면에서 등록 코드를 받으세요.");
  }
  const res = await fetch(`${SERVER_URL}/api/toss-front/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceKey }),
  });
  if (!res.ok) throw new Error(`세션 발급 실패: ${res.status}`);
  const j: { accessToken: string; expiresInSeconds: number } = await res.json();
  accessToken = j.accessToken;
  accessTokenExpiresAt = Date.now() + (j.expiresInSeconds - 60) * 1000;
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
    fetch(`${SERVER_URL}${path}`, {
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
    const errBody = await res.text();
    throw new Error(`API ${path} ${res.status}: ${errBody}`);
  }
  return res.json();
}

// ─── Dispatch (결제 명령) ─────────────────────────────────────────────

/**
 * 서버가 이 단말기에 대기시켜 놓은 결제 명령이 있으면 반환한다.
 * 없으면 { pending: null }. 1초마다 폴링한다.
 */
export interface PendingDispatch {
  dispatchId: string;
  paymentKey: string;
  orderId: string;
  orderName: string;
  amount: number;
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
