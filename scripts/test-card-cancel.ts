/**
 * 단말기 카드 취소 → 장부 반영. 돈을 되돌리는 경계 조건을 코드로 고정한다.
 *
 * ══ 이 테스트가 지키려는 것 ══
 *
 *   원장이 못 박은 두 가지다.
 *     1. "장부에도 환불이 반영이 되어야해 꼭"
 *     2. (이전부터) "payment intent의 UI 상태만 수정해서 해결된 것처럼 만들지 마라"
 *
 *   그래서 이 파일의 단언은 거의 전부 **그 학생 그 달에 얼마가 적혔고 얼마가
 *   남았는가** 다. intent 상태가 CANCELED 로 바뀌었는지는 곁가지로만 본다.
 *
 * ══ 결제 테스트와 무엇이 다른가 ══
 *
 *   test-ledger-reflection.ts 는 "빠뜨리지 않는 것"을 증명한다. 승인이 장부에
 *   반드시 들어가는지. 재시도해도 한 줄인지.
 *
 *   이 파일은 반대다. **하지 말아야 할 것을 안 하는지**를 증명한다.
 *   결제가 중복되면 우리가 환불하면 되지만, 취소가 중복되면 학부모 카드로 돈이
 *   두 번 들어가고 우리에겐 그걸 되돌릴 API 가 없다 (Open API 시크릿 키가 없다).
 *   그래서 애매하면 무조건 거절하는 쪽으로 기운다. 그 기울기를 여기서 고정한다.
 *
 *   판정 함수는 전부 운영 코드에서 그대로 import 한다:
 *     · classifyCardCancel / classifyCancelResult / remainingRefundable
 *                              (server/toss-front/cardCancel.ts)
 *     · webhookCancelAmount    (server/toss-front/refund.ts)
 *     · classifyRefund         (server/toss-front/refund.ts)  — 수기 환불과의 상호작용
 *     · computeMonthStatus 외  (shared/paymentStatus.ts)      — 수납 화면 계산
 *
 *   장부(payments)와 취소 큐(payment_cancel_dispatches)만 이 파일 안의 모형이다.
 *   모형은 DB 제약을 그대로 흉내 낸다 — 특히
 *   scripts/migrate-add-card-cancel.ts 가 만드는
 *     CREATE UNIQUE INDEX … ON payment_cancel_dispatches (payment_key)
 *      WHERE status <> 'FAILED'
 *   즉 아래 "이중 취소 없음" 단언들은 코드의 선의가 아니라 DB 제약에 기대고 있다.
 *
 * 실행: npx tsx scripts/test-card-cancel.ts
 */

import assert from "node:assert/strict";
import {
  classifyCardCancel,
  classifyCancelResult,
  remainingRefundable,
  RETRYABLE_CANCEL_STATES,
  OPEN_CANCEL_STATES,
  CANCEL_DISPATCH_TTL_MS,
  CANCEL_DEVICE_STALE_MS,
  DEVICE_TOUCH_INTERVAL_MS,
  decideCancelReroute,
  normalizeApprovedTimestamp,
  UNRESOLVABLE_APPROVAL_NUMBERS,
  type CancelDispatchStatus,
  type CancelSourceFacts,
} from "../server/toss-front/cardCancel";
import { webhookCancelAmount, classifyRefund } from "../server/toss-front/refund";
import { computeMonthStatus, isOutstanding, PARTIAL_PAYMENT_SINCE } from "../shared/paymentStatus";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e?.message ?? e}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 모형
// ─────────────────────────────────────────────────────────────────────

interface LedgerRow {
  externalPaymentKey: string;
  paymentMonth: string; // YYYY-MM
  amount: number; // 수입 양수, 환불 음수
  source: "confirm" | "webhook" | "manual" | "terminal-cancel";
}

class DuplicateIncomeError extends Error {
  constructor(key: string) {
    super(`payments_external_payment_key_income_uniq 위반: ${key}`);
  }
}

/** payments 테이블 모형. 부분 유니크 인덱스(수입은 결제키당 한 줄)를 지킨다. */
class Ledger {
  rows: LedgerRow[] = [];

  insert(row: LedgerRow) {
    if (
      row.amount > 0 &&
      this.rows.some((r) => r.externalPaymentKey === row.externalPaymentKey && r.amount > 0)
    ) {
      throw new DuplicateIncomeError(row.externalPaymentKey);
    }
    this.rows.push(row);
  }

  paidIn(key: string): number {
    return this.rows
      .filter((r) => r.externalPaymentKey === key && r.amount > 0)
      .reduce((s, r) => s + r.amount, 0);
  }

  refunded(key: string): number {
    const sum = this.rows
      .filter((r) => r.externalPaymentKey === key && r.amount < 0)
      .reduce((s, r) => s + r.amount, 0);
    // 서버는 coalesce(-sum(...), 0)::int 를 쓰므로 환불 행이 없으면 정수 0 이다.
    // JS 에서 -0 을 그대로 두면 assert.equal(x, 0) 이 실패해 모형과 실물이 갈라진다.
    return sum === 0 ? 0 : -sum;
  }

  netByMonth(): Map<string, number> {
    const m = new Map<string, number>();
    for (const r of this.rows) m.set(r.paymentMonth, (m.get(r.paymentMonth) ?? 0) + r.amount);
    return m;
  }
}

class DuplicateCancelError extends Error {
  constructor(key: string) {
    super(`payment_cancel_dispatches_active_uniq 위반: ${key}`);
  }
}

interface CancelRow {
  id: string;
  paymentKey: string;
  cancelAmount: number;
  ledgerAmount: number;
  status: CancelDispatchStatus;
  expiresAt: number;
}

/**
 * payment_cancel_dispatches 모형.
 *
 * 유니크 조건이 `status <> 'FAILED'` 라는 게 핵심이다. TIMEOUT 은 인덱스 **안에**
 * 있으므로, 애플리케이션 판정을 뚫고 들어오더라도 DB 가 두 번째 취소를 거부한다.
 */
class CancelQueue {
  rows: CancelRow[] = [];
  private seq = 0;

  statesFor(paymentKey: string): CancelDispatchStatus[] {
    return this.rows.filter((r) => r.paymentKey === paymentKey).map((r) => r.status);
  }

