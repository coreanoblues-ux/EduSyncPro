/**
 * 승인 아웃박스 회귀 테스트.
 *
 * ── 이 테스트가 지키는 것 ──
 *   원장이 카드로 1,000원을 받았는데 장부에 안 들어간 사고(2026-08-30)의 원인은
 *   단말기가 confirm 요청을 **딱 한 번** 보내고 실패하면 포기한 것이었다.
 *   승인 응답은 함수와 함께 사라져서 다시 보낼 방법도 없었다.
 *
 *   아웃박스는 그 구멍을 막는다. 그런데 아웃박스는 잘못 만들면 원래 버그보다
 *   나쁘다: 지우면 안 될 걸 지우면 돈이 조용히 사라지고, 안 지워야 할 걸 안
 *   지우면 같은 결제를 영원히 다시 보낸다. 그래서 여기서 고정하는 것은 두 가지다.
 *
 *     1. **언제 지우는가** (isSettled). 확실히 장부에 들어갔다고 말할 수 있을
 *        때만 true. 애매하면 남긴다.
 *     2. **잃지 않는가** (load/save/add/mark). 저장소가 깨져도, 앱이 꺼져도,
 *        같은 건이 두 번 들어와도 승인 기록이 살아남는가.
 *
 * 실행: npx tsx scripts/test-confirm-outbox.ts
 */

import assert from "node:assert/strict";
import {
  OUTBOX_KEY,
  OUTBOX_STALE_MS,
  addEntry,
  dueEntries,
  isSettled,
  isStale,
  loadOutbox,
  markAttempt,
  nextDelayMs,
  removeEntry,
  saveOutbox,
  type ConfirmPayload,
  type OutboxEntry,
  type OutboxStorage,
} from "../plugins/toss-front/src/outbox";

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

const NOW = 1_756_000_000_000;

function payload(over: Partial<ConfirmPayload> = {}): ConfirmPayload {
  return {
    paymentKey: "pk-1",
    orderId: "ord-1",
    amount: 1000,
    paymentMethod: "CARD",
    approvalNumber: "12345678",
    approvedTimestamp: "2026-08-30T12:00:00.000Z",
    ...over,
  };
}

/** 메모리 저장소. window.localStorage 흉내. */
function memStorage(seed?: Record<string, string>): OutboxStorage & { dump(): Record<string, string> } {
  const m: Record<string, string> = { ...(seed ?? {}) };
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => {
      m[k] = v;
    },
    removeItem: (k) => {
      delete m[k];
    },
    dump: () => ({ ...m }),
  };
}

// ─────────────────────────────────────────────────────────────────────
console.log("─── isSettled: 이 건을 아웃박스에서 지워도 되는가 ───");

test("★ 200 = 서버가 장부에 넣었다. 지운다", () => {
  assert.equal(isSettled(200), true);
});

test("201·204 도 성공으로 본다 (2xx 전체)", () => {
  assert.equal(isSettled(201), true);
  assert.equal(isSettled(204), true);
});

test("★ 409 '이미 승인된 결제' = intent 가 APPROVED. 장부에도 있다. 지운다", () => {
  assert.equal(isSettled(409, '{"error":"이미 승인된 결제입니다."}'), true);
});

test("★ 409 '중복된 승인 요청' = 유니크 제약에 걸렸다 = 이미 장부에 있다. 지운다", () => {
  assert.equal(isSettled(409, '{"error":"중복된 승인 요청입니다."}'), true);
});

test("★ 뜻을 모르는 409 는 지우지 않는다 (나중에 다른 의미의 409 가 생겨도 안전하게)", () => {
  assert.equal(isSettled(409, '{"error":"어떤 새로운 이유"}'), false);
});

test("★ 네트워크 오류(status=null)는 절대 지우지 않는다 — 서버가 받았는지조차 모른다", () => {
  assert.equal(isSettled(null), false);
});

test("★ 500 은 지우지 않는다. 서버 장애는 지나간다", () => {
  assert.equal(isSettled(500), false);
  assert.equal(isSettled(502), false);
});

