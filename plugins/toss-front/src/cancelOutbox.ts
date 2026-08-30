/**
 * 카드 취소 **결과 보고** 아웃박스 + 진행중 표식.
 *
 * ══ 결제 아웃박스와 무엇이 다른가 ══
 *
 *   outbox.ts 는 "승인 요청을 성공할 때까지 다시 보낸다" 이다. 결제는 그래도 된다.
 *   중복 승인이 나면 우리가 환불하면 되기 때문이다.
 *
 *   취소는 정반대다. 중복 취소가 나면 학부모 카드로 돈이 두 번 들어가고,
 *   우리에게는 그걸 되돌릴 API 가 없다 (Open API 시크릿 키가 없다).
 *   그래서 이 파일은 **취소 요청을 절대 다시 보내지 않는다.**
 *
 *   다시 보내는 것은 오직 "결과 보고" 다. 둘을 구분하는 것이 이 파일의 전부다:
 *
 *     sdk.requestPaymentCancel(...)      ← 딱 한 번. 재시도 없음. 위험.
 *     POST /dispatch/cancel/:id/result   ← 성공할 때까지. 멱등. 안전.
 *
 *   결과 보고를 재시도하는 것은 안전할 뿐 아니라 **필수**다. 원장 요구사항이
 *   "장부에도 환불이 반영이 되어야해 꼭" 인데, 장부 음수 행은 서버가 이 보고를
 *   받았을 때만 쓰이기 때문이다. 카드에서는 돈이 돌아갔는데 보고가 유실되면
 *   장부는 그 사실을 영영 모른다 — 1,000원 결제가 장부에 안 들어갔던
 *   그 사고(outbox.ts 헤더 참고)와 정확히 같은 구조다.
 *
 * ══ 진행중 표식(in-flight marker) 이 필요한 이유 ══
 *
 *   requestPaymentCancel 을 부른 직후 앱이 죽거나 단말기가 꺼지면, 카드가
 *   취소됐는지 아닌지를 아무도 모른다. 표식이 없으면 다음 부팅에서 이 건은
 *   그냥 사라지고, 서버 쪽 dispatch 는 5분 뒤 TIMEOUT 으로 넘어간다. 결과는
 *   같아 보이지만 **아무도 그 일이 있었다는 걸 모른다는 점**이 다르다.
 *
 *   그래서 SDK 를 부르기 **전에** 저장소에 표식을 남긴다. 부팅할 때 표식이
 *   남아 있으면 "취소를 걸다가 끊겼다" 는 뜻이므로 TIMEOUT 으로 보고한다.
 *   서버는 TIMEOUT 을 받으면 자동 재시도를 막고 사람에게 넘긴다.
 *
 *   TIMEOUT 으로 보고하는 쪽이 왜 맞나: 카드가 취소됐을 수도, 아닐 수도 있다.
 *   SUCCESS 로 보고하면 안 된 취소를 장부에 적고, FAILED 로 보고하면 된 취소를
 *   다시 걸 수 있게 열어 준다. 둘 다 사고다. "모른다" 가 사실이고, TIMEOUT 이
 *   우리 시스템에서 "모른다" 를 뜻한다.
 *
 * ⚠️ 이 파일은 다른 플러그인 모듈을 import 하지 않는다 (nextDelayMs 만 예외).
 *    순수 로직이라 루트 테스트가 그대로 불러 쓸 수 있어야 한다.
 */

import { nextDelayMs, type OutboxStorage } from "./outbox";

/** SDK PaymentResult.type 그대로. 서버 cancelResultSchema 와 같은 집합이어야 한다. */
export type CancelReportResult = "SUCCESS" | "FAILED" | "CANCELED" | "TIMEOUT";

/** 서버 /dispatch/cancel/:id/result 에 보낼 본문. */
export interface CancelReportPayload {
  cancelId: string;
  /** 로그·중복 판정용. 서버는 :id 로 찾으므로 본문에는 쓰지 않는다. */
  paymentKey: string;
  result: CancelReportResult;
  cancelApprovalNumber?: string;
  cancelTid?: string;
  reason?: string;
  /**
   * 감사용 응답 요약. 허용목록을 통과한 필드만 들어온다 (sdkError.safeRawSummary).
   * 실패 한 건에서 최대한 건지기 위한 것이다 — reason 한 줄로는 부족했다.
   * optional 인 이유: 이 필드가 없던 시절 단말기에 저장된 아웃박스 항목이
   * 그대로 남아 있을 수 있다.
   */
  raw?: unknown;
}

export interface CancelOutboxEntry {
  payload: CancelReportPayload;
  firstSeenAt: number;
  attempts: number;
  lastAttemptAt: number;
  lastError?: string;
}

export const CANCEL_OUTBOX_KEY = "edusyncpro.tossfront.cancelOutbox.v1";
export const CANCEL_INFLIGHT_KEY = "edusyncpro.tossfront.cancelInflight.v1";

/** SDK 를 부르기 직전에 남기는 표식. */
export interface CancelInflight {
  cancelId: string;
  paymentKey: string;
  startedAt: number;
}