  insert(paymentKey: string, cancelAmount: number, ledgerAmount: number, now: number): CancelRow {
    if (this.rows.some((r) => r.paymentKey === paymentKey && r.status !== "FAILED")) {
      throw new DuplicateCancelError(paymentKey);
    }
    const row: CancelRow = {
      id: `cd-${++this.seq}`,
      paymentKey,
      cancelAmount,
      ledgerAmount,
      status: "PENDING",
      expiresAt: now + CANCEL_DISPATCH_TTL_MS,
    };
    this.rows.push(row);
    return row;
  }

  /** 단말기 선점. PENDING 일 때만 DELIVERED 로 넘어간다 (조건부 UPDATE). */
  ack(id: string): boolean {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.status !== "PENDING") return false;
    row.status = "DELIVERED";
    return true;
  }

  /**
   * 만료 스위퍼. 재시도는 절대 걸지 않는다. 다만 만료를 한 덩어리로 보지 않는다.
   *
   *   PENDING 으로 만료  = 아무 단말기도 집어가지 않았다 (ack 가 없었다).
   *                        플러그인은 ack 가 실패하면 SDK 를 부르지 않으므로
   *                        카드는 확실히 안 건드려졌다 → FAILED (재시도 가능)
   *   DELIVERED 로 만료 = 집어갔는데 결과가 없다. 모른다 → TIMEOUT (사람 호출)
   */
  sweep(now: number) {
    for (const r of this.rows) {
      if (r.expiresAt > now) continue;
      if (r.status === "PENDING") r.status = "FAILED";
      else if (r.status === "DELIVERED") r.status = "TIMEOUT";
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 서버 동작 모형 (cardCancelRoutes.ts 의 판단 순서를 그대로 따른다)
// ─────────────────────────────────────────────────────────────────────

interface Intent {
  status: string;
  amount: number;
  paymentMonth: string;
}

interface Approval {
  approvalNumber: string | null;
  approvedTimestamp: string | null;
  deviceId: string | null;
  /** 없으면 실제 승인에서 늘 채워지는 값으로 본다. 빈 TID 는 별도 테스트에서 다룬다. */
  tid?: string | null;
}

/** POST /admin/card-cancels 한 번. */
function requestCancel(
  ledger: Ledger,
  queue: CancelQueue,
  intent: Intent,
  approval: Approval | null,
  paymentKey: string,
  now: number,
): { status: number; reason?: string; needsHuman?: boolean; row?: CancelRow } {
  const facts: CancelSourceFacts = {
    intentStatus: intent.status,
    approvedAmount: intent.amount,
    ledgerPaidIn: ledger.paidIn(paymentKey),
    ledgerRefunded: ledger.refunded(paymentKey),
    hasApprovalRecord: approval !== null,
    approvalNumber: approval?.approvalNumber ?? null,
    approvedTimestamp: approval?.approvedTimestamp ?? null,
    tid: approval === null ? null : (approval.tid ?? "TID-TEST-0001"),
    deviceId: approval?.deviceId ?? null,
    existingCancelStates: queue.statesFor(paymentKey),
  };

  const decision = classifyCardCancel(facts);
  if (decision.kind === "reject") {
    return { status: 409, reason: decision.reason, needsHuman: decision.needsHuman };
  }

  try {
    const row = queue.insert(paymentKey, decision.cancelAmount, decision.ledgerAmount, now);
    return { status: 200, row };
  } catch (e) {
    // 23505 — 판정을 통과했더라도 DB 가 마지막으로 막는다 (동시 요청).
    if (e instanceof DuplicateCancelError) return { status: 409, reason: "이미 취소가 진행 중입니다." };
    throw e;
  }
}

/**
 * POST /dispatch/cancel/:id/result 한 번.
 *
 * 여기가 이 기능의 심장이다. **카드가 실제로 취소됐을 때만** 장부에 음수 행을 쓴다.
 * 그리고 금액은 저장해 둔 ledgerAmount 가 아니라 **지금 다시 계산한다** —
 * 요청과 응답 사이에 취소 웹훅이나 수기 환불이 들어왔을 수 있기 때문이다.
 */
function reportCancelResult(
  ledger: Ledger,
  queue: CancelQueue,
  intent: Intent,
  id: string,
  sdkResult: string,
): { ok: boolean; idempotent?: boolean; wrote: number } {
  const row = queue.rows.find((r) => r.id === id);
  if (!row) return { ok: false, wrote: 0 };

  // 이미 확정된 건은 다시 처리하지 않는다 (단말기 아웃박스가 재전송한다).
  if (row.status === "SUCCEEDED" || row.status === "FAILED") {
    return { ok: true, idempotent: true, wrote: 0 };
  }

  const { status, cardCancelled } = classifyCancelResult(sdkResult);
  row.status = status;

  if (!cardCancelled) return { ok: true, wrote: 0 };

  const toWrite = remainingRefundable(ledger.paidIn(row.paymentKey), ledger.refunded(row.paymentKey));
  if (toWrite > 0) {
    ledger.insert({
      externalPaymentKey: row.paymentKey,
      paymentMonth: intent.paymentMonth,
      amount: -toWrite,
      source: "terminal-cancel",
    });
  }
  row.ledgerAmount = toWrite;
  intent.status = "CANCELED";
  return { ok: true, wrote: toWrite };
}

/** 취소 웹훅 한 번 (webhooks.ts 그대로). */
function webhookCancelled(ledger: Ledger, intent: Intent, paymentKey: string) {
  const amount = webhookCancelAmount(ledger.paidIn(paymentKey), ledger.refunded(paymentKey));
  if (amount > 0) {
    ledger.insert({
      externalPaymentKey: paymentKey,
      paymentMonth: intent.paymentMonth,
      amount: -amount,
      source: "webhook",
    });
  }
  intent.status = "CANCELED";
}

/** 원장 수기 환불 한 번 (/admin/refunds). 장부만 건드리고 카드는 안 건드린다. */
function manualRefund(ledger: Ledger, intent: Intent, paymentKey: string, requested: number) {
  const d = classifyRefund({
    intentStatus: intent.status,
    approvedAmount: intent.amount,
    alreadyRefunded: ledger.refunded(paymentKey),
    requested,
  });
  if (d.kind === "reject") return { ok: false, reason: d.reason };
  ledger.insert({
    externalPaymentKey: paymentKey,
    paymentMonth: intent.paymentMonth,
    amount: -d.amount,
    source: "manual",
  });
  return { ok: true, amount: d.amount };
}

/** 수납 화면 한 달치. */
function 수납(ledger: Ledger, month: string, tuition: number) {
  return computeMonthStatus(month, tuition, ledger.netByMonth().get(month) ?? 0, PARTIAL_PAYMENT_SINCE);
}

const NOW = Date.parse("2026-08-30T12:00:00Z");
const 청구월 = "2026-09";
const 수강료 = 15_000;

/** 현장에 실제로 있는 그 건: 1,000원 카드 승인. 3단계에서 이걸로 실검증한다. */
function 천원건(): { ledger: Ledger; queue: CancelQueue; intent: Intent; approval: Approval } {
  const ledger = new Ledger();
  ledger.insert({ externalPaymentKey: "pk-1000", paymentMonth: 청구월, amount: 1000, source: "confirm" });
  return {
    ledger,
    queue: new CancelQueue(),
    intent: { status: "APPROVED", amount: 1000, paymentMonth: 청구월 },
    approval: { approvalNumber: "12345678", approvedTimestamp: "1756555555000", deviceId: "dev-1" },
  };
}

// ─────────────────────────────────────────────────────────────────────
console.log("─── 1. ★ 원장 요구사항: 취소하면 장부에 반드시 반영된다 ───");

test("★ 1,000원 승인 → 부분납 · 단말기 취소 성공 → 다시 미납", () => {
  const { ledger, queue, intent, approval } = 천원건();

  const before = 수납(ledger, 청구월, 수강료);
  assert.equal(before.paid, 1000);
  assert.equal(before.remaining, 14_000);
  assert.equal(before.status, "부분납");

  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  assert.equal(req.status, 200);
  assert.equal(queue.ack(req.row!.id), true);
  const res = reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");

  assert.equal(res.wrote, 1000, "★ 장부에 -1,000원이 적혀야 한다");
  const after = 수납(ledger, 청구월, 수강료);
  assert.equal(after.paid, 0, "★ 취소 후 그 달 납부액은 0");
  assert.equal(after.remaining, 15_000, "★ 잔액이 청구액 전액으로 복구");
  assert.equal(after.status, "미납");
  assert.equal(isOutstanding(after), true, "다시 미납 목록에 나타나야 한다");
});

test("★ 장부에 실제로 음수 행이 생긴다 (상태 플래그만 바뀌는 게 아니다)", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");

  const 음수행 = ledger.rows.filter((r) => r.amount < 0);
  assert.equal(음수행.length, 1);
  assert.equal(음수행[0].amount, -1000);
  assert.equal(음수행[0].paymentMonth, 청구월, "원결제와 같은 달에 상계돼야 한다");
  assert.equal(음수행[0].source, "terminal-cancel");
});

test("★ 27만원 건도 같은 규칙으로 복구된다 (금액은 하드코딩이 아니다)", () => {
  for (const [amount, tuition] of [
    [1000, 15_000],
    [270_000, 270_000],
    [100_000, 280_000],
  ]) {
    const ledger = new Ledger();
    ledger.insert({ externalPaymentKey: "pk", paymentMonth: 청구월, amount, source: "confirm" });
    const queue = new CancelQueue();
    const intent: Intent = { status: "APPROVED", amount, paymentMonth: 청구월 };
    const approval: Approval = { approvalNumber: "9", approvedTimestamp: "1756555555000", deviceId: "dev-1" };

    const req = requestCancel(ledger, queue, intent, approval, "pk", NOW);
    assert.equal(req.status, 200);
    reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");

    const m = 수납(ledger, 청구월, tuition);
    assert.equal(m.paid, 0, `${amount}원 취소 후 납부액이 0 이 아니다`);
    assert.equal(m.remaining, tuition, `${amount}원 취소 후 잔액이 청구액과 다르다`);
  }
});

test("★ 부분결제 중 한 건만 취소하면 나머지는 그대로 남는다", () => {
  const ledger = new Ledger();
  ledger.insert({ externalPaymentKey: "pk-a", paymentMonth: 청구월, amount: 1000, source: "confirm" });
  ledger.insert({ externalPaymentKey: "pk-b", paymentMonth: 청구월, amount: 14_000, source: "confirm" });
  assert.equal(수납(ledger, 청구월, 수강료).status, "완납");

  const queue = new CancelQueue();
  const intentB: Intent = { status: "APPROVED", amount: 14_000, paymentMonth: 청구월 };
  const approval: Approval = { approvalNumber: "9", approvedTimestamp: "1756555555000", deviceId: "dev-1" };
  const req = requestCancel(ledger, queue, intentB, approval, "pk-b", NOW);
  reportCancelResult(ledger, queue, intentB, req.row!.id, "SUCCESS");

  const m = 수납(ledger, 청구월, 수강료);
  assert.equal(m.paid, 1000, "취소하지 않은 1,000원은 남아야 한다");
  assert.equal(m.remaining, 14_000);
  assert.equal(m.status, "부분납");
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 2. ★ 카드가 안 취소됐으면 장부도 안 건드린다 ───");

test("★ FAILED — 카드는 그대로, 장부도 그대로, 수납 화면도 그대로", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  queue.ack(req.row!.id);

  const before = JSON.stringify(ledger.rows);
  const res = reportCancelResult(ledger, queue, intent, req.row!.id, "FAILED");

  assert.equal(res.wrote, 0);
  assert.equal(JSON.stringify(ledger.rows), before, "장부가 한 글자도 변하면 안 된다");
  assert.equal(수납(ledger, 청구월, 수강료).paid, 1000, "돈은 아직 학원에 있다");
  assert.equal(intent.status, "APPROVED", "실패했으므로 승인 상태 그대로다");
});

test("★ CANCELED — 사용자가 단말기에서 물렀다. 이것도 '카드 안 취소됨'이다", () => {
  // 가장 헷갈리기 쉬운 지점. 이름이 CANCELED 라고 "취소 성공"이 아니다.
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  const res = reportCancelResult(ledger, queue, intent, req.row!.id, "CANCELED");

  assert.equal(res.wrote, 0, "★ CANCELED 로 장부에 환불이 적히면 돈이 두 번 나간다");
  assert.equal(수납(ledger, 청구월, 수강료).paid, 1000);
  assert.equal(queue.rows[0].status, "FAILED", "우리 관점에서는 실패다");
});

test("★ TIMEOUT — 모르는 상태. 장부에 아무것도 안 적는다", () => {
  // 카드가 취소됐을 수도 있다. 그래도 안 적는다. 적었다가 실제로는 안 취소됐으면
  // "장부엔 환불인데 돈은 안 돌아간" 상태가 되고, 그건 학부모와 다투게 된다.
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  const res = reportCancelResult(ledger, queue, intent, req.row!.id, "TIMEOUT");

  assert.equal(res.wrote, 0);
  assert.equal(ledger.rows.filter((r) => r.amount < 0).length, 0);
  assert.equal(queue.rows[0].status, "TIMEOUT");
});

test("모르는 결과 타입은 TIMEOUT 으로 취급한다 (모른다 쪽으로 기운다)", () => {
  assert.deepEqual(classifyCancelResult("SUCCESS"), { status: "SUCCEEDED", cardCancelled: true });
  assert.deepEqual(classifyCancelResult("FAILED"), { status: "FAILED", cardCancelled: false });
  assert.deepEqual(classifyCancelResult("CANCELED"), { status: "FAILED", cardCancelled: false });
  assert.deepEqual(classifyCancelResult("TIMEOUT"), { status: "TIMEOUT", cardCancelled: false });
  for (const unknown of ["", "success", "OK", "UNKNOWN_ERROR", "NETWORK"]) {
    assert.deepEqual(
      classifyCancelResult(unknown),
      { status: "TIMEOUT", cardCancelled: false },
      `'${unknown}' 을 성공으로 오인하면 안 된다`,
    );
  }
});

test("★ cardCancelled=true 인 결과는 SUCCESS 하나뿐이다", () => {
  // 앞으로 SDK 결과 타입이 늘어나도 이 단언이 깨지면 사람이 다시 판단해야 한다.
  const 성공 = ["SUCCESS", "FAILED", "CANCELED", "TIMEOUT", "PENDING", "APPROVED"].filter(
    (t) => classifyCancelResult(t).cardCancelled,
  );
  assert.deepEqual(성공, ["SUCCESS"]);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 3. ★ 이중 취소 방어 — 이 기능에서 가장 위험한 부분 ───");

test("★ 재시도 가능한 상태는 FAILED 하나뿐이다", () => {
  assert.deepEqual([...RETRYABLE_CANCEL_STATES], ["FAILED"]);
  const 전체: CancelDispatchStatus[] = ["PENDING", "DELIVERED", "SUCCEEDED", "FAILED", "TIMEOUT"];
  for (const s of 전체) {
    if (s === "FAILED") continue;
    assert.equal(RETRYABLE_CANCEL_STATES.includes(s), false, `${s} 를 재시도하면 이중 취소가 난다`);
  }
});

test("★ TIMEOUT 은 자동 재시도하지 않는다 — 사람이 확인해야 한다", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const first = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  reportCancelResult(ledger, queue, intent, first.row!.id, "TIMEOUT");

  const second = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  assert.equal(second.status, 409);
  assert.equal(second.needsHuman, true, "★ 화면에 '사장님 앱에서 확인하라'가 떠야 한다");
  assert.match(second.reason!, /사장님 앱/);
});

test("★ 판정을 뚫어도 DB 부분 유니크 인덱스가 두 번째 취소를 막는다", () => {
  // status <> 'FAILED' 이므로 TIMEOUT 행도 인덱스 안에 있다.
  const queue = new CancelQueue();
  queue.insert("pk-1000", 1000, 1000, NOW);
  queue.rows[0].status = "TIMEOUT";
  assert.throws(() => queue.insert("pk-1000", 1000, 1000, NOW), DuplicateCancelError);

  queue.rows[0].status = "SUCCEEDED";
  assert.throws(() => queue.insert("pk-1000", 1000, 1000, NOW), DuplicateCancelError);

  queue.rows[0].status = "DELIVERED";
  assert.throws(() => queue.insert("pk-1000", 1000, 1000, NOW), DuplicateCancelError);
});

test("★ FAILED 뒤에는 다시 걸 수 있다 (카드를 확실히 안 건드렸으므로)", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const first = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  reportCancelResult(ledger, queue, intent, first.row!.id, "FAILED");

  const second = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  assert.equal(second.status, 200, "명시적 실패 뒤에는 다시 시도할 수 있어야 한다");

  reportCancelResult(ledger, queue, intent, second.row!.id, "SUCCESS");
  assert.equal(수납(ledger, 청구월, 수강료).paid, 0);
  assert.equal(ledger.rows.filter((r) => r.amount < 0).length, 1, "재시도해도 음수 행은 한 줄");
});

test("★ 원장이 버튼을 두 번 눌러도 취소는 한 번만 나간다", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const a = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  const b = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);

  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  assert.equal(queue.rows.length, 1);
});

