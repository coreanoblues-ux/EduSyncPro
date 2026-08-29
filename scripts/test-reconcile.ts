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

console.log(`\n${failed === 0 ? "✅" : "❌"} 통과 ${passed} · 실패 ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
