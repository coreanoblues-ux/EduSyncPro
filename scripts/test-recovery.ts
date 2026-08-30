/**
 * 자동 대사 선별 규칙 회귀 테스트.
 *
 * 이 규칙이 틀리면 두 가지 중 하나가 일어난다:
 *   (a) 승인된 돈을 못 찾아온다        → 원장이 다시 수기로 처리하게 된다
 *   (b) 없는 돈을 장부에 만들어 낸다   → 이건 훨씬 나쁘다. 회계가 틀어진다.
 *
 * (b) 를 막는 근거는 코드가 아니라 토스 SDK 의 성질이다 — getPayment 는
 * **SUCCESS 결과만** 캐시한다. 진짜 실패한 결제는 단말기도 모른다고 답한다.
 * 아래 테스트는 그 성질에 기대는 부분과, 우리가 스스로 지켜야 하는 부분
 * (이미 장부에 있으면 안 묻는다 / 진행 중이면 안 건드린다 / 답 받은 건 다시
 * 안 묻는다) 을 갈라서 고정한다.
 *
 * 실행: npx tsx scripts/test-recovery.ts
 */

import assert from "node:assert/strict";
import {
  selectRecoveryKeys,
  markVerifiedNoApproval,
  VERIFIED_NO_APPROVAL,
  RECOVERY_WINDOW_DAYS,
  type RecoveryCandidate,
} from "../server/toss-front/recovery";

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

const NOW = new Date("2026-08-30T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function candidate(over: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    paymentKey: "pk-1",
    intentStatus: "TIMEOUT",
    createdAt: daysAgo(1),
    alreadyLedgered: false,
    failureReason: "expired",
    ...over,
  };
}

console.log("─── selectRecoveryKeys: 단말기에게 되물을 건을 고른다 ───");

test("★ TIMEOUT 으로 남았고 장부에 없는 건은 물어본다 (269,000·1,000 같은 건)", () => {
  assert.deepEqual(selectRecoveryKeys([candidate()], NOW), ["pk-1"]);
});

test("FAILED 로 남은 건도 물어본다 (실패로 기록됐지만 카드는 긁혔을 수 있다)", () => {
  assert.deepEqual(
    selectRecoveryKeys([candidate({ intentStatus: "FAILED" })], NOW),
    ["pk-1"]
  );
});

test("CANCELED 로 남은 건도 물어본다 (태블릿 취소와 단말기 승인의 경합)", () => {
  assert.deepEqual(
    selectRecoveryKeys([candidate({ intentStatus: "CANCELED" })], NOW),
    ["pk-1"]
  );
});

test("★ 이미 장부에 있으면 묻지 않는다 — 이중 수입을 만들 여지를 아예 없앤다", () => {
  assert.deepEqual(selectRecoveryKeys([candidate({ alreadyLedgered: true })], NOW), []);
});

test("★ 진행 중(CREATED·PROCESSING)인 결제는 건드리지 않는다 — 결제 화면과 경합한다", () => {
  for (const s of ["CREATED", "PROCESSING"]) {
    assert.deepEqual(
      selectRecoveryKeys([candidate({ intentStatus: s })], NOW),
      [],
      `${s} 를 물어보러 갔다`
    );
  }
});

test("APPROVED 인데 장부에 없는 건은 묻지 않는다 — 승인은 이미 알고, 실패한 건 장부 쓰기다", () => {
  assert.deepEqual(selectRecoveryKeys([candidate({ intentStatus: "APPROVED" })], NOW), []);
});

test("★ '승인 없음' 답을 이미 받은 건은 다시 묻지 않는다 (끝나지 않는 숙제 방지)", () => {
  const c = candidate({ failureReason: `expired · ${VERIFIED_NO_APPROVAL}` });
  assert.deepEqual(selectRecoveryKeys([c], NOW), []);
});

test(`★ ${RECOVERY_WINDOW_DAYS}일이 넘은 건은 묻지 않는다 — 단말기 캐시가 14일이라 답을 믿을 수 없다`, () => {
  assert.deepEqual(
    selectRecoveryKeys([candidate({ createdAt: daysAgo(RECOVERY_WINDOW_DAYS + 1) })], NOW),
    []
  );
  // 경계 안쪽은 물어본다
  assert.deepEqual(
    selectRecoveryKeys([candidate({ createdAt: daysAgo(RECOVERY_WINDOW_DAYS - 1) })], NOW),
    ["pk-1"]
  );
});

test("미래 시각으로 만들어진 것처럼 보이는 건은 건너뛴다 (시계 뒤틀림)", () => {
  const future = new Date(NOW.getTime() + 60 * 60 * 1000);
  assert.deepEqual(selectRecoveryKeys([candidate({ createdAt: future })], NOW), []);
});

test("★ 한 번에 너무 많이 묻지 않는다 — 단말기의 본업은 결제다", () => {
  const many = Array.from({ length: 20 }, (_, i) => candidate({ paymentKey: `pk-${i}` }));
  const picked = selectRecoveryKeys(many, NOW);
  assert.equal(picked.length, 3, `한 번에 ${picked.length}건을 물어보려 했다`);
  assert.deepEqual(picked, ["pk-0", "pk-1", "pk-2"]);
});

test("limit 을 넘겨도 건너뛴 건은 자리를 차지하지 않는다", () => {
  const rows = [
    candidate({ paymentKey: "skip-1", alreadyLedgered: true }),
    candidate({ paymentKey: "skip-2", intentStatus: "PROCESSING" }),
    candidate({ paymentKey: "ask-1" }),
    candidate({ paymentKey: "ask-2" }),
  ];
  assert.deepEqual(selectRecoveryKeys(rows, NOW, 2), ["ask-1", "ask-2"]);
});

test("빈 목록이면 빈 목록을 돌려준다", () => {
  assert.deepEqual(selectRecoveryKeys([], NOW), []);
});

console.log("\n─── markVerifiedNoApproval: 확인 결과를 사유에 남긴다 ───");

test("기존 사유를 지우지 않고 덧붙인다 (만료된 것도 사실이다)", () => {
  assert.equal(markVerifiedNoApproval("expired"), `expired · ${VERIFIED_NO_APPROVAL}`);
});

test("사유가 없으면 표식만 남긴다", () => {
  assert.equal(markVerifiedNoApproval(null), VERIFIED_NO_APPROVAL);
});

test("★ 두 번 표시해도 문장이 불어나지 않는다", () => {
  const once = markVerifiedNoApproval("expired");
  assert.equal(markVerifiedNoApproval(once), once);
});

test("표식을 남긴 건은 곧바로 선별에서 빠진다 (두 함수가 실제로 맞물린다)", () => {
  const reason = markVerifiedNoApproval("expired");
  assert.deepEqual(selectRecoveryKeys([candidate({ failureReason: reason })], NOW), []);
});

console.log(`\n${failed === 0 ? "✅" : "❌"} 통과 ${passed} · 실패 ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