test("★ 성공한 뒤 또 누르면 거절한다", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");

  const again = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  assert.equal(again.status, 409);
  assert.equal(ledger.rows.filter((r) => r.amount < 0).length, 1);
});

test("★ 단말기가 결과를 두 번 보고해도 장부는 한 줄 (아웃박스 재전송)", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);

  const first = reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");
  const second = reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");
  const third = reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");

  assert.equal(first.wrote, 1000);
  assert.equal(second.idempotent, true);
  assert.equal(third.idempotent, true);
  assert.equal(ledger.refunded("pk-1000"), 1000, "★ 세 번 보고했다고 3,000원이 되면 안 된다");
  assert.equal(수납(ledger, 청구월, 수강료).paid, 0);
});

test("★ 단말기 두 대가 같은 취소를 집으려 하면 하나만 성공한다 (선점)", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);

  assert.equal(queue.ack(req.row!.id), true, "먼저 집은 쪽만 성공");
  assert.equal(queue.ack(req.row!.id), false, "두 번째는 409 — 카드를 두 번 건드리지 않는다");
});

test("★ 단말기가 집어간 뒤 만료되면 TIMEOUT 이다 (카드 상태를 모른다)", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  queue.ack(req.row!.id);

  queue.sweep(NOW + CANCEL_DISPATCH_TTL_MS + 1);

  assert.equal(queue.rows[0].status, "TIMEOUT");
  assert.equal(queue.rows.length, 1, "스위퍼가 새 취소를 만들면 안 된다");
  assert.equal(ledger.rows.filter((r) => r.amount < 0).length, 0, "장부도 안 건드린다");
});

