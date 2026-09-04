/**
 * 통신 안전장치 — "응답이 영영 안 오는 경우" 를 없애기 위한 최소 도구.
 *
 * ══ 왜 이 파일이 생겼나 (2026-09-03, 원장 신고) ══
 *
 *   "단말기를 안 끄고 퇴근했다가 다음 날 출근해서 첫 결제를 하면 안 된다.
 *    결제 화면까지는 넘어가는데 카드 넣으라는 화면이 안 뜨거나 통신중만 뜬다.
 *    껐다 켜면 하루 종일 잘 된다."
 *
 *   같은 신고가 두 번째다. 첫 번째 때는 원인을 못 찾고 넘어갔다.
 *
 * ── 코드에서 확인한 사실 ──
 *
 *   1) 이 플러그인의 모든 fetch 에 **시간 제한이 없었다.** (api.ts safeFetch)
 *      fetch 는 스스로 포기하지 않는다. 응답이 안 오면 그냥 계속 기다린다.
 *
 *   2) 폴링 루프는 `try/finally` 안에서만 다음 폴링을 예약한다.
 *      즉 fetch 가 영원히 안 끝나면 finally 도 영원히 안 온다 →
 *      **1초 폴링이 통째로, 영구히 멈춘다.** 되살아나는 길이 하나도 없다.
 *
 *   3) 폴링이 멈추면 서버가 만든 결제요청을 단말기가 영영 집어가지 않는다.
 *      태블릿에는 "결제 단말기와 통신하고 있습니다..." 만 계속 뜬다.
 *      원장이 본 그 화면이다. 재부팅하면 루프가 새로 시작되니 하루 종일 잘 된다.
 *
 * ── 왜 하필 밤을 새운 다음 날 아침인가 ──
 *
 *   밤새 단말기가 유휴 상태로 있으면 공유기·통신사 NAT 가 조용히 연결을 버린다.
 *   단말기 쪽 소켓은 살아 있다고 착각한 채 남는다. 아침에 그 죽은 소켓으로
 *   요청을 보내면 답이 오지 않고, TCP 재전송이 끝날 때까지(안드로이드에서
 *   수 분) 매달린다. 시간 제한이 없으면 그 사이 폴링은 죽어 있다.
 *
 *   이건 "가끔 불안정한" 게 아니라 **하룻밤 유휴 뒤에 재현되는 구조적 결함**이다.
 *
 * ── 그래서 여기 있는 것 ──
 *   · fetchWithTimeout : 정해진 시간이 지나면 요청을 끊는다.
 *   · isLongIdleGap    : 폴링이 오래 끊겼다 돌아온 것을 알아본다 (세션 새로 맺기용).
 *   · isPollStuck      : 그럼에도 루프가 멈춰 있으면 알아본다 (마지막 방어선).
 *
 * 판단 함수를 여기 따로 둔 이유는 시험할 수 있게 하기 위해서다. 단말기에서만
 * 재현되는 버그를 단말기에서만 확인할 수 있으면, 고쳤는지 아닌지도 다음 날
 * 아침까지 모른다.
 */

/** 일반 요청 상한. 우리 요청은 전부 작은 JSON 이라 이보다 오래 걸릴 이유가 없다. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * 폴링 요청 상한. 1초마다 도는 길이라 더 짧게 잡는다.
 *
 * 짧게 끊어도 손해가 없다: 실패하면 1초 뒤 그냥 다시 두드린다. 반면 길게 잡으면
 * 아침 첫 요청이 죽은 소켓에 매달려 있는 동안 결제요청을 못 집는다.
 */
export const POLL_REQUEST_TIMEOUT_MS = 12_000;

/** 로그 전송 상한. 로그 때문에 소켓을 오래 붙들고 있을 이유는 없다. */
export const LOG_REQUEST_TIMEOUT_MS = 8_000;

/**
 * 이만큼 폴링이 끊겼다 돌아오면 "오래 쉬었다" 로 본다.
 *
 * 정상 폴링 간격은 1초다. 90초는 그 90배 — 화면이 꺼져 웹뷰가 멈췄거나,
 * 네트워크가 끊겼거나, 결제창이 오래 떠 있었거나 셋 중 하나다. 어느 쪽이든
 * 그 다음 요청은 오래 방치된 연결 위에서 나가므로, 세션을 새로 맺는 편이 안전하다.
 */
export const IDLE_GAP_MS = 90_000;

/**
 * 폴링 한 바퀴가 이보다 오래 걸리면 "멈췄다" 로 본다.
 *
 * 최악의 정상 경로를 넉넉히 넘겨 잡았다: 세션 재발급(15초) + 폴링 요청(12초)
 * = 27초. 45초를 넘겼다면 시간 제한이 걸리지 않는 무언가에 매달려 있는 것이다
 * (예: 응답 없는 SDK 호출). 그 경우에도 루프는 되살아나야 한다.
 */
export const POLL_STUCK_MS = 45_000;

/** 시간 초과로 우리가 직접 끊은 요청. 서버가 준 응답이 아님을 이름으로 구분한다. */
export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`요청이 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않아 끊었습니다.`);
    this.name = "RequestTimeoutError";
  }
}

/**
 * 시간 제한이 붙은 fetch.
 *
 * AbortController 가 없는 웹뷰(아주 오래된 크로미움)에서는 시간 제한 없이
 * 그냥 fetch 한다 — 지금까지와 똑같이 동작한다는 뜻이다. 새 안전장치가
 * 구형 단말기에서 결제를 막는 일은 없어야 한다.
 *
 * ⚠️ init.signal 은 덮어쓴다. 이 플러그인에는 signal 을 넘기는 호출부가 없다.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<Response> {
  if (typeof AbortController === "undefined" || !(timeoutMs > 0)) {
    return fetch(url, init);
  }

  const controller = new AbortController();
  // abort() 는 fetch 를 AbortError 로 거부시키는데, 그 오류만 봐서는
  // "우리가 끊었다" 와 "웹뷰가 막았다" 가 구분되지 않는다. 깃발로 구분한다.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort();
    } catch {
      /* 일부 웹뷰는 이미 끝난 요청에 abort 하면 던진다. 무시해도 안전하다. */
    }
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new RequestTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 폴링이 오래 끊겼다 돌아왔는가.
 *
 * prev 가 없으면(첫 폴링) false — 부팅 직후는 이미 세션을 새로 맺은 참이다.
 * 미래 시각이 들어오면(단말기 시계 보정) false. 시계가 뒤로 간 것을 "오래
 * 쉬었다" 로 오해해서 매번 세션을 새로 맺으면 그게 더 해롭다.
 */
export function isLongIdleGap(
  prevPollAt: number | null,
  now: number,
  gapMs: number = IDLE_GAP_MS
): boolean {
  if (prevPollAt == null) return false;
  const elapsed = now - prevPollAt;
  return elapsed > gapMs;
}

/**
 * 폴링 한 바퀴가 끝나지 않고 멈춰 있는가.
 *
 * busy(결제창이 떠 있음) 일 때는 절대 참이 되면 안 된다. 학생이 카드를 들고
 * 서 있는 60초짜리 결제 중에 루프를 되살리면, 되살아난 루프가 다음 결제요청을
 * 집어 같은 단말기에서 두 건이 겹친다. 멈춘 루프보다 그게 훨씬 나쁘다.
 */
export function isPollStuck(
  inFlightSince: number | null,
  now: number,
  busy: boolean,
  stuckMs: number = POLL_STUCK_MS
): boolean {
  if (busy) return false;
  if (inFlightSince == null) return false;
  return now - inFlightSince > stuckMs;
}
