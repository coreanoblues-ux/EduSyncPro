/**
 * 카드 승인 → 수납 장부 반영. 원장이 지정한 8가지 상황을 코드로 고정한다.
 *
 * ══ 이 테스트의 성격 ══
 *
 *   여기서 확인하는 것은 "화면에 뭐라고 뜨는가" 가 아니라 **장부의 숫자** 다.
 *   원장이 못 박아 말한 그대로다: "payment intent의 UI 상태만 수정해서 해결된
 *   것처럼 만들지 마라." 그래서 이 파일에는 intent 상태 표시에 관한 단언이
 *   하나도 없다. 전부 "그 학생 그 달에 얼마가 적혔고 얼마가 남았는가" 다.
 *
 *   판정 함수는 전부 **운영 코드에서 그대로 import** 한다:
 *     · classifyConfirm      (server/toss-front/lifecycle.ts)  — 승인 접수 판단
 *     · classifyReconcile    (server/toss-front/reconcile.ts)  — 수기 대사 판단
 *     · webhookCancelAmount  (server/toss-front/refund.ts)     — 취소 금액 계산
 *     · computeMonthStatus 외 (shared/paymentStatus.ts)        — 수납 화면 계산
 *     · isSettled 외         (plugins/toss-front/src/outbox.ts)— 단말기 재시도 판단
 *
 *   장부(payments 테이블)만 이 파일 안의 작은 모형이다. 모형은 DB 제약을 그대로
 *   흉내 낸다 — 특히 scripts/migrate-add-payment-idempotency.ts 가 만드는
 *   "external_payment_key 당 수입(amount>0) 행은 하나" 라는 부분 유니크 인덱스.
 *   즉 아래 "중복 없음" 단언들은 코드의 선의가 아니라 DB 제약에 기대고 있다.
 *
 * 실행: npx tsx scripts/test-ledger-reflection.ts
 */

import assert from "node:assert/strict";
import { classifyConfirm } from "../server/toss-front/lifecycle";
import { classifyReconcile } from "../server/toss-front/reconcile";
import { webhookCancelAmount } from "../server/toss-front/refund";
import {
  computeMonthStatus,
  isOutstanding,
  totalOutstanding,
  withPrepaidMonths,
  PARTIAL_PAYMENT_SINCE,
} from "../shared/paymentStatus";
import { isSettled } from "../plugins/toss-front/src/outbox";

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
// 장부 모형
// ─────────────────────────────────────────────────────────────────────

interface LedgerRow {
  externalPaymentKey: string;
  paymentMonth: string;   // YYYY-MM
  amount: number;         // 수입 양수, 환불 음수
  source: "confirm" | "webhook" | "manual";
}

class DuplicateIncomeError extends Error {
  constructor(key: string) {
    super(`payments_external_payment_key_income_uniq 위반: ${key}`);
  }
}

/**
 * payments 테이블 모형.
 *
 * 지키는 제약은 마이그레이션이 거는 것과 같다:
 *   CREATE UNIQUE INDEX … ON payments (external_payment_key)
 *    WHERE external_payment_key IS NOT NULL AND amount > 0
 *
 * 그래서 환불(음수)은 같은 키로 몇 번이든 들어가고, 수입은 결제키당 한 줄뿐이다.
 */
class Ledger {
  rows: LedgerRow[] = [];

  insert(row: LedgerRow) {
    if (row.amount > 0 && this.rows.some((r) => r.externalPaymentKey === row.externalPaymentKey && r.amount > 0)) {
      throw new DuplicateIncomeError(row.externalPaymentKey);
    }
    this.rows.push(row);
  }

  /** 이 결제키로 수입 행이 이미 있는가 (= 서버의 hasPositiveLedgerRow). */
  hasIncome(key: string): boolean {
    return this.rows.some((r) => r.externalPaymentKey === key && r.amount > 0);
  }

  paidIn(key: string): number {
    return this.rows.filter((r) => r.externalPaymentKey === key && r.amount > 0).reduce((s, r) => s + r.amount, 0);
  }

  refunded(key: string): number {
    return -this.rows.filter((r) => r.externalPaymentKey === key && r.amount < 0).reduce((s, r) => s + r.amount, 0);
  }