test("★ 아무도 집어가지 않고 만료되면 FAILED 다 — 다시 걸 수 있어야 한다", () => {
  // 단말기가 꺼져 있었거나, 취소를 모르는 구버전 플러그인이 붙어 있었던 경우다.
  // ack 가 없었다는 것은 requestPaymentCancel 이 불리지 않았다는 뜻이고,
  // 그러면 카드는 확실히 안 건드려졌다.
  const { ledger, queue, intent, approval } = 천원건();
  requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);

  queue.sweep(NOW + CANCEL_DISPATCH_TTL_MS + 1);

  assert.equal(queue.rows[0].status, "FAILED");
  assert.equal(ledger.rows.filter((r) => r.amount < 0).length, 0, "장부는 그대로");
});

test("★ 집어가지 않은 채 만료된 건은 결제를 잠그지 않는다", () => {
  // 이게 이 구분의 존재 이유다. TIMEOUT 으로 뭉뚱그리면 부분 유니크 인덱스가
  // 그 결제키를 영영 잠가서, 아무 일도 안 일어났는데 사람이 DB 를 열어야 한다.
  const { ledger, queue, intent, approval } = 천원건();
  requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  queue.sweep(NOW + CANCEL_DISPATCH_TTL_MS + 1);

  const again = requestCancel(
    ledger,
    queue,
    intent,
    approval,
    "pk-1000",
    NOW + CANCEL_DISPATCH_TTL_MS + 2
  );
  assert.equal(again.status, 200, `★ 단말기를 켜고 다시 걸 수 있어야 한다 (${again.reason ?? ""})`);
  assert.equal(queue.rows.length, 2);
});

