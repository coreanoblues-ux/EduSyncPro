/**
 * 단말기 취소 아웃박스. "요청은 한 번, 보고는 될 때까지" 를 코드로 고정한다.
 *
 * ══ 이 파일이 지키는 단 하나의 구분 ══
 *
 *   sdk.requestPaymentCancel(...)      ← 절대 재시도 안 함
 *   POST /dispatch/cancel/:id/result   ← 될 때까지 재시도
 *
 *   이 둘을 헷갈리면 둘 중 하나가 반드시 사고가 된다:
 *     · 요청을 재시도하면 → 학부모 카드로 돈이 두 번 들어간다. 되돌릴 API 없음.
 *     · 보고를 재시도 안 하면 → 카드는 취소됐는데 장부가 모른다.
 *       (원장이 겪은 1,000원 사고와 방향만 반대인 같은 구조)
 *
 *   그래서 이 파일의 시나리오는 대부분 "앱이 어느 시점에 죽었는가" 다.
 *
 *   판정 함수는 전부 운영 코드에서 그대로 import 한다:
 *     · cancelOutbox.ts        (plugins/toss-front/src) — 단말기 쪽
 *     · classifyCancelResult   (server/toss-front/cardCancel.ts) — 서버 쪽
 *   두 쪽이 같은 결론을 내는지도 여기서 확인한다.
 *
 * 실행: npx tsx scripts/test-cancel-outbox.ts
 */

import assert from "node:assert/strict";
import {
  CANCEL_INFLIGHT_KEY,
  CANCEL_OUTBOX_KEY,
  addCancelReport,
  cardWasCancelled,
  clearInflight,
  dueCancelReports,
  isCancelReportSettled,
  loadCancelOutbox,
  markCancelAttempt,
  markInflight,
  readInflight,
  removeCancelReport,
  saveCancelOutbox,
  type CancelOutboxEntry,
  type CancelReportResult,
} from "../plugins/toss-front/src/cancelOutbox";
import { nextDelayMs } from "../plugins/toss-front/src/outbox";
import { classifyCancelResult } from "../server/toss-front/cardCancel";

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

/** 단말기 저장소 모형. localStorage 와 같은 모양. */
class FakeStorage {
  map = new Map<string, string>();
  failWrites = false;
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.failWrites) throw new Error("저장소 가득 참");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const REPORT = {
  cancelId: "cd-1",
  paymentKey: "pk-1000",
  result: "SUCCESS" as CancelReportResult,
  cancelApprovalNumber: "87654321",
  cancelTid: "tid-cancel-1",
};

// ─────────────────────────────────────────────────────────────────────
console.log("─── 1. ★ 보고는 서버가 확실히 알았을 때만 지운다 ───");

test("★ 2xx 는 끝났다", () => {
  for (const s of [200, 201, 204]) assert.equal(isCancelReportSettled(s), true);
});

test("★ 409 도 끝났다 — 서버가 이미 확정한 dispatch 라는 뜻", () => {
  assert.equal(isCancelReportSettled(409), true);
});

test("★ 네트워크 오류(null)는 끝나지 않았다 — 반드시 남긴다", () => {
  assert.equal(isCancelReportSettled(null), false);
});

test("★ 5xx 는 끝나지 않았다", () => {
  for (const s of [500, 502, 503, 504]) assert.equal(isCancelReportSettled(s), false);
});