  /** 달별 순액. 환불이 상계된다. 수납 화면의 netByMonth 와 같은 계산. */
  netByMonth(): Map<string, number> {
    const m = new Map<string, number>();
    for (const r of this.rows) m.set(r.paymentMonth, (m.get(r.paymentMonth) ?? 0) + r.amount);
    return m;
  }
}

/**
 * 서버 /payments/confirm 한 번. payments.ts 149-349 의 판단 순서를 그대로 따른다.
 * 반환값은 단말기가 받는 것과 같은 { status, body } 다.
 */
function serverConfirm(
  ledger: Ledger,
  intent: { status: string; amount: number; paymentMonth: string; expiresAt: string },
  req: { paymentKey: string; amount: number },
  now: Date,
): { status: number; body: string } {
  // 1) 이미 APPROVED 면 조기 반환 (재전송 대비).
  if (intent.status === "APPROVED") {
    return { status: 409, body: '{"error":"이미 승인된 결제입니다."}' };
  }

  const decision = classifyConfirm({ intentStatus: intent.status, expiresAt: intent.expiresAt, now });
  if (decision.kind === "reject") return { status: 409, body: `{"error":"${decision.reason}"}` };
  if (decision.kind === "idempotent") return { status: 409, body: '{"error":"이미 승인된 결제입니다."}' };

  // 2) 금액 대조. 단말기가 보낸 값이 서버가 확정한 값과 다르면 받지 않는다.
  if (req.amount !== intent.amount) {
    return { status: 400, body: '{"error":"결제 금액이 일치하지 않습니다."}' };
  }

  // 3) 같은 트랜잭션에서 승인기록 + 장부를 함께 넣는다. 웹훅을 기다리지 않는다.
  try {
    ledger.insert({
      externalPaymentKey: req.paymentKey,
      paymentMonth: intent.paymentMonth,
      amount: intent.amount,
      source: "confirm",
    });
  } catch (e) {
    if (e instanceof DuplicateIncomeError) return { status: 409, body: '{"error":"중복된 승인 요청입니다."}' };
    throw e;
  }
  intent.status = "APPROVED";
  return { status: 200, body: '{"idempotent":false}' };
}

/** 승인 웹훅 한 번. webhooks.ts 219-283 그대로. */
function webhookApproved(
  ledger: Ledger,
  intent: { status: string; amount: number; paymentMonth: string },
  paymentKey: string,
) {
  // intent 가 이미 APPROVED 면 아무것도 하지 않는다 (confirm 이 먼저 도착한 경우).
  if (intent.status === "APPROVED") return;

  // toss_payment_transactions.payment_key UNIQUE + onConflictDoNothing.
  // 행이 안 생기면 payments 삽입도 건너뛴다.
  if (!ledger.hasIncome(paymentKey)) {
    ledger.insert({
      externalPaymentKey: paymentKey,
      paymentMonth: intent.paymentMonth,
      amount: intent.amount,
      source: "webhook",
    });
  }
  intent.status = "APPROVED";
}

/** 취소 웹훅 한 번. webhooks.ts 285-330 그대로. */
function webhookCancelled(
  ledger: Ledger,
  intent: { status: string; paymentMonth: string },
  paymentKey: string,
) {
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

/** 수납 화면 한 달치. tuition 은 실제 청구 데이터에서 온 값이라고 본다. */
function 수납(ledger: Ledger, month: string, tuition: number) {
  return computeMonthStatus(month, tuition, ledger.netByMonth().get(month) ?? 0, PARTIAL_PAYMENT_SINCE);
}

const NOW = new Date("2026-08-30T12:00:00Z");
const ALIVE = "2026-08-30T12:03:00Z";  // 아직 만료 전
const DEAD = "2026-08-30T11:50:00Z";   // 이미 만료

/** 정재현 학생의 2026-09 청구. 금액은 하드코딩이 아니라 이 변수 하나로만 흐른다. */
const 청구월 = "2026-09";

function intentFor(amount: number, status = "PROCESSING", expiresAt = ALIVE) {
  return { status, amount, paymentMonth: 청구월, expiresAt };
}

// ─────────────────────────────────────────────────────────────────────
console.log("─── 1. 15,000원 청구에 카드 1,000원 승인 → 즉시 부분납부 ───");

test("★ 승인 즉시 수납에 1,000원 · 잔액 14,000원 · 부분납 (웹훅을 기다리지 않는다)", () => {
  const 수강료 = 15_000;
  const ledger = new Ledger();
  const intent = intentFor(1000);

  const res = serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);
  assert.equal(res.status, 200);

  const m = 수납(ledger, 청구월, 수강료);
  assert.equal(m.paid, 1000, "이번 카드납부 1,000원");
  assert.equal(m.remaining, 14_000, "남은금액 = 청구액 - 누적납부");
  assert.equal(m.status, "부분납");
});