test("만료 전에는 스위퍼가 건드리지 않는다", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  queue.sweep(NOW + CANCEL_DISPATCH_TTL_MS - 1000);
  assert.equal(queue.rows[0].status, "PENDING");
  void req;
});

test("진행 중 상태 목록은 PENDING·DELIVERED 다", () => {
  assert.deepEqual([...OPEN_CANCEL_STATES].sort(), ["DELIVERED", "PENDING"]);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 4. ★ 걸 수 없는 건은 걸지 않는다 (SDK 를 부르기 전에 거른다) ───");

function facts(over: Partial<CancelSourceFacts> = {}): CancelSourceFacts {
  return {
    intentStatus: "APPROVED",
    approvedAmount: 1000,
    ledgerPaidIn: 1000,
    ledgerRefunded: 0,
    hasApprovalRecord: true,
    approvalNumber: "12345678",
    approvedTimestamp: "1756555555000",
    tid: "TID-TEST-0001",
    deviceId: "dev-1",
    existingCancelStates: [],
    ...over,
  };
}

test("정상 건은 통과하고 금액이 맞다", () => {
  const d = classifyCardCancel(facts());
  assert.equal(d.kind, "ok");
  assert.equal((d as any).cancelAmount, 1000, "카드에서 되돌릴 금액 = 원승인 전액");
  assert.equal((d as any).ledgerAmount, 1000, "장부에 적을 금액 = 아직 안 적힌 만큼");
});

test("★ 승인 안 된 건은 못 건다", () => {
  for (const s of ["CREATED", "PROCESSING", "CANCELED", "TIMEOUT", "FAILED"]) {
    const d = classifyCardCancel(facts({ intentStatus: s }));
    assert.equal(d.kind, "reject", `${s} 상태를 통과시키면 안 된다`);
  }
});

test("진행 중(CREATED/PROCESSING)은 '3분 뒤 정리된다'고 안내한다", () => {
  for (const s of ["CREATED", "PROCESSING"]) {
    const d = classifyCardCancel(facts({ intentStatus: s })) as any;
    assert.match(d.reason, /3분/);
  }
});

test("★ 승인번호·승인시각이 없으면 못 건다 (SDK 필수 파라미터다)", () => {
  for (const over of [
    { hasApprovalRecord: false },
    { approvalNumber: null },
    { approvedTimestamp: null },
  ] as Partial<CancelSourceFacts>[]) {
    const d = classifyCardCancel(facts(over)) as any;
    assert.equal(d.kind, "reject");
    assert.equal(d.needsHuman, true, "사람이 사장님 앱에서 처리해야 한다");
  }
});

test("★ 승인번호 자리의 표식들은 전부 못 건다 (실물 승인번호가 아니다)", () => {
  // 승인번호 칼럼이 NOT NULL 이라 "없음" 을 적을 자리가 없어서, 승인번호를 못 얻은
  // 경로들이 각자 표식을 넣어 두었다. 무엇이든 그대로 단말기에 넘기면 원거래를
  // 못 찾는다 — 2026-08-31 "원거래 없음" 사고에서 실제로 보낸 값이 "복구" 였다.
  //
  // 목록 자체를 돌려서 시험한다. 표식이 하나 늘면 여기도 자동으로 같이 늘어야
  // 하기 때문이다. 손으로 적어 두면 그때 빠뜨린다.
  for (const marker of UNRESOLVABLE_APPROVAL_NUMBERS) {
    const d = classifyCardCancel(facts({ approvalNumber: marker })) as any;
    assert.equal(d.kind, "reject", `${marker} 를 통과시켰다`);
    assert.equal(d.needsHuman, true, `${marker} 는 사람이 사장님 앱에서 처리해야 한다`);
    // 원장이 화면에서 읽는 문장이다. 어떤 값이 문제였는지 보여야 문의가 줄어든다.
    assert.ok(d.reason.includes(marker), `${marker} 가 사유에 안 보인다`);
    assert.match(d.reason, /사장님 앱/);
  }
});

test("정상 승인번호는 이 관문을 통과한다 (표식만 걸러야 한다)", () => {
  // 표식 목록이 지나치게 넓어져 멀쩡한 취소를 막는 일이 없도록 반대편도 고정한다.
  const d = classifyCardCancel(facts({ approvalNumber: "01234567" })) as any;
  assert.notEqual(d.kind, "reject");
});

test("★ 단말기를 모르면 못 건다 (보낼 곳이 없다)", () => {
  const d = classifyCardCancel(facts({ deviceId: null })) as any;
  assert.equal(d.kind, "reject");
  assert.equal(d.needsHuman, true);
});

test("★ 장부에 입금 기록이 없으면 못 건다 (먼저 대사해야 한다)", () => {
  const d = classifyCardCancel(facts({ ledgerPaidIn: 0 })) as any;
  assert.equal(d.kind, "reject");
  assert.equal(d.needsHuman, true);
  assert.match(d.reason, /수기 대사/);
});

test("★ 이미 전액 환불된 건은 못 건다", () => {
  const d = classifyCardCancel(facts({ ledgerPaidIn: 1000, ledgerRefunded: 1000 })) as any;
  assert.equal(d.kind, "reject");
  assert.equal(d.needsHuman, undefined, "이건 사람 손이 필요한 게 아니라 그냥 끝난 건이다");
});

test("★ 과환불 상태(음수)에서도 통과시키지 않는다", () => {
  const d = classifyCardCancel(facts({ ledgerPaidIn: 1000, ledgerRefunded: 3000 }));
  assert.equal(d.kind, "reject");
});

test("★ 검사 순서: 진행 중 취소가 다른 모든 문제보다 먼저 걸린다", () => {
  // 버튼 두 번 누르기는 가장 흔하고 가장 위험하다. 다른 이유로 거절되면
  // 원장이 그 이유를 고친 뒤 다시 눌러 이중 취소가 날 수 있다.
  const d = classifyCardCancel(
    facts({ existingCancelStates: ["PENDING"], intentStatus: "CANCELED", deviceId: null }),
  ) as any;
  assert.match(d.reason, /단말기 화면/);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 5. ★ 단말기 취소 · 취소 웹훅 · 수기 환불이 섞여 도착해도 정확하다 ───");

test("★ 단말기 취소 성공 뒤 취소 웹훅이 와도 두 번 빠지지 않는다", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");

  webhookCancelled(ledger, intent, "pk-1000"); // 토스가 취소 웹훅을 보낸다
  webhookCancelled(ledger, intent, "pk-1000"); // 재전송

  assert.equal(ledger.refunded("pk-1000"), 1000, "★ -2,000원이 되면 안 된다");
  assert.equal(수납(ledger, 청구월, 수강료).paid, 0);
  assert.equal(수납(ledger, 청구월, 수강료).remaining, 15_000);
});

test("★ 취소 웹훅이 먼저 오고 단말기 보고가 늦게 와도 마찬가지", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);

  webhookCancelled(ledger, intent, "pk-1000"); // 웹훅이 먼저 도착
  const res = reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");

  assert.equal(res.wrote, 0, "★ 이미 적혔으므로 추가로 적을 게 없다");
  assert.equal(ledger.refunded("pk-1000"), 1000);
  assert.equal(수납(ledger, 청구월, 수강료).paid, 0);
});

test("★ 원장이 수기로 먼저 환불 기록해 둔 경우 — 카드는 전액, 장부는 나머지만", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const manual = manualRefund(ledger, intent, "pk-1000", 400); // 400원만 먼저 기록
  assert.equal(manual.ok, true);

  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  assert.equal(req.status, 200);
  assert.equal(req.row!.cancelAmount, 1000, "★ 카드는 전액 취소된다 (부분 취소 API 가 없다)");
  assert.equal(req.row!.ledgerAmount, 600, "★ 장부에는 아직 안 적힌 600원만");

  const res = reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");
  assert.equal(res.wrote, 600);
  assert.equal(ledger.refunded("pk-1000"), 1000, "합계는 정확히 원승인액");
  assert.equal(수납(ledger, 청구월, 수강료).paid, 0);
});

