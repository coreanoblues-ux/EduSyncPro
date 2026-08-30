/**
 * 승인된 카드 결제를 서버 원장에 **반드시** 전달하기 위한 아웃박스.
 *
 * ══ 이게 왜 생겼나 (2026-08-30, 원장 신고) ══
 *
 *   원장이 정재현 학생의 2026-09 수강료로 1,000원을 카드 결제했다. 단말기에서
 *   카드는 승인됐는데 수납 장부에는 아무것도 안 들어왔다. 관리자 화면의 intent 는
 *   PROCESSING 에서 멈춰 있다가 TIMEOUT 으로 넘어갔다.
 *
 *   원인은 index.ts 의 이 다섯 줄이었다:
 *
 *       try {
 *         await confirmPaymentFromSdk(result.response);   // ← 딱 한 번
 *       } catch (err) {
 *         log.error("승인 후 원장 반영 실패", err, "…원장 확인이 필요합니다.");
 *       }
 *
 *   카드 승인 직후 confirm POST 를 **단 한 번** 쏘고, 실패하면 로그만 남기고
 *   끝냈다. 재시도도, 큐도, 저장도 없었다. 매장 와이파이가 순간 끊기거나
 *   Railway 가 콜드스타트로 몇 초 늦게 응답하면 그걸로 끝이다. 돈은 카드에서
 *   빠져나갔는데 장부는 그 사실을 영영 모른다.
 *
 *   그리고 그 실패는 **메모리에서도 사라진다.** 승인 응답을 담은 변수는 함수가
 *   끝나면 없어지므로, 다시 보내고 싶어도 보낼 내용이 남아 있지 않다.
 *
 * ══ 그래서 무엇을 하나 ══
 *
 *   승인이 나면 서버에 보내기 **전에** 먼저 단말기 저장소에 적는다. 그 다음
 *   보낸다. 서버가 확실히 받았다고 답할 때까지 지우지 않는다. 앱이 꺼졌다
 *   켜져도 저장소에 남아 있으므로 부팅하면서 다시 보낸다.
 *
 *   전형적인 outbox 패턴이다. 전달은 "적어도 한 번"이 되고, 서버의 멱등성이
 *   그것을 "정확히 한 번"의 결과로 만든다. 두 성질이 짝이 맞아야 한다:
 *     - 여기(단말기): 성공할 때까지 포기하지 않는다 → 누락 없음
 *     - 저기(서버):   같은 결제키는 한 줄만 받는다   → 중복 없음
 *
 *   서버 쪽 근거는 payments/confirm 의 intent.status==="APPROVED" 조기 반환,
 *   toss_payment_transactions.payment_key UNIQUE, 그리고
 *   scripts/migrate-add-payment-idempotency.ts 가 만드는 부분 유니크 인덱스다.
 *
 * ══ 설계 원칙 ══
 *
 *   1. 절대 조용히 버리지 않는다. 못 보낸 건은 남아서 계속 시끄럽게 군다.
 *      "장부에 없는 돈"은 조용한 것보다 시끄러운 쪽이 백 배 낫다.
 *   2. 금액을 여기서 만들어 내지 않는다. 승인 응답에 있던 값을 그대로 나른다.
 *   3. 이 파일은 다른 플러그인 모듈을 import 하지 않는다. 순수 로직이라
 *      루트 테스트(scripts/test-confirm-outbox.ts)가 그대로 불러 쓸 수 있다.
 */

/** 서버 /payments/confirm 에 보낼 본문. 승인 응답에서 만들어 그대로 보관한다. */
export interface ConfirmPayload {
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
}

/** 아웃박스에 들어 있는 한 건. payload 에 재시도 이력을 붙인 것. */
export interface OutboxEntry {
  payload: ConfirmPayload;
  /** 최초로 적은 시각 (epoch ms). 얼마나 오래 못 보내고 있는지의 기준. */
  firstSeenAt: number;
  /** 지금까지 보내 본 횟수. 백오프 계산에 쓴다. */
  attempts: number;
  /** 마지막으로 보내 본 시각 (epoch ms). 0 이면 아직 한 번도 안 보냈다. */
  lastAttemptAt: number;
  /** 마지막 실패 사유. 사람이 읽을 문장. 화면·로그에 그대로 쓴다. */
  lastError?: string;
}