test("★ 수강료 금액은 청구 데이터에서 온다 — 다른 금액이어도 같은 규칙", () => {
  // 원장 지시: "수강료 금액은 예시이므로 하드코딩하지 말고 현재 invoice/청구
  // 데이터의 실제 금액을 기준으로 계산해라."
  for (const 수강료 of [15_000, 270_000, 330_000]) {
    const ledger = new Ledger();
    serverConfirm(ledger, intentFor(1000), { paymentKey: "pk", amount: 1000 }, NOW);
    const m = 수납(ledger, 청구월, 수강료);
    assert.equal(m.paid, 1000);
    assert.equal(m.remaining, 수강료 - 1000, `청구 ${수강료}원일 때 잔액이 틀렸다`);
    assert.equal(m.status, "부분납");
  }
});

test("장부 반영은 intent 상태 표시와 무관하다 — 확인하는 것은 payments 행뿐", () => {
  const ledger = new Ledger();
  serverConfirm(ledger, intentFor(1000), { paymentKey: "pk-1", amount: 1000 }, NOW);
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].amount, 1000);
  assert.equal(ledger.rows[0].paymentMonth, 청구월);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 2. 이어서 14,000원 추가 승인 → 누적 15,000 / 잔액 0 / 납부완료 ───");

test("★ 누적 15,000원 · 잔액 0원 · 완납", () => {
  const 수강료 = 15_000;
  const ledger = new Ledger();
  serverConfirm(ledger, intentFor(1000), { paymentKey: "pk-1", amount: 1000 }, NOW);
  serverConfirm(ledger, intentFor(14_000), { paymentKey: "pk-2", amount: 14_000 }, NOW);

  const m = 수납(ledger, 청구월, 수강료);
  assert.equal(m.paid, 15_000);
  assert.equal(m.remaining, 0);
  assert.equal(m.status, "완납");
  assert.equal(isOutstanding(m), false, "완납이면 미납 목록에서 빠져야 한다");
});

test("두 승인은 서로 다른 paymentKey 라 각각 한 줄로 남는다 (합쳐지지 않는다)", () => {
  const ledger = new Ledger();
  serverConfirm(ledger, intentFor(1000), { paymentKey: "pk-1", amount: 1000 }, NOW);
  serverConfirm(ledger, intentFor(14_000), { paymentKey: "pk-2", amount: 14_000 }, NOW);
  assert.equal(ledger.rows.length, 2);
  assert.deepEqual(ledger.rows.map((r) => r.amount), [1000, 14_000]);
});

test("초과 납부해도 잔액이 음수로 흐르지 않는다", () => {
  const ledger = new Ledger();
  serverConfirm(ledger, intentFor(20_000), { paymentKey: "pk-1", amount: 20_000 }, NOW);
  const m = 수납(ledger, 청구월, 15_000);
  assert.equal(m.remaining, 0);
  assert.equal(m.status, "완납");
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 3. 승인 callback 뒤 웹훅이 또 도착 → 중복 수납 없음 ───");

test("★ confirm 으로 이미 들어간 뒤 승인 웹훅이 와도 장부는 한 줄", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000);
  serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);

  webhookApproved(ledger, intent, "pk-1");

  assert.equal(ledger.rows.length, 1, "웹훅이 두 번째 줄을 만들면 안 된다");
  assert.equal(수납(ledger, 청구월, 15_000).paid, 1000);
});

test("웹훅이 여러 번 재전송돼도 마찬가지 (토스는 재전송한다)", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000);
  serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);
  for (let i = 0; i < 5; i++) webhookApproved(ledger, intent, "pk-1");
  assert.equal(ledger.rows.length, 1);
});