test("★ 요청과 응답 사이에 수기 환불이 끼어들어도 이중 계상되지 않는다", () => {
  // 저장된 ledgerAmount 를 그대로 쓰면 여기서 틀린다. 응답 시점에 다시 센다.
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  assert.equal(req.row!.ledgerAmount, 1000, "요청 시점에는 1,000원 예정");

  manualRefund(ledger, intent, "pk-1000", 1000); // 그 사이 원장이 수기로 전액 기록

  const res = reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");
  assert.equal(res.wrote, 0, "★ 저장값 1,000 을 그대로 썼다면 -2,000원이 됐을 것");
  assert.equal(ledger.refunded("pk-1000"), 1000);
  assert.equal(수납(ledger, 청구월, 수강료).paid, 0);
});

test("★ 세 경로가 모두 도착해도 환불 총액은 원승인액을 넘지 않는다", () => {
  for (const 순서 of [
    ["terminal", "webhook", "manual"],
    ["webhook", "terminal", "manual"],
    ["manual", "webhook", "terminal"],
    ["manual", "terminal", "webhook"],
    ["webhook", "manual", "terminal"],
    ["terminal", "manual", "webhook"],
  ]) {
    const { ledger, queue, intent, approval } = 천원건();
    const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);

    for (const step of 순서) {
      if (step === "terminal") reportCancelResult(ledger, queue, intent, req.row!.id, "SUCCESS");
      if (step === "webhook") webhookCancelled(ledger, intent, "pk-1000");
      if (step === "manual") manualRefund(ledger, intent, "pk-1000", 1000);
    }

    assert.equal(ledger.refunded("pk-1000"), 1000, `순서 [${순서}] 에서 환불 총액이 틀렸다`);
    assert.equal(수납(ledger, 청구월, 수강료).paid, 0, `순서 [${순서}] 에서 수납이 틀렸다`);
    assert.equal(수납(ledger, 청구월, 수강료).remaining, 15_000);
  }
});

