/**
 * 수기 대사 규칙 회귀 테스트.
 *
 * 배경 — 2026-08-29 현장에 실제로 남은 세 건:
 *   08-28 19:24  270,000  TIMEOUT  ← 진짜 실패. 장부에 넣으면 안 된다.
 *   08-29 13:00    1,000  TIMEOUT  ← 실제로는 승인됨. 넣어야 한다.
 *   08-29 14:57  269,000  TIMEOUT  ← 실제로는 승인됨. 넣어야 한다.
 *
 * 상태만으로는 셋을 구분할 수 없다 (전부 TIMEOUT/expired). 구분은 원장이
 * 판매자센터에서 실물 승인내역을 보고 하는 것이고, 코드가 지킬 것은 딱 둘이다:
 *
 *   (1) 두 번 눌러도 두 번 들어가지 않는다
 *   (2) 아직 살아 있는 결제는 건드리지 않는다 (곧 올 confirm 과 겹친다)
 *
 * 실행: npx tsx scripts/test-reconcile.ts
 */

import assert from "node:assert/strict";
import { classifyReconcile } from "../server/toss-front/reconcile";
import { describeActor, resolveLedgerUserId } from "../server/toss-front/ledgerUser";

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

const asyncTests: Array<[string, () => Promise<void>]> = [];
function atest(name: string, fn: () => Promise<void>) {
  asyncTests.push([name, fn]);
}
async function runAsyncTests() {
  for (const [name, fn] of asyncTests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e: any) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${e?.message ?? e}`);
      failed++;
    }
  }
}

console.log("─── classifyReconcile: 승인된 돈을 되찾되, 두 번 넣지 않는다 ───");

test("★ TIMEOUT 으로 남은 건은 장부에 넣을 수 있다 (269,000·1,000 건)", () => {
  assert.deepEqual(classifyReconcile({ intentStatus: "TIMEOUT", alreadyLedgered: false }), {
    kind: "ok",
  });
});

test("FAILED 로 남은 건도 넣을 수 있다 (실패로 기록됐지만 카드는 긁힌 경우)", () => {
  assert.equal(classifyReconcile({ intentStatus: "FAILED", alreadyLedgered: false }).kind, "ok");
});

test("CANCELED 로 남은 건도 넣을 수 있다 (태블릿 취소와 단말기 승인의 경합)", () => {
  assert.equal(classifyReconcile({ intentStatus: "CANCELED", alreadyLedgered: false }).kind, "ok");
});

test("APPROVED 인데 장부에 없는 건도 넣을 수 있다 (confirm 이 중간에 끊긴 흔적)", () => {
  assert.equal(classifyReconcile({ intentStatus: "APPROVED", alreadyLedgered: false }).kind, "ok");
});

test("★ 두 번 클릭 — 이미 장부에 있으면 아무것도 하지 않는다", () => {
  const d = classifyReconcile({ intentStatus: "TIMEOUT", alreadyLedgered: true });
  assert.equal(d.kind, "noop");
  assert.match((d as any).reason, /이미 장부/);
});

test("★ 이미 장부에 있으면 상태가 무엇이든 noop — 돈이 적혀 있다는 사실이 최우선", () => {
  for (const s of ["CREATED", "PROCESSING", "APPROVED", "TIMEOUT", "FAILED", "CANCELED"]) {
    const d = classifyReconcile({ intentStatus: s, alreadyLedgered: true });
    assert.equal(d.kind, "noop", `${s} 에서 noop 이 아니다`);
  }
});

test("★ 진행 중인 CREATED 는 거절한다 (곧 올 confirm 과 이중 입력이 된다)", () => {
  const d = classifyReconcile({ intentStatus: "CREATED", alreadyLedgered: false });
  assert.equal(d.kind, "reject");
  assert.match((d as any).reason, /진행 중/);
});

test("★ 진행 중인 PROCESSING 도 거절한다", () => {
  const d = classifyReconcile({ intentStatus: "PROCESSING", alreadyLedgered: false });
  assert.equal(d.kind, "reject");
});

test("거절 사유는 원장이 다음에 뭘 할지 알 수 있어야 한다", () => {
  const d = classifyReconcile({ intentStatus: "PROCESSING", alreadyLedgered: false });
  const reason = (d as any).reason as string;
  assert.ok(reason.includes("다시 시도"), `다음 행동이 없다: ${reason}`);
});

/* ────────────────────────────────────────────────────────────────────────
 * resolveLedgerUserId — 장부 반영 500 의 진짜 원인을 막는다.
 *
 * classifyReconcile 은 "넣어도 되는가"만 판정했다. 판정이 ok 여도 실제 INSERT 가
 * 죽으면 원장 화면에는 똑같이 500 이 뜬다. 실제로 그랬다 — payments.created_by 는
 * users(id) 를 가리키는 NOT NULL 외래키인데 superadmin 의 id 는 users 에 없는
 * 문자열 "admin" 이라서 23503 으로 트랜잭션이 통째로 죽었다.
 *
 * 아래 테스트는 DB 없이 tx.execute 를 가짜로 세워 그 분기만 고정한다. 진짜 FK 를
 * 검증하는 건 아니지만, "실존하지 않는 id 를 그대로 돌려주지 않는다" 라는 이 모듈의
 * 유일한 약속은 이걸로 지켜진다.
 * ──────────────────────────────────────────────────────────────────────── */

/** drizzle 의 sql`` 조각을 대략적인 문자열 + 파라미터로 편다. 분기 판별용. */
function renderSql(q: any): { text: string; params: any[] } {
  const params: any[] = [];
  let text = "";
  for (const chunk of q?.queryChunks ?? []) {
    // StringChunk 는 .value 가 문자열 배열이다. 이게 SQL 본문.
    if (chunk && typeof chunk === "object" && Array.isArray((chunk as any).value)) {
      text += (chunk as any).value.join("");
      continue;
    }
    // 나머지는 값. drizzle 버전에 따라 Param 객체일 수도, 원시값 그대로일 수도 있다.
    // (실제로 이 버전은 원시값을 그대로 넣는다 — 객체로만 가정했다가 한 번 틀렸다.)
    params.push(chunk && typeof chunk === "object" && "value" in chunk ? (chunk as any).value : chunk);
    text += "?";
  }
  return { text: text.replace(/\s+/g, " ").trim(), params };
}

interface FakeUser {
  id: string;
  email?: string;
}

function fakeTx(users: FakeUser[]) {
  const inserted: FakeUser[] = [];
  let seq = 1;
  return {
    users,
    inserted,
    async execute(q: any) {
      const { text, params } = renderSql(q);
      if (/INSERT INTO users/i.test(text)) {
        const row: FakeUser = { id: `sys-${seq++}`, email: params[0] };
        users.push(row);
        inserted.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/WHERE id = \?/i.test(text)) {
        const hit = users.find((u) => u.id === params[0]);
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (/WHERE email = \?/i.test(text)) {
        const hit = users.find((u) => u.email === params[0]);
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      throw new Error(`예상 못 한 쿼리: ${text}`);
    },
  };
}

console.log("\n─── resolveLedgerUserId: 장부에 적을 created_by 는 실존해야 한다 ───");

atest("실존하는 원장 계정은 자기 id 를 그대로 쓴다 (감사 기록이 제일 정확하다)", async () => {
  const tx = fakeTx([{ id: "u-owner", email: "owner@a.com" }]);
  const r = await resolveLedgerUserId(tx, "t1", {
    id: "u-owner",
    email: "owner@a.com",
    role: "owner",
  });
  assert.equal(r.userId, "u-owner");
  assert.equal(r.substituted, false);
  assert.equal(tx.inserted.length, 0, "실존하는데 시스템 사용자를 만들었다");
});

atest("★ superadmin 의 id 'admin' 은 users 에 없다 — 시스템 사용자로 대체한다", async () => {
  const tx = fakeTx([{ id: "u-owner", email: "owner@a.com" }]);
  const r = await resolveLedgerUserId(tx, "t1", {
    id: "admin",
    email: "admin@edusync.pro",
    role: "superadmin",
  });
  assert.notEqual(r.userId, "admin", "존재하지 않는 id 를 그대로 돌려줬다 → 23503 재발");
  assert.equal(r.substituted, true);
  assert.equal(tx.inserted.length, 1, "시스템 사용자를 만들지 않았다");
});

atest("★ 대체했을 때는 실제로 누른 사람이 actorLabel 에 남는다 (감사 기록 유실 방지)", async () => {
  const tx = fakeTx([]);
  const r = await resolveLedgerUserId(tx, "t1", {
    id: "admin",
    email: "admin@edusync.pro",
    role: "superadmin",
  });
  assert.equal(r.substituted, true);
  assert.match(r.actorLabel, /admin@edusync\.pro/);
  assert.match(r.actorLabel, /superadmin/);
});

atest("★ 두 번 반영해도 시스템 사용자는 한 번만 만들어진다", async () => {
  const tx = fakeTx([]);
  const a = await resolveLedgerUserId(tx, "t1", { id: "admin", role: "superadmin" });
  const b = await resolveLedgerUserId(tx, "t1", { id: "admin", role: "superadmin" });
  assert.equal(a.userId, b.userId);
  assert.equal(tx.inserted.length, 1, `시스템 사용자가 ${tx.inserted.length}개 생겼다`);
});

atest("테넌트가 다르면 시스템 사용자도 따로 만든다 (장부가 섞이면 안 된다)", async () => {
  const tx = fakeTx([]);
  const a = await resolveLedgerUserId(tx, "t1", { id: "admin", role: "superadmin" });
  const b = await resolveLedgerUserId(tx, "t2", { id: "admin", role: "superadmin" });
  assert.notEqual(a.userId, b.userId);
  assert.equal(tx.inserted.length, 2);
});

atest("계정이 지워졌는데 토큰이 살아 있는 경우도 같은 함정 — 역할이 owner 여도 대체한다", async () => {
  const tx = fakeTx([{ id: "u-owner", email: "owner@a.com" }]);
  const r = await resolveLedgerUserId(tx, "t1", {
    id: "u-deleted",
    email: "gone@a.com",
    role: "owner",
  });
  assert.equal(r.substituted, true, "역할 이름으로 분기하면 이 경우를 놓친다");
  assert.notEqual(r.userId, "u-deleted");
});

atest("id 가 아예 비어 있어도 던지지 않는다 (500 대신 장부에 들어가야 한다)", async () => {
  const tx = fakeTx([]);
  const r = await resolveLedgerUserId(tx, "t1", { id: "" });
  assert.equal(r.substituted, true);
  assert.ok(r.userId);
});

test("describeActor — 이메일이 있으면 이메일이 제일 유용하다", () => {
  assert.equal(describeActor({ id: "u1", email: "a@b.com", name: "김원장", role: "owner" }), "a@b.com(owner)");
});

test("describeActor — 이메일이 없으면 이름, 그것도 없으면 id 로 내려간다", () => {
  assert.equal(describeActor({ id: "u1", name: "김원장", role: "owner" }), "김원장(owner)");
  assert.equal(describeActor({ id: "u1", role: "owner" }), "u1(owner)");
  assert.equal(describeActor({ id: "" }), "unknown");
});

void (async () => {
  await runAsyncTests();
  console.log(`\n${failed === 0 ? "✅" : "❌"} 통과 ${passed} · 실패 ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
})();