/**
 * 서버 응답을 보고 "이 보고는 끝났는가" 를 판정한다.
 *
 * ⚠️ 결제 아웃박스의 isSettled 와 의도적으로 다르다. 여기서 true 는 "장부에
 *    들어갔다" 가 아니라 "서버가 이 결과를 확실히 알았다" 는 뜻이다. 장부에
 *    실제로 얼마가 적히는지는 서버가 정한다 (이미 취소 웹훅이 적어 뒀으면 0원).
 *
 *   - 2xx: 서버가 받아 처리했다 (idempotent:true 포함). 끝.
 *   - 409: 이미 확정된 dispatch 다. 서버가 아는 상태이므로 끝.
 *   - 그 외 4xx: 지우지 않는다. 카드는 건드려졌을 수 있는데 서버가 모르는
 *     상태라 사람이 봐야 한다. 남겨서 계속 시끄럽게 군다.
 *   - 5xx·네트워크: 일시 장애. 재시도.
 */
export function isCancelReportSettled(httpStatus: number | null): boolean {
  if (httpStatus === null) return false;
  if (httpStatus >= 200 && httpStatus < 300) return true;
  if (httpStatus === 409) return true;
  return false;
}

/**
 * 이 결과를 받았을 때 카드가 실제로 취소됐다고 볼 수 있는가.
 *
 * 서버 cardCancel.ts 의 classifyCancelResult 와 같은 판단을 단말기 쪽에서도
 * 한다 — 화면에 무엇을 띄울지 정해야 하기 때문이다. 판정의 주인은 서버지만,
 * 두 곳이 갈라지면 원장이 화면에서 본 것과 장부가 달라진다.
 */
export function cardWasCancelled(result: CancelReportResult): boolean {
  return result === "SUCCESS";
}

// ─── 저장소 입출력 ────────────────────────────────────────────────────

export function loadCancelOutbox(
  storage: OutboxStorage | null,
  onError?: (msg: string) => void,
): CancelOutboxEntry[] {
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(CANCEL_OUTBOX_KEY);
  } catch (err) {
    onError?.(`취소 아웃박스를 읽지 못했습니다: ${String(err)}`);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: any) =>
        e &&
        e.payload &&
        typeof e.payload.cancelId === "string" &&
        e.payload.cancelId.length > 0 &&
        typeof e.payload.result === "string",
    ) as CancelOutboxEntry[];
  } catch (err) {
    onError?.(`취소 아웃박스 JSON 이 깨져 있습니다: ${String(err)}`);
    return [];
  }
}

export function saveCancelOutbox(
  storage: OutboxStorage | null,
  entries: CancelOutboxEntry[],
  onError?: (msg: string) => void,
): void {
  if (!storage) return;
  try {
    if (entries.length === 0) storage.removeItem(CANCEL_OUTBOX_KEY);
    else storage.setItem(CANCEL_OUTBOX_KEY, JSON.stringify(entries));
  } catch (err) {
    onError?.(`취소 아웃박스를 저장하지 못했습니다: ${String(err)}`);
  }
}

/** SDK 호출 직전. 실패해도 던지지 않지만, 실패 사실은 호출부가 알아야 한다. */
export function markInflight(
  storage: OutboxStorage | null,
  inflight: CancelInflight,
  onError?: (msg: string) => void,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CANCEL_INFLIGHT_KEY, JSON.stringify(inflight));
    return true;
  } catch (err) {
    onError?.(`취소 진행중 표식을 남기지 못했습니다: ${String(err)}`);
    return false;
  }
}

export function readInflight(storage: OutboxStorage | null): CancelInflight | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CANCEL_INFLIGHT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.cancelId === "string" && parsed.cancelId.length > 0) {
      return parsed as CancelInflight;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearInflight(storage: OutboxStorage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(CANCEL_INFLIGHT_KEY);
  } catch {
    /* 표식이 남으면 다음 부팅에서 TIMEOUT 보고가 한 번 더 나갈 뿐, 서버가 멱등하다 */
  }
}

// ─── 목록 조작 (전부 순수 함수) ───────────────────────────────────────

/**
 * 결과 보고를 큐에 넣는다. 같은 cancelId 가 이미 있으면 **덮지 않는다.**
 *
 * 결제 아웃박스와 같은 이유(백오프 초기화 방지)이기도 하지만, 여기서는 더
 * 중요한 이유가 있다. 먼저 들어간 것이 진짜 SDK 응답이고 나중에 들어오는 것은
 * 부팅 시 표식으로 만든 TIMEOUT 추정치일 수 있다. 추정치가 사실을 덮으면 안 된다.
 */
export function addCancelReport(
  entries: CancelOutboxEntry[],
  payload: CancelReportPayload,
  now: number,
): CancelOutboxEntry[] {
  if (entries.some((e) => e.payload.cancelId === payload.cancelId)) return entries;
  return [...entries, { payload, firstSeenAt: now, attempts: 0, lastAttemptAt: 0 }];
}

export function removeCancelReport(
  entries: CancelOutboxEntry[],
  cancelId: string,
): CancelOutboxEntry[] {
  return entries.filter((e) => e.payload.cancelId !== cancelId);
}

export function markCancelAttempt(
  entries: CancelOutboxEntry[],
  cancelId: string,
  now: number,
  error: string,
): CancelOutboxEntry[] {
  return entries.map((e) =>
    e.payload.cancelId === cancelId
      ? { ...e, attempts: e.attempts + 1, lastAttemptAt: now, lastError: error }
      : e,
  );
}

/** 지금 다시 보내 볼 때가 된 건들. 백오프는 결제 아웃박스와 같은 곡선을 쓴다. */
export function dueCancelReports(
  entries: CancelOutboxEntry[],
  now: number,
): CancelOutboxEntry[] {
  return entries.filter((e) => now - e.lastAttemptAt >= nextDelayMs(e.attempts));
}