test("★ 취소가 실패했는데 웹훅도 안 오면 돈은 그대로 학원에 있다", () => {
  const { ledger, queue, intent, approval } = 천원건();
  const req = requestCancel(ledger, queue, intent, approval, "pk-1000", NOW);
  reportCancelResult(ledger, queue, intent, req.row!.id, "FAILED");

  assert.equal(ledger.refunded("pk-1000"), 0);
  assert.equal(수납(ledger, 청구월, 수강료).paid, 1000, "★ 유령 환불이 생기면 안 된다");
  assert.equal(수납(ledger, 청구월, 수강료).status, "부분납");
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 6. 금액 계산이 기존 환불 경로와 같은 근거를 쓴다 ───");

test("★ remainingRefundable 와 webhookCancelAmount 는 항상 같은 값을 낸다", () => {
  // 셋(단말기 취소·웹훅·수기)이 같은 식을 써야 서로 중복 계상하지 않는다.
  const 표본 = [0, 1, 400, 999, 1000, 14_000, 270_000];
  for (const paid of 표본) {
    for (const refunded of 표본) {
      assert.equal(
        remainingRefundable(paid, refunded),
        webhookCancelAmount(paid, refunded),
        `paid=${paid} refunded=${refunded} 에서 두 경로가 갈라졌다`,
      );
    }
  }
});

test("바닥은 0 이다 — 화면에 음수 환불 가능액이 뜨지 않는다", () => {
  assert.equal(remainingRefundable(1000, 3000), 0);
  assert.equal(remainingRefundable(0, 0), 0);
});

test("TTL 은 결제(3분)보다 넉넉하다 — 카드 재삽입·서명 시간이 필요하다", () => {
  assert.equal(CANCEL_DISPATCH_TTL_MS, 5 * 60 * 1000);
  assert.ok(CANCEL_DISPATCH_TTL_MS > 3 * 60 * 1000);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 6-b. ★ 원승인 시각 = 단말기가 원거래를 찾는 조회 키 ───");
//
// 2026-08-30 현장. 원장이 [카드 취소] 를 눌렀더니 단말기에 취소 화면이 떴다가
// "요청건이 없다" 며 원래 화면으로 돌아갔다. 배달·ack·SDK 호출까지 다 됐는데
// 단말기가 원거래를 못 찾은 것이었다.
//
// 범인은 timestamp 의 형식이었다.
//   · SDK requestPaymentCancel 의 timestamp = "원승인 시각(밀리초)", 원거래 조회 키
//   · 승인 때 플러그인이 저장한 값 = SDK 승인 응답의 approvedAt = ISO 문자열
// 스키마 주석은 처음부터 "밀리초" 였는데 기록하는 쪽만 ISO 였다. 아무도 안 봤다.
//
// 아래 단언들이 그 형식을 코드로 못 박는다.

test("★ ISO 문자열을 밀리초로 바꾼다 (현장에서 실패한 바로 그 값)", () => {
  const iso = "2026-08-15T11:23:45.000Z";
  const got = normalizeApprovedTimestamp(iso);
  assert.equal(got, String(Date.parse(iso)));
  assert.match(got!, /^\d{13}$/, "★ 단말기는 13자리 밀리초만 조회 키로 받는다");
});

test("이미 밀리초면 그대로 둔다 (펌웨어가 밀리초를 주는 경우)", () => {
  assert.equal(normalizeApprovedTimestamp("1756555555000"), "1756555555000");
});

test("초 단위(10자리)는 1000 을 곱한다", () => {
  assert.equal(normalizeApprovedTimestamp("1756555555"), "1756555555000");
});

test("★ 해석할 수 없으면 null — 추측한 조회 키를 보내지 않는다", () => {
  // 조회 키를 틀리게 보내는 것이 바로 이번 사고였다. 모르면 안 보내는 게 맞다.
  for (const bad of ["", "   ", "abc", "1", "12345", null, undefined, "0000-00-00"]) {
    assert.equal(normalizeApprovedTimestamp(bad as any), null, `"${bad}" 를 통과시켰다`);
  }
});

test("터무니없는 연도는 거절한다 (파싱이 엉뚱하게 된 경우)", () => {
  assert.equal(normalizeApprovedTimestamp("1970-01-05T00:00:00Z"), null);
  assert.equal(normalizeApprovedTimestamp("2999-01-01T00:00:00Z"), null);
});

test("앞뒤 공백은 무시한다", () => {
  assert.equal(normalizeApprovedTimestamp("  1756555555000  "), "1756555555000");
});

test("★ 형식이 깨진 승인시각이면 아예 못 걸게 막는다", () => {
  // 단말기까지 보내 놓고 조용히 실패하는 것이 원장에게 가장 나쁜 경험이다.
  const d = classifyCardCancel(facts({ approvedTimestamp: "이상한값" })) as any;
  assert.equal(d.kind, "reject");
  assert.equal(d.needsHuman, true, "사람이 사장님 앱에서 처리해야 하는 건이다");
  assert.match(d.reason, /사장님 앱/, "다음에 뭘 해야 하는지 알려 줘야 한다");
});

test("★ TID 가 없으면 못 건다 — 이것도 원거래 조회 키다", () => {
  const d = classifyCardCancel(facts({ tid: null })) as any;
  assert.equal(d.kind, "reject");
  assert.equal(d.needsHuman, true);
  assert.match(d.reason, /사장님 앱/);
});

test("정상 승인 건은 이 두 관문을 통과한다", () => {
  // 관문을 세게 잠갔다가 멀쩡한 건까지 막으면 기능이 죽은 것과 같다.
  const d = classifyCardCancel(facts()) as any;
  assert.equal(d.kind, "ok");
  assert.equal(d.cancelAmount, 1000);
});

test("★ ISO 로 저장된 정상 건은 막지 않는다 — 지금 현장의 값이 이것이다", () => {
  // 현장 데이터가 전부 ISO 다. 여기서 거절하면 원장은 아무것도 못 한다.
  const d = classifyCardCancel(facts({ approvedTimestamp: "2026-08-15T11:23:45.000Z" })) as any;
  assert.equal(d.kind, "ok", "★ ISO 는 변환 가능하므로 통과해야 한다");
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 7. 재배정: 죽은 단말기 ID 앞에 취소가 갇히지 않는다 ───");
//
// 2026-08-30 현장. 원장 화면엔 "취소 요청됨" 인데 단말기는 아무 반응이 없었다.
// 원인은 취소가 **원래 결제를 승인했던 단말기 ID** 앞으로 쌓이는데, 그 사이
// 플러그인 재업로드로 재페어링이 일어나 toss_front_devices 에 새 행이 생긴 것.
// 물리적으로 같은 단말기인데 ID 가 달라져서 아무도 그 취소를 집어가지 못했다.
//
// 아래 단언들이 지키는 선: **애매하면 가져오지 않는다.** 결제는 다시 하면 되지만
// 취소는 두 대가 집어가면 학부모 카드에 돈이 두 번 들어가고 되돌릴 수단이 없다.

const 폴링기기 = "dev-new";
/** 부팅한 지 충분히 오래됐다 — 시간 기반 판정을 믿어도 되는 상태. */
const 안정 = CANCEL_DEVICE_STALE_MS * 10;

function 후보(over: Partial<Parameters<typeof decideCancelReroute>[0][number]> = {}) {
  return {
    cancelId: "c1",
    targetDeviceId: "dev-old",
    targetActive: true as boolean | null,
    targetLastSeenAt: null as Date | null,
    ...over,
  };
}

test("★ 대상 단말기가 살아 있으면 남의 취소를 가져오지 않는다", () => {
  const 방금 = new Date(NOW - 2_000); // 2초 전 폴링 = 확실히 살아 있다
  const got = decideCancelReroute([후보({ targetLastSeenAt: 방금 })], 폴링기기, NOW, 안정);
  assert.equal(got, null, "★ 살아 있는 단말기의 취소를 빼앗으면 이중취소가 된다");
});

test("★ 대상 단말기가 오래 조용하면 가져온다 — 이게 현장 증상의 해결", () => {
  const 옛날 = new Date(NOW - CANCEL_DEVICE_STALE_MS - 1);
  const got = decideCancelReroute([후보({ targetLastSeenAt: 옛날 })], 폴링기기, NOW, 안정);
  assert.equal(got?.cancelId, "c1");
});

test("한 번도 접속한 적 없는 기기 행 앞의 취소는 가져온다", () => {
  const got = decideCancelReroute([후보({ targetLastSeenAt: null })], 폴링기기, NOW, 안정);
  assert.equal(got?.cancelId, "c1", "존재한 적 없는 단말기가 집어갈 리 없다");
});

test("페어링 해제된(isActive=false) 기기 앞의 취소는 가져온다", () => {
  const 방금 = new Date(NOW - 1_000);
  const got = decideCancelReroute(
    [후보({ targetActive: false, targetLastSeenAt: 방금 })],
    폴링기기,
    NOW,
    안정,
  );
  assert.equal(got?.cancelId, "c1");
});

test("경계: 딱 STALE 시간만큼 조용한 건 아직 살아 있는 것으로 본다", () => {
  const 경계 = new Date(NOW - CANCEL_DEVICE_STALE_MS);
  assert.equal(
    decideCancelReroute([후보({ targetLastSeenAt: 경계 })], 폴링기기, NOW, 안정),
    null,
    "애매하면 양보한다",
  );
});

test("★ 앞 순서가 살아 있는 단말기 것이면 뒤 건도 건드리지 않는다", () => {
  // 순서를 건너뛰며 뒤엣것만 집어가면 취소 순서가 뒤바뀐다.
  const 방금 = new Date(NOW - 1_000);
  const 옛날 = new Date(NOW - CANCEL_DEVICE_STALE_MS - 1);
  const got = decideCancelReroute(
    [
      후보({ cancelId: "c1", targetDeviceId: "dev-alive", targetLastSeenAt: 방금 }),
      후보({ cancelId: "c2", targetDeviceId: "dev-dead", targetLastSeenAt: 옛날 }),
    ],
    폴링기기,
    NOW,
    안정,
  );
  assert.equal(got, null);
});

test("내 앞으로 온 건이 있으면 그것을 그대로 준다", () => {
  const got = decideCancelReroute(
    [후보({ targetDeviceId: 폴링기기, targetLastSeenAt: null })],
    폴링기기,
    NOW,
    안정,
  );
  assert.equal(got?.cancelId, "c1");
});

test("PENDING 이 하나도 없으면 null", () => {
  assert.equal(decideCancelReroute([], 폴링기기, NOW, 안정), null);
});

// ── 재배포 직후 ──────────────────────────────────────────────────────
// lastSeenAt 은 이 서버 프로세스가 폴링을 받아야 갱신된다. Railway 는 배포마다
// 재시작하므로, 부팅 직후에는 살아 있는 단말기도 "몇 시간째 조용"해 보인다.

test("★ 부팅 직후에는 시간만 보고 남의 취소를 가져오지 않는다", () => {
  const 옛날 = new Date(NOW - 3 * 60 * 60 * 1000); // 3시간 전 = 재배포 전에 찍힌 값
  assert.equal(
    decideCancelReroute([후보({ targetLastSeenAt: 옛날 })], 폴링기기, NOW, 5_000),
    null,
    "★ 재배포 직후 살아 있는 단말기를 죽은 것으로 오인하면 안 된다",
  );
});

test("부팅 직후여도 페어링 해제된 기기 것은 가져온다", () => {
  // isActive 는 시계가 아니라 원장의 조작에 근거한다. 부팅 시각과 무관하게 믿을 수 있다.
  const got = decideCancelReroute([후보({ targetActive: false })], 폴링기기, NOW, 5_000);
  assert.equal(got?.cancelId, "c1");
});

test("부팅 대기 시간이 지나면 다시 재배정한다 — 영영 막히지 않는다", () => {
  const 옛날 = new Date(NOW - 3 * 60 * 60 * 1000);
  const got = decideCancelReroute(
    [후보({ targetLastSeenAt: 옛날 })],
    폴링기기,
    NOW,
    CANCEL_DEVICE_STALE_MS + 1,
  );
  assert.equal(got?.cancelId, "c1");
});

test("생존시각 기록 주기는 죽음 판정보다 충분히 짧다", () => {
  // touch 주기가 STALE 에 가까우면 살아 있는 단말기가 죽은 것으로 보인다.
  assert.ok(
    DEVICE_TOUCH_INTERVAL_MS * 3 <= CANCEL_DEVICE_STALE_MS,
    "★ 최소 세 번은 찍을 기회가 있어야 한 번 걸렀다고 죽었다 하지 않는다",
  );
});

test("재배정 판단 시간은 폴링 주기(1초)보다 훨씬 길다", () => {
  // 짧게 잡으면 살아 있는 단말기의 일을 빼앗는다. 그쪽이 훨씬 위험하다.
  assert.ok(CANCEL_DEVICE_STALE_MS >= 60_000, "폴링 한두 번 걸렀다고 빼앗으면 안 된다");
  assert.ok(CANCEL_DEVICE_STALE_MS < CANCEL_DISPATCH_TTL_MS, "TTL 안에 재배정 기회가 있어야 한다");
});

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