test("★ 설령 intent 상태가 APPROVED 가 아니어도 DB 제약이 두 번째 수입 행을 막는다", () => {
  // 상태 플래그는 경합에서 틀릴 수 있다. 마지막 방어선은 부분 유니크 인덱스다.
  const ledger = new Ledger();
  ledger.insert({ externalPaymentKey: "pk-1", paymentMonth: 청구월, amount: 1000, source: "confirm" });
  assert.throws(
    () => ledger.insert({ externalPaymentKey: "pk-1", paymentMonth: 청구월, amount: 1000, source: "webhook" }),
    DuplicateIncomeError,
  );
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 4. 웹훅이 늦게 도착 → 이미 반영된 거래는 상태만 정리 ───");

test("★ 늦은 웹훅은 장부를 건드리지 않고 intent 만 마감한다", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000);
  serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);
  const before = JSON.stringify(ledger.rows);

  webhookApproved(ledger, intent, "pk-1");

  assert.equal(JSON.stringify(ledger.rows), before, "장부가 한 글자도 변하면 안 된다");
  assert.equal(intent.status, "APPROVED");
});

test("★ confirm 이 영영 안 온 경우에만 웹훅이 장부를 만든다 (교정 장치로서의 웹훅)", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000, "TIMEOUT");
  webhookApproved(ledger, intent, "pk-1");

  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0].source, "webhook");
  assert.equal(수납(ledger, 청구월, 15_000).paid, 1000);
});

test("웹훅이 먼저 장부를 만든 뒤 지각 confirm 이 와도 두 줄이 되지 않는다", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000, "TIMEOUT");
  webhookApproved(ledger, intent, "pk-1");                       // 웹훅이 먼저
  const res = serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);

  assert.equal(res.status, 409);
  assert.equal(ledger.rows.length, 1);
  assert.equal(isSettled(res.status, res.body), true, "단말기는 이걸 '끝난 건'으로 보고 아웃박스에서 지운다");
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 5. intent 가 PROCESSING 으로 오래 남아도 수납에는 정상 반영 ───");

test("★ PROCESSING 인 채로 만료된 뒤 도착한 지각 confirm 도 장부에 들어간다", () => {
  // 원장이 겪은 그 장면이다. 카드는 승인됐는데 intent 는 PROCESSING → TIMEOUT.
  // 그래도 수납에는 들어가야 한다. classifyConfirm 이 이걸 받아 준다.
  const ledger = new Ledger();
  const intent = intentFor(1000, "PROCESSING", DEAD);   // 이미 만료

  const d = classifyConfirm({ intentStatus: "PROCESSING", expiresAt: DEAD, now: NOW });
  assert.equal(d.kind, "accept", "만료됐다고 거절하면 돈이 장부에서 사라진다");
  assert.equal((d as any).lateRecovery, true, "지각 승인으로 기록돼야 한다");

  const res = serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);
  assert.equal(res.status, 200);
  assert.equal(수납(ledger, 청구월, 15_000).paid, 1000, "★ 여기가 이번 수정의 핵심");
  assert.equal(수납(ledger, 청구월, 15_000).status, "부분납");
});

test("★ TIMEOUT 으로 넘어간 뒤에 도착해도 받아 준다", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000, "TIMEOUT", DEAD);
  assert.equal(serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW).status, 200);
  assert.equal(수납(ledger, 청구월, 15_000).paid, 1000);
});

test("★ 단말기는 서버가 확실히 받을 때까지 포기하지 않는다 (아웃박스)", () => {
  // 이 케이스가 예전에 깨진 진짜 이유는 서버가 아니라 단말기였다.
  // 전송이 실패해도 승인 기록은 단말기에 남고, 성공할 때까지 다시 보낸다.
  assert.equal(isSettled(null), false, "네트워크 오류 → 남긴다");
  assert.equal(isSettled(500), false, "서버 장애 → 남긴다");
  assert.equal(isSettled(200), true, "성공 → 지운다");
});

test("아직 살아 있는 PROCESSING 건을 사람이 수기 대사하려 하면 막는다 (곧 confirm 이 온다)", () => {
  const d = classifyReconcile({ intentStatus: "PROCESSING", alreadyLedgered: false });
  assert.equal(d.kind, "reject");
});

test("★ 이미 장부에 있으면 수기 대사는 아무것도 하지 않는다 (원장이 두 번 눌러도 안전)", () => {
  const d = classifyReconcile({ intentStatus: "TIMEOUT", alreadyLedgered: true });
  assert.equal(d.kind, "noop");
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 6. 카드 결제 취소 → 수납금액과 잔액 정상 복구 ───");

test("★ 1,000원 승인 뒤 취소되면 그 달 순액이 0, 다시 미납", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000);
  serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);
  assert.equal(수납(ledger, 청구월, 15_000).paid, 1000);

  webhookCancelled(ledger, intent, "pk-1");

  const m = 수납(ledger, 청구월, 15_000);
  assert.equal(m.paid, 0, "환불 음수 행이 상계돼야 한다");
  assert.equal(m.remaining, 15_000);
  assert.equal(m.status, "미납");
});