test("★ 400 '금액 불일치' 는 지우지 않는다 — 돈은 나갔는데 장부에 없다는 뜻이라 사람이 봐야 한다", () => {
  assert.equal(isSettled(400, '{"error":"결제 금액이 일치하지 않습니다."}'), false);
});

test("401·404 도 지우지 않는다 (세션 만료·경로 오류는 고쳐질 수 있다)", () => {
  assert.equal(isSettled(401), false);
  assert.equal(isSettled(404), false);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 백오프: 앞은 촘촘하게, 뒤는 느슨하게 ───");

test("아직 한 번도 안 보냈으면 지연 없음 — 승인 직후 곧바로 나간다", () => {
  assert.equal(nextDelayMs(0), 0);
});

test("첫 실패 뒤 1초 (학생이 아직 단말기 앞에 서 있을 때 들어가는 게 최선)", () => {
  assert.equal(nextDelayMs(1), 1000);
});

test("실패가 쌓이면 5분에서 멈춘다 (서버가 죽어 있을 때 로그·배터리를 축내지 않는다)", () => {
  assert.equal(nextDelayMs(7), 300_000);
  assert.equal(nextDelayMs(999), 300_000);
});

test("★ 5분 간격은 상한이지 포기가 아니다 — 백오프가 무한대로 가지 않는다", () => {
  // 이게 무너지면 "재시도한다"는 말이 거짓이 된다. 몇 시간 뒤 서버가 살아나도
  // 다음 시도가 며칠 뒤면 원장은 그냥 못 받은 것이다.
  assert.ok(nextDelayMs(50) <= 300_000);
});

test("due 판정: 마지막 시도로부터 백오프만큼 지난 건만 고른다", () => {
  const e: OutboxEntry = {
    payload: payload(),
    firstSeenAt: NOW,
    attempts: 1,
    lastAttemptAt: NOW,
  };
  assert.equal(dueEntries([e], NOW + 999).length, 0, "1초 전이면 아직");
  assert.equal(dueEntries([e], NOW + 1000).length, 1, "1초 지나면 보낸다");
});

test("★ 갓 들어온 건(attempts=0)은 언제나 due — 승인 직후 지연이 0이어야 한다", () => {
  const e: OutboxEntry = { payload: payload(), firstSeenAt: NOW, attempts: 0, lastAttemptAt: 0 };
  assert.equal(dueEntries([e], NOW).length, 1);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 오래된 건: 시끄럽게는 하되 버리지는 않는다 ───");

test("14일 = 단말기 getPayment 캐시 수명과 같다 (그 안에는 자동 대사로 되살릴 수 있다)", () => {
  assert.equal(OUTBOX_STALE_MS, 14 * 24 * 60 * 60 * 1000);
});

test("13일째는 아직 stale 아님", () => {
  const e: OutboxEntry = { payload: payload(), firstSeenAt: NOW, attempts: 5, lastAttemptAt: NOW };
  assert.equal(isStale(e, NOW + 13 * 24 * 3600_000), false);
});

test("★ 14일 넘으면 stale — 로그 수위를 올린다. 그래도 데이터는 남는다", () => {
  const e: OutboxEntry = { payload: payload(), firstSeenAt: NOW, attempts: 5, lastAttemptAt: NOW };
  assert.equal(isStale(e, NOW + OUTBOX_STALE_MS), true);
  // stale 이라고 목록에서 빠지지 않는다는 것이 핵심이다.
  assert.equal(removeEntry([e], "pk-other").length, 1);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 목록 조작: 승인 기록을 잃지 않는가 ───");

test("★ 같은 paymentKey 를 다시 넣어도 덮어쓰지 않는다 (백오프가 처음으로 되돌아가면 안 된다)", () => {
  const first = addEntry([], payload(), NOW);
  const marked = markAttempt(first, "pk-1", NOW + 5000, "네트워크 오류");
  const again = addEntry(marked, payload(), NOW + 9000);
  assert.equal(again.length, 1, "두 줄이 되면 같은 결제를 두 번 보내게 된다");
  assert.equal(again[0].attempts, 1, "재시도 이력이 살아 있어야 한다");
  assert.equal(again[0].firstSeenAt, NOW, "최초 시각이 유지돼야 stale 판정이 맞는다");
});

test("서로 다른 paymentKey 는 각각 쌓인다 (부분결제: 카드 세 장 = 세 건)", () => {
  let list = addEntry([], payload({ paymentKey: "pk-a", amount: 100_000 }), NOW);
  list = addEntry(list, payload({ paymentKey: "pk-b", amount: 100_000 }), NOW);
  list = addEntry(list, payload({ paymentKey: "pk-c", amount: 80_000 }), NOW);
  assert.equal(list.length, 3);
  assert.equal(
    list.reduce((s, e) => s + e.payload.amount, 0),
    280_000,
  );
});

test("markAttempt 는 해당 건만 건드린다", () => {
  let list = addEntry([], payload({ paymentKey: "pk-a" }), NOW);
  list = addEntry(list, payload({ paymentKey: "pk-b" }), NOW);
  list = markAttempt(list, "pk-a", NOW + 1000, "실패");
  assert.equal(list.find((e) => e.payload.paymentKey === "pk-a")!.attempts, 1);
  assert.equal(list.find((e) => e.payload.paymentKey === "pk-b")!.attempts, 0);
});

test("markAttempt 는 실패 사유를 사람이 읽을 문장으로 남긴다", () => {
  const list = markAttempt(addEntry([], payload(), NOW), "pk-1", NOW, "ApiError: API … 500");
  assert.match(list[0].lastError!, /500/);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 저장소: 앱이 꺼져도 살아남는가 ───");

test("★ 적고 → 껐다 켜고 → 읽으면 그대로 있다 (원래 버그의 정반대)", () => {
  const s = memStorage();
  const before = addEntry([], payload({ amount: 1000 }), NOW);
  saveOutbox(s, before);

  // "재부팅": 메모리는 전부 날아가고 저장소만 남는다.
  const after = loadOutbox(s);
  assert.equal(after.length, 1);
  assert.equal(after[0].payload.amount, 1000);
  assert.equal(after[0].payload.approvalNumber, "12345678");
});

test("비우면 키 자체를 지운다 (쓰레기 '[]' 를 남기지 않는다)", () => {
  const s = memStorage();
  saveOutbox(s, addEntry([], payload(), NOW));
  saveOutbox(s, []);
  assert.equal(s.getItem(OUTBOX_KEY), null);
});

test("★ 저장소 JSON 이 깨져 있어도 던지지 않는다 — 부팅이 막히면 장사를 못 한다", () => {
  const s = memStorage({ [OUTBOX_KEY]: "{이건 JSON 이 아니다" });
  let msg = "";
  const list = loadOutbox(s, (m) => (msg = m));
  assert.deepEqual(list, []);
  assert.match(msg, /깨져/, "조용히 넘어가지 말고 호출부에 알려야 한다");
});

test("★ getItem 이 예외를 던지는 저장소에서도 부팅은 계속된다", () => {
  const s: OutboxStorage = {
    getItem: () => {
      throw new Error("storage disabled");
    },
    setItem: () => {},
    removeItem: () => {},
  };
  let msg = "";
  assert.deepEqual(loadOutbox(s, (m) => (msg = m)), []);
  assert.match(msg, /읽지 못했습니다/);
});

test("★ setItem 이 예외를 던져도(용량 초과 등) 던지지 않는다 — 메모리 사본으로 계속 재시도", () => {
  const s: OutboxStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {},
  };
  let msg = "";
  assert.doesNotThrow(() => saveOutbox(s, addEntry([], payload(), NOW), (m) => (msg = m)));
  assert.match(msg, /저장하지 못했습니다/);
});

test("저장소가 아예 없어도(null) 조용히 동작한다", () => {
  assert.deepEqual(loadOutbox(null), []);
  assert.doesNotThrow(() => saveOutbox(null, []));
});

test("★ paymentKey 나 amount 가 없는 쓰레기 줄은 걸러진다 (보낼 수 없는 데이터)", () => {
  const s = memStorage({
    [OUTBOX_KEY]: JSON.stringify([
      { payload: { paymentKey: "pk-ok", amount: 1000 }, firstSeenAt: NOW, attempts: 0, lastAttemptAt: 0 },
      { payload: { paymentKey: "", amount: 1000 }, firstSeenAt: NOW, attempts: 0, lastAttemptAt: 0 },
      { payload: { paymentKey: "pk-no-amount" }, firstSeenAt: NOW, attempts: 0, lastAttemptAt: 0 },
      null,
      { nope: true },
    ]),
  });
  const list = loadOutbox(s);
  assert.equal(list.length, 1);
  assert.equal(list[0].payload.paymentKey, "pk-ok");
});

test("배열이 아닌 JSON 이 들어 있으면 빈 아웃박스", () => {
  assert.deepEqual(loadOutbox(memStorage({ [OUTBOX_KEY]: '{"a":1}' })), []);
});

// ─────────────────────────────────────────────────────────────────────
console.log("\n─── 시나리오: 원장이 겪은 그 장면 ───");

test("★ 1,000원 승인 → 와이파이 끊김 → 앱 재시작 → 서버 복구 → 장부 반영, 정확히 한 번", () => {
  const s = memStorage();

  // 1) 승인. 서버로 보내기 전에 먼저 적는다.
  let list = addEntry([], payload({ paymentKey: "pk-jjh-2609", amount: 1000 }), NOW);
  saveOutbox(s, list);

  // 2) 전송 실패 (와이파이가 끊겼다). 지우지 않는다.
  assert.equal(isSettled(null), false);
  list = markAttempt(list, "pk-jjh-2609", NOW + 100, "네트워크 오류");
  saveOutbox(s, list);

  // 3) 앱이 꺼졌다 켜진다. 메모리는 없어졌지만 저장소에는 남아 있다.
  list = loadOutbox(s);
  assert.equal(list.length, 1, "여기서 비면 예전 버그와 똑같은 결과가 된다");
  assert.equal(list[0].payload.amount, 1000);

  // 4) 부팅하면서 다시 보낸다. 서버가 받았다.
  assert.equal(isSettled(200), true);
  list = removeEntry(list, "pk-jjh-2609");
  saveOutbox(s, list);

  assert.equal(list.length, 0);
  assert.equal(s.getItem(OUTBOX_KEY), null, "다 보냈으면 저장소도 비어야 한다");
});

test("★ 재시도가 서버에 두 번 닿아도 결과는 한 줄 — 두 번째는 409 로 조용히 정리된다", () => {
  let list = addEntry([], payload({ paymentKey: "pk-dup" }), NOW);

  // 첫 요청이 서버에는 닿았는데 응답이 오다 끊긴 경우. 단말기는 실패로 안다.
  list = markAttempt(list, "pk-dup", NOW, "네트워크 오류");
  assert.equal(list.length, 1, "실패로 봤으니 아직 남아 있다");

  // 다시 보낸다 → 서버는 이미 APPROVED 라 409 로 답한다 → 장부에는 여전히 한 줄.
  assert.equal(isSettled(409, '{"error":"이미 승인된 결제입니다."}'), true);
  list = removeEntry(list, "pk-dup");
  assert.equal(list.length, 0);
});

test("★ 승인이 두 건 밀려 있어도 각각 독립적으로 정리된다", () => {
  const s = memStorage();
  let list = addEntry([], payload({ paymentKey: "pk-a", amount: 1000 }), NOW);
  list = addEntry(list, payload({ paymentKey: "pk-b", amount: 14_000 }), NOW);
  saveOutbox(s, list);

  // a 만 성공.
  list = removeEntry(list, "pk-a");
  saveOutbox(s, list);

  const reloaded = loadOutbox(s);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0].payload.paymentKey, "pk-b");
  assert.equal(reloaded[0].payload.amount, 14_000, "남은 건의 금액이 변하면 안 된다");
});

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
