/**
 * 서버 통신 얇은 래퍼.
 *
 * 왜 fetch를 직접 여기 담나:
 *   플러그인 SDK는 어차피 브라우저 유사 환경(fetch·localStorage)을 제공하므로
 *   별도 HTTP 라이브러리를 두지 않는다. 크기·의존성·업데이트 비용이 낮아진다.
 *
 * 인증 흐름:
 *   1. 부팅 시 저장된 deviceKey로 /session 호출 → 15분짜리 accessToken 획득
 *   2. 이후 모든 요청 헤더에 Bearer accessToken
 *   3. 401을 받으면 자동으로 세션을 다시 튼 뒤 원 요청을 한 번 더 시도
 */

const SERVER_URL =
  (globalThis as any).TOSS_PLUGIN_SERVER_URL ||
  "https://edusyncpro-production-dcfe.up.railway.app";

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;
let deviceKey: string | null = null;

/**
 * 플러그인 부팅 시 SDK 저장소에서 deviceKey를 읽어 이 함수로 넘긴다.
 * 저장소가 클리어된 첫 부팅에는 원장에게 등록 코드를 받아야 한다.
 */
export function setDeviceKey(key: string) {
  deviceKey = key;
}

async function refreshSession(): Promise<void> {
  if (!deviceKey) {
    throw new Error("deviceKey가 없습니다. 원장에게 등록 코드를 받으세요.");
  }
  const res = await fetch(`${SERVER_URL}/api/toss-front/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceKey }),
  });
  if (!res.ok) throw new Error(`세션 발급 실패: ${res.status}`);
  const j: { accessToken: string; expiresInSeconds: number } = await res.json();
  accessToken = j.accessToken;
  // 만료 1분 전에 미리 갱신하도록 여유를 두고 저장.
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
    // 만료된 토큰. 한 번만 재발급 시도.
    await refreshSession();
    res = await doFetch(accessToken!);
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`API ${path} ${res.status}: ${errBody}`);
  }
  return res.json();
}

// ─── 도메인 API ───────────────────────────────────────────────────────

export interface StudentSummary {
  id: string;
  name: string;
  school: string | null;
  grade: string | null;
  parentPhone: string | null;
}

export function searchStudentsByPhoneSuffix(phoneSuffix: string): Promise<StudentSummary[]> {
  return apiFetch<StudentSummary[]>("/api/toss-front/students/search", {
    method: "POST",
    body: JSON.stringify({ phoneSuffix }),
  });
}

export interface TodayClass {
  enrollmentId: string;
  classId: string;
  className: string;
  subject: string;
  schedule: string;
  alreadyCheckedIn: boolean;
}

export function fetchTodayClasses(studentId: string): Promise<{
  studentId: string;
  today: string;
  classes: TodayClass[];
}> {
  return apiFetch(`/api/toss-front/students/${studentId}/today-classes`);
}

export function checkInAttendance(input: { studentId: string; classId: string }) {
  return apiFetch<{ ok: true; alreadyCheckedIn: boolean }>(
    "/api/toss-front/attendance/check-in",
    { method: "POST", body: JSON.stringify(input) }
  );
}

export interface Invoice {
  token: string;
  paymentMonth: string;
  enrollmentId: string;
  className: string;
  subject: string;
  amountDue: number;
  amountPaid: number;
}

export function fetchInvoices(studentId: string): Promise<{
  studentId: string;
  studentName: string;
  invoices: Invoice[];
}> {
  return apiFetch(`/api/toss-front/students/${studentId}/invoices`);
}

export interface PaymentIntent {
  intentId: string;
  paymentKey: string;
  orderId: string;
  amount: number;
  orderName: string;
  expiresAt: string;
}

export function createPaymentIntent(invoiceToken: string): Promise<PaymentIntent> {
  return apiFetch<PaymentIntent>("/api/toss-front/payments/intents", {
    method: "POST",
    body: JSON.stringify({ invoiceToken }),
  });
}

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