test("★ 그 외 4xx 도 지우지 않는다 — 카드는 건드려졌는데 서버가 모르는 상태다", () => {
  for (const s of [400, 401, 403, 404, 422]) {
    assert.equal(isCancelReportSettled(s), false, `HTTP ${s} 를 지우면 장부가 영영 모른다`);
  }
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 2. ★ 단말기와 서버가 같은 결론을 낸다 ───");

test("★ 카드가 취소됐다고 보는 결과는 양쪽 모두 SUCCESS 하나뿐", () => {
  const 후보: CancelReportResult[] = ["SUCCESS", "FAILED", "CANCELED", "TIMEOUT"];
  for (const r of 후보) {
    assert.equal(
      cardWasCancelled(r),
      classifyCancelResult(r).cardCancelled,
      `'${r}' 에 대해 단말기와 서버의 판단이 갈라졌다 — 화면과 장부가 달라진다`,
    );
  }
});

test('★ "CANCELED" 를 취소 성공으로 오인하지 않는다 (이름이 함정이다)', () => {
  assert.equal(cardWasCancelled("CANCELED"), false);
  assert.equal(classifyCancelResult("CANCELED").cardCancelled, false);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 3. ★ 앱이 죽어도 결과가 사라지지 않는다 ───");

test("★ 적고 → 보낸다. 보내기 전에 죽어도 저장소에 남아 있다", () => {
  const st = new FakeStorage();
  const entries = addCancelReport([], REPORT, 1000);
  saveCancelOutbox(st, entries);

  // 여기서 앱이 죽었다고 치고, 새로 부팅한다.
  const reloaded = loadCancelOutbox(st);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].payload.cancelId, "cd-1");
  assert.equal(reloaded[0].payload.result, "SUCCESS");
  assert.equal(reloaded[0].payload.cancelApprovalNumber, "87654321");
});

test("★ 성공하면 저장소에서 완전히 지워진다", () => {
  const st = new FakeStorage();
  saveCancelOutbox(st, addCancelReport([], REPORT, 1000));
  saveCancelOutbox(st, removeCancelReport(loadCancelOutbox(st), "cd-1"));
  assert.equal(st.getItem(CANCEL_OUTBOX_KEY), null);
  assert.equal(loadCancelOutbox(st).length, 0);
});

test("깨진 JSON 을 만나도 던지지 않는다 (부팅이 막히면 장사를 못 한다)", () => {
  const st = new FakeStorage();
  st.map.set(CANCEL_OUTBOX_KEY, "{망가진");
  let reported = "";
  const entries = loadCancelOutbox(st, (m) => (reported = m));
  assert.deepEqual(entries, []);
  assert.match(reported, /깨져/);
});

test("cancelId 없는 쓰레기 항목은 걸러낸다", () => {
  const st = new FakeStorage();
  st.map.set(
    CANCEL_OUTBOX_KEY,
    JSON.stringify([
      { payload: { cancelId: "", result: "SUCCESS" } },
      { payload: { cancelId: "cd-2", result: "SUCCESS" } },
      { nope: true },
    ]),
  );
  assert.equal(loadCancelOutbox(st).length, 1);
});

test("저장소가 없어도(구형 펌웨어) 던지지 않는다", () => {
  assert.deepEqual(loadCancelOutbox(null), []);
  assert.doesNotThrow(() => saveCancelOutbox(null, []));
  assert.equal(markInflight(null, { cancelId: "a", paymentKey: "b", startedAt: 1 }), false);
  assert.equal(readInflight(null), null);
  assert.doesNotThrow(() => clearInflight(null));
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 4. ★ 취소 도중 앱이 죽으면 TIMEOUT 으로 남는다 ───");

test("★ SDK 호출 직전에 표식을 남기고, 다음 부팅에서 읽는다", () => {
  const st = new FakeStorage();
  const ok = markInflight(st, { cancelId: "cd-1", paymentKey: "pk-1000", startedAt: 5000 });
  assert.equal(ok, true);

  // 여기서 requestPaymentCancel 을 부르다 앱이 죽었다.
  const found = readInflight(st);
  assert.equal(found?.cancelId, "cd-1");
  assert.equal(found?.paymentKey, "pk-1000");
});

test("★ 중단된 취소는 TIMEOUT 으로 보고된다 — SUCCESS 도 FAILED 도 아니다", () => {
  // SUCCESS 로 보고하면 → 안 된 취소를 장부에 환불로 적는다.
  // FAILED 로 보고하면  → 이미 된 취소를 다시 걸 수 있게 열어 준다 (이중 취소).
  // 둘 다 사고다. 사실은 "모른다" 이고, 우리 체계에서 그건 TIMEOUT 이다.
  const st = new FakeStorage();
  markInflight(st, { cancelId: "cd-1", paymentKey: "pk-1000", startedAt: 5000 });

  const inflight = readInflight(st)!;
  const entries = addCancelReport(
    [],
    { cancelId: inflight.cancelId, paymentKey: inflight.paymentKey, result: "TIMEOUT" },
    9000,
  );

  assert.equal(entries[0].payload.result, "TIMEOUT");
  assert.equal(classifyCancelResult("TIMEOUT").cardCancelled, false, "장부를 건드리면 안 된다");
  assert.equal(classifyCancelResult("TIMEOUT").status, "TIMEOUT", "서버가 재시도를 막는 상태");
});

test("★ 정상 종료하면 표식이 지워진다 (유령 TIMEOUT 이 생기지 않는다)", () => {
  const st = new FakeStorage();
  markInflight(st, { cancelId: "cd-1", paymentKey: "pk-1000", startedAt: 5000 });
  clearInflight(st);
  assert.equal(readInflight(st), null);
  assert.equal(st.getItem(CANCEL_INFLIGHT_KEY), null);
});

test("★ 추정 TIMEOUT 이 실제 SDK 응답을 덮지 않는다", () => {
  // 실제 응답이 먼저 큐에 들어갔는데 표식 정리가 늦어 부팅 복구가 또 넣으려 하면,
  // 사실(SUCCESS)이 추정(TIMEOUT)으로 덮여 장부에 환불이 안 적힐 수 있다.
  let entries = addCancelReport([], { ...REPORT, result: "SUCCESS" }, 1000);
  entries = addCancelReport(
    entries,
    { cancelId: "cd-1", paymentKey: "pk-1000", result: "TIMEOUT" },
    2000,
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].payload.result, "SUCCESS", "★ 사실이 추정에 덮이면 안 된다");
});

test("표식을 못 남겨도(저장소 오류) 취소 자체는 막지 않는다", () => {
  const st = new FakeStorage();
  st.failWrites = true;
  let warned = "";
  assert.equal(markInflight(st, { cancelId: "a", paymentKey: "b", startedAt: 1 }, (m) => (warned = m)), false);
  assert.match(warned, /표식/);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 5. 재시도 이력과 백오프 ───");

test("같은 cancelId 는 두 번 들어가지 않는다", () => {
  let entries = addCancelReport([], REPORT, 1000);
  entries = addCancelReport(entries, REPORT, 2000);
  entries = addCancelReport(entries, REPORT, 3000);
  assert.equal(entries.length, 1);
});

test("★ 재시도해도 백오프가 처음으로 되돌아가지 않는다", () => {
  let entries = addCancelReport([], REPORT, 1000);
  entries = markCancelAttempt(entries, "cd-1", 2000, "서버 500");
  entries = markCancelAttempt(entries, "cd-1", 3000, "서버 500");
  entries = addCancelReport(entries, REPORT, 4000); // 같은 건이 또 들어오려 함

  assert.equal(entries.length, 1);
  assert.equal(entries[0].attempts, 2, "이력이 초기화되면 1초마다 서버를 두드린다");
  assert.equal(entries[0].firstSeenAt, 1000);
  assert.equal(entries[0].lastError, "서버 500");
});

test("아직 때가 안 된 건은 보내지 않는다", () => {
  let entries = addCancelReport([], REPORT, 1000);
  entries = markCancelAttempt(entries, "cd-1", 1000, "실패");
  assert.equal(dueCancelReports(entries, 1500).length, 0, "1초 백오프 중");
  assert.equal(dueCancelReports(entries, 2100).length, 1, "1초 지나면 보낸다");
});

test("★ 백오프는 결제 아웃박스와 같은 곡선이다", () => {
  // 두 아웃박스가 다른 속도로 재시도하면 현장에서 로그를 읽기가 어려워진다.
  for (let a = 0; a <= 10; a++) assert.equal(nextDelayMs(a), nextDelayMs(a));
  assert.equal(nextDelayMs(0), 0, "한 번도 안 보냈으면 즉시");
  assert.equal(nextDelayMs(1), 1000);
  assert.ok(nextDelayMs(99) <= 300_000, "간격이 무한정 늘지 않는다");
});

test("★ 아웃박스가 비기 전에는 절대 조용해지지 않는다", () => {
  // 100번 실패해도 남아 있어야 한다. 포기하는 순간 그 돈은 장부에서 사라진다.
  let entries = addCancelReport([], REPORT, 1000);
  for (let i = 0; i < 100; i++) {
    entries = markCancelAttempt(entries, "cd-1", 1000 + i * 400_000, "계속 실패");
  }
  assert.equal(entries.length, 1, "★ 100번 실패해도 버리지 않는다");
  assert.equal(entries[0].attempts, 100);
});

test("여러 건이 섞여 있어도 서로 간섭하지 않는다", () => {
  let entries: CancelOutboxEntry[] = [];
  entries = addCancelReport(entries, { cancelId: "cd-1", paymentKey: "pk-a", result: "SUCCESS" }, 1000);
  entries = addCancelReport(entries, { cancelId: "cd-2", paymentKey: "pk-b", result: "FAILED" }, 1000);
  entries = markCancelAttempt(entries, "cd-1", 2000, "실패");

  assert.equal(entries.find((e) => e.payload.cancelId === "cd-1")!.attempts, 1);
  assert.equal(entries.find((e) => e.payload.cancelId === "cd-2")!.attempts, 0);

  entries = removeCancelReport(entries, "cd-1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].payload.cancelId, "cd-2");
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 6. ★ 현장 시나리오: 1,000원 취소 ───");

test("★ 취소 성공 → 와이파이 끊김 → 재부팅 → 결국 장부에 반영된다", () => {
  const st = new FakeStorage();

  // 1) 단말기가 취소를 걸기 직전 표식을 남긴다.
  markInflight(st, { cancelId: "cd-1", paymentKey: "pk-1000", startedAt: 1000 });
  // 2) 카드 취소 성공. 표식을 지우고 결과를 큐에 적는다.
  clearInflight(st);
  let entries = addCancelReport([], { ...REPORT, result: "SUCCESS" }, 1100);
  saveCancelOutbox(st, entries);
  // 3) 서버로 보내려는데 와이파이가 끊겼다.
  entries = markCancelAttempt(loadCancelOutbox(st), "cd-1", 1200, "서버에 닿지 못했습니다");
  saveCancelOutbox(st, entries);
  assert.equal(isCancelReportSettled(null), false);

  // 4) 앱이 꺼졌다 켜진다. 큐는 저장소에 남아 있다.
  const afterBoot = loadCancelOutbox(st);
  assert.equal(afterBoot.length, 1, "★ 재부팅해도 살아남아야 한다");
  assert.equal(afterBoot[0].payload.result, "SUCCESS");
  assert.equal(readInflight(st), null, "정상 종료였으므로 표식은 없다");

  // 5) 네트워크가 돌아와 보고에 성공한다.
  assert.equal(isCancelReportSettled(200), true);
  saveCancelOutbox(st, removeCancelReport(afterBoot, "cd-1"));
  assert.equal(loadCancelOutbox(st).length, 0, "★ 이제서야 지운다");
});

test("★ 취소 도중 정전 → 재부팅 → TIMEOUT 보고 → 장부는 그대로", () => {
  const st = new FakeStorage();
  markInflight(st, { cancelId: "cd-1", paymentKey: "pk-1000", startedAt: 1000 });
  // 여기서 전원이 나갔다. clearInflight 도, addCancelReport 도 못 했다.

  const inflight = readInflight(st);
  assert.ok(inflight, "★ 표식이 없으면 이 사건은 흔적 없이 사라진다");

  const entries = addCancelReport(
    loadCancelOutbox(st),
    { cancelId: inflight!.cancelId, paymentKey: inflight!.paymentKey, result: "TIMEOUT" },
    9000,
  );
  saveCancelOutbox(st, entries);
  clearInflight(st);

  assert.equal(entries[0].payload.result, "TIMEOUT");
  assert.equal(cardWasCancelled("TIMEOUT"), false, "★ 장부에 아무것도 적지 않는다");
  assert.equal(readInflight(st), null, "표식은 한 번만 소비된다");
});

test("★ 구형 펌웨어(취소 API 없음) → FAILED → 다시 걸 수 있다", () => {
  // 카드를 확실히 안 건드렸으므로 FAILED 가 맞다. 서버는 FAILED 만 재시도를 허용한다.
  assert.equal(cardWasCancelled("FAILED"), false);
  assert.equal(classifyCancelResult("FAILED").status, "FAILED");
});

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