test("★ 취소 웹훅이 두 번 와도 두 번 빠지지 않는다 (27만원이 -54만원 되던 사고)", () => {
  const ledger = new Ledger();
  const intent = intentFor(270_000);
  serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 270_000 }, NOW);
  webhookCancelled(ledger, intent, "pk-1");
  webhookCancelled(ledger, intent, "pk-1");   // 재전송

  assert.equal(수납(ledger, 청구월, 270_000).paid, 0);
  assert.equal(ledger.refunded("pk-1"), 270_000, "환불 총액이 승인액을 넘으면 안 된다");
});

test("부분결제 중 한 건만 취소되면 나머지는 그대로 남는다", () => {
  const 수강료 = 15_000;
  const ledger = new Ledger();
  const i1 = intentFor(1000);
  const i2 = intentFor(14_000);
  serverConfirm(ledger, i1, { paymentKey: "pk-1", amount: 1000 }, NOW);
  serverConfirm(ledger, i2, { paymentKey: "pk-2", amount: 14_000 }, NOW);
  assert.equal(수납(ledger, 청구월, 수강료).status, "완납");

  webhookCancelled(ledger, i2, "pk-2");       // 14,000원짜리만 취소

  const m = 수납(ledger, 청구월, 수강료);
  assert.equal(m.paid, 1000, "취소되지 않은 1,000원은 남아 있어야 한다");
  assert.equal(m.remaining, 14_000);
  assert.equal(m.status, "부분납");
});

test("★ 승인된 적 없는 건에 취소 웹훅이 와도 유령 환불이 생기지 않는다", () => {
  const ledger = new Ledger();
  webhookCancelled(ledger, intentFor(1000, "TIMEOUT"), "pk-없음");
  assert.equal(ledger.rows.length, 0);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 7. 서로 다른 카드로 부분결제 여러 번 ───");

test("★ 280,000원을 카드 세 장으로: 각각 별도 transaction, 합계 정상", () => {
  const 수강료 = 280_000;
  const ledger = new Ledger();
  const 분할 = [100_000, 100_000, 80_000];

  분할.forEach((amount, i) => {
    // 부분결제는 dispatch 가 여러 번 생기고 paymentKey 도 각각 다르다
    // (server/toss-front/payments.ts generatePaymentKey).
    const res = serverConfirm(ledger, intentFor(amount), { paymentKey: `pk-${i}`, amount }, NOW);
    assert.equal(res.status, 200, `${i + 1}번째 카드가 거절됐다`);
  });

  assert.equal(ledger.rows.length, 3, "카드 세 장이면 장부도 세 줄");
  const m = 수납(ledger, 청구월, 수강료);
  assert.equal(m.paid, 280_000);
  assert.equal(m.remaining, 0);
  assert.equal(m.status, "완납");
});

test("★ 중간까지만 결제한 상태에서도 잔액이 정확하다", () => {
  const 수강료 = 280_000;
  const ledger = new Ledger();
  serverConfirm(ledger, intentFor(100_000), { paymentKey: "pk-0", amount: 100_000 }, NOW);
  const m1 = 수납(ledger, 청구월, 수강료);
  assert.equal(m1.paid, 100_000);
  assert.equal(m1.remaining, 180_000);
  assert.equal(m1.status, "부분납");

  serverConfirm(ledger, intentFor(100_000), { paymentKey: "pk-1", amount: 100_000 }, NOW);
  const m2 = 수납(ledger, 청구월, 수강료);
  assert.equal(m2.paid, 200_000);
  assert.equal(m2.remaining, 80_000);
  assert.equal(m2.status, "부분납");
});

test("★ 부분결제는 유니크 인덱스에 걸리지 않는다 (결제키가 서로 다르므로)", () => {
  const ledger = new Ledger();
  assert.doesNotThrow(() => {
    for (let i = 0; i < 3; i++) {
      ledger.insert({ externalPaymentKey: `pk-${i}`, paymentMonth: 청구월, amount: 100_000, source: "confirm" });
    }
  });
});

test("여러 달에 걸친 납부도 달별로 따로 센다", () => {
  const ledger = new Ledger();
  ledger.insert({ externalPaymentKey: "pk-8", paymentMonth: "2026-08", amount: 15_000, source: "confirm" });
  ledger.insert({ externalPaymentKey: "pk-9", paymentMonth: "2026-09", amount: 1000, source: "confirm" });

  assert.equal(수납(ledger, "2026-08", 15_000).status, "완납");
  assert.equal(수납(ledger, "2026-09", 15_000).status, "부분납");
});

test("★ 아직 오지 않은 달을 선납해도 수납 화면에 그 달이 나타난다", () => {
  // 원장의 3번 실험: 8월에 9월 수강료 일부를 결제했는데 수납에 안 보였다.
  const ledger = new Ledger();
  ledger.insert({ externalPaymentKey: "pk-9", paymentMonth: "2026-09", amount: 1000, source: "confirm" });

  const 기본목록 = ["2026-07", "2026-08"];               // 등록일~이번 달
  const 전체 = withPrepaidMonths(기본목록, ledger.netByMonth());
  assert.ok(전체.includes("2026-09"), "선납한 달이 목록에서 빠지면 원장 눈에 안 보인다");
});

test("미납 총액은 남은 금액의 합이다 (미납 개월 × 수강료가 아니다)", () => {
  const ledger = new Ledger();
  ledger.insert({ externalPaymentKey: "pk-9", paymentMonth: "2026-09", amount: 1000, source: "confirm" });
  const months = ["2026-08", "2026-09"].map((m) => 수납(ledger, m, 15_000));
  assert.equal(totalOutstanding(months), 15_000 + 14_000);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 8. 동일 callback/webhook 재전송 → 절대 중복수납 없음 ───");

test("★ 단말기가 같은 confirm 을 두 번 보내도 장부는 한 줄", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000);

  const first = serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);
  const second = serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);

  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(ledger.rows.length, 1);
  assert.equal(수납(ledger, 청구월, 15_000).paid, 1000, "두 번 세어 2,000원이 되면 안 된다");
});