/** 저장소 인터페이스. window.localStorage 가 이 모양이다. 테스트는 가짜를 넣는다. */
export interface OutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const OUTBOX_KEY = "edusyncpro.tossfront.confirmOutbox.v1";

/**
 * 이 기간이 지나도록 못 보낸 건은 "오래된 것"으로 표시한다. **지우지는 않는다.**
 *
 * 14일인 이유: 단말기의 getPayment 캐시 수명이 14일이다. 그 안에는 자동 대사로도
 * 되살릴 수 있다. 그보다 오래됐다면 사람이 개입해야 하는 상태이므로 로그를
 * 경고에서 오류로 올린다. 그래도 데이터는 남긴다 — 원장이 승인번호를 들고
 * 수기 대사를 할 때 필요한 정보가 여기 다 있다.
 */
export const OUTBOX_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * 재시도 간격. 처음엔 촘촘하게, 나중엔 느슨하게.
 *
 * 앞쪽이 촘촘한 이유: 실패의 대부분은 와이파이가 잠깐 흔들린 것이라 몇 초 뒤면
 * 된다. 학생이 아직 단말기 앞에 서 있을 때 들어가는 게 가장 좋다.
 * 뒤쪽이 느슨한 이유: 서버가 정말 죽어 있으면 1초마다 두드려 봐야 배터리와
 * 로그만 축낸다. 5분 간격이면 복구를 놓치지 않으면서 조용하다.
 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 300_000];

export function nextDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const i = Math.min(attempts - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[i];
}

/** 지금 다시 보내 볼 때가 된 건들. */
export function dueEntries(entries: OutboxEntry[], now: number): OutboxEntry[] {
  return entries.filter((e) => now - e.lastAttemptAt >= nextDelayMs(e.attempts));
}

/** 너무 오래 못 보낸 건. 로그 수위를 올리는 판단에만 쓴다. */
export function isStale(entry: OutboxEntry, now: number): boolean {
  return now - entry.firstSeenAt >= OUTBOX_STALE_MS;
}

/**
 * 서버 응답을 보고 "이 건은 끝났는가" 를 판정한다.
 *
 * ⚠️ 여기가 이 파일에서 가장 위험한 함수다. true 를 잘못 돌려주면 아직 장부에
 *    없는 돈을 아웃박스에서 지워 버린다. 그래서 **확실히 장부에 들어갔다고
 *    말할 수 있는 경우에만** true 다.
 *
 *   - 성공(2xx): 서버가 payments 행을 넣었거나 idempotent:true 로 이미 있다고
 *     답한 것이다. 둘 다 장부에 있다. 끝.
 *   - 409 "이미 승인된 결제입니다": intent 가 이미 APPROVED 다. 승인 경로는
 *     장부 INSERT 와 같은 트랜잭션이므로 APPROVED 면 장부에도 있다. 끝.
 *   - 409 "중복된 승인 요청입니다": 유니크 제약(23505)에 걸렸다. 걸릴 수 있는
 *     제약은 toss_payment_transactions.payment_key 와 payments 의 부분 유니크
 *     인덱스 둘뿐이고, **둘 다 "그 결제가 이미 장부에 있다"는 뜻이다.** 끝.
 *   - 그 외 4xx: 서버가 우리 요청을 거절했다. 같은 본문을 다시 보내도 결과는
 *     같겠지만 **지우지 않는다.** 돈은 이미 나갔는데 장부에 없다는 뜻이라
 *     사람이 봐야 한다. 계속 남겨서 로그로 알린다.
 *   - 5xx·네트워크 오류: 명백한 일시 장애. 재시도.
 *
 * ⚠️ 알 수 없는 409 는 settled 가 아니다. 나중에 누가 다른 의미의 409 를 추가해도
 *    이 함수가 그걸 "장부에 들어갔다"고 오해하지 않게, 문구를 화이트리스트로 둔다.
 */
const SETTLED_409_TEXTS = ["이미 승인된 결제", "중복된 승인 요청"];

export function isSettled(httpStatus: number | null, bodyText?: string): boolean {
  if (httpStatus === null) return false;                 // 네트워크 오류
  if (httpStatus >= 200 && httpStatus < 300) return true;
  if (httpStatus === 409) {
    const body = bodyText ?? "";
    return SETTLED_409_TEXTS.some((t) => body.includes(t));
  }
  return false;
}

// ─── 저장소 입출력 ────────────────────────────────────────────────────

/**
 * 저장소에서 읽는다. 어떤 이유로든 못 읽으면 빈 배열이다.
 *
 * 깨진 JSON 을 만나면 던지지 않고 버린다. 여기서 예외가 올라가면 부팅 자체가
 * 막혀 결제를 못 받는다 — 아웃박스 한 줄 때문에 장사를 멈출 수는 없다.
 * 대신 호출부가 알 수 있도록 onError 로 알린다.
 */
export function loadOutbox(
  storage: OutboxStorage | null,
  onError?: (msg: string) => void,
): OutboxEntry[] {
  if (!storage) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(OUTBOX_KEY);
  } catch (err) {
    onError?.(`아웃박스를 읽지 못했습니다: ${String(err)}`);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 최소한의 형태 검증. paymentKey 와 amount 가 없으면 보낼 수 없는 쓰레기다.
    return parsed.filter(
      (e: any) =>
        e &&
        e.payload &&
        typeof e.payload.paymentKey === "string" &&
        e.payload.paymentKey.length > 0 &&
        typeof e.payload.amount === "number",
    ) as OutboxEntry[];
  } catch (err) {
    onError?.(`아웃박스 JSON 이 깨져 있습니다: ${String(err)}`);
    return [];
  }
}

/** 저장소에 쓴다. 실패해도 던지지 않는다 (메모리 사본은 계속 살아 있다). */
export function saveOutbox(
  storage: OutboxStorage | null,
  entries: OutboxEntry[],
  onError?: (msg: string) => void,
): void {
  if (!storage) return;
  try {
    if (entries.length === 0) storage.removeItem(OUTBOX_KEY);
    else storage.setItem(OUTBOX_KEY, JSON.stringify(entries));
  } catch (err) {
    onError?.(`아웃박스를 저장하지 못했습니다: ${String(err)}`);
  }
}

// ─── 목록 조작 (전부 순수 함수) ───────────────────────────────────────

/**
 * 새 승인을 아웃박스에 넣는다. 같은 paymentKey 가 이미 있으면 **덮지 않는다.**
 *
 * 덮지 않는 이유: 기존 항목에는 재시도 이력(attempts, firstSeenAt)이 쌓여 있다.
 * 덮으면 백오프가 처음으로 되돌아가서, 같은 결제를 1초 간격으로 다시 두드리기
 * 시작한다. 승인 내용 자체는 어차피 같다.
 */
export function addEntry(
  entries: OutboxEntry[],
  payload: ConfirmPayload,
  now: number,
): OutboxEntry[] {
  if (entries.some((e) => e.payload.paymentKey === payload.paymentKey)) return entries;
  return [
    ...entries,
    { payload, firstSeenAt: now, attempts: 0, lastAttemptAt: 0 },
  ];
}

/** 장부 반영이 확인된 건을 뺀다. */
export function removeEntry(entries: OutboxEntry[], paymentKey: string): OutboxEntry[] {
  return entries.filter((e) => e.payload.paymentKey !== paymentKey);
}

/** 한 번 보내 봤고 실패했다 — 시도 횟수와 사유를 기록한다. */
export function markAttempt(
  entries: OutboxEntry[],
  paymentKey: string,
  now: number,
  error: string,
): OutboxEntry[] {
  return entries.map((e) =>
    e.payload.paymentKey === paymentKey
      ? { ...e, attempts: e.attempts + 1, lastAttemptAt: now, lastError: error }
      : e,
  );
}