test("★ 아웃박스가 열 번 재시도해도 결과는 한 줄", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000);
  let settled = false;
  for (let i = 0; i < 10 && !settled; i++) {
    const res = serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);
    settled = isSettled(res.status, res.body);
  }
  assert.equal(settled, true);
  assert.equal(ledger.rows.length, 1);
});

test("★ confirm·웹훅·수기대사가 모두 도착해도 한 줄", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000);

  serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);   // 단말기
  webhookApproved(ledger, intent, "pk-1");                                     // 토스 웹훅
  const manual = classifyReconcile({                                           // 원장 수기
    intentStatus: intent.status,
    alreadyLedgered: ledger.hasIncome("pk-1"),
  });

  assert.equal(manual.kind, "noop", "수기 대사는 이미 있는 걸 다시 넣지 않는다");
  assert.equal(ledger.rows.length, 1);
  assert.equal(수납(ledger, 청구월, 15_000).paid, 1000);
});

test("★ 순서를 바꿔도 결과가 같다 (웹훅 → 수기 → confirm)", () => {
  const ledger = new Ledger();
  const intent = intentFor(1000, "TIMEOUT", DEAD);

  webhookApproved(ledger, intent, "pk-1");
  const manual = classifyReconcile({ intentStatus: intent.status, alreadyLedgered: ledger.hasIncome("pk-1") });
  const late = serverConfirm(ledger, intent, { paymentKey: "pk-1", amount: 1000 }, NOW);

  assert.equal(manual.kind, "noop");
  assert.equal(late.status, 409);
  assert.equal(ledger.rows.length, 1);
  assert.equal(수납(ledger, 청구월, 15_000).paid, 1000);
});

test("★ 금액이 다른 요청은 받지 않는다 — 단말기가 틀린 숫자를 밀어 넣을 수 없다", () => {
  const ledger = new Ledger();
  const res = serverConfirm(ledger, intentFor(1000), { paymentKey: "pk-1", amount: 999_999 }, NOW);
  assert.equal(res.status, 400);
  assert.equal(ledger.rows.length, 0);
  assert.equal(isSettled(res.status, res.body), false, "단말기는 이걸 지우지 않고 계속 알린다");
});

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
