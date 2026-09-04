/**
 * 밤샘 유휴 뒤 첫 결제가 죽는 문제의 안전장치 시험.
 *
 * ══ 무슨 일이 있었나 (2026-09-03, 원장 신고 · 두 번째) ══
 *
 *   "단말기를 안 끄고 퇴근했다가 다음 날 첫 결제를 하면 안 된다. 결제 화면까지는
 *    넘어가는데 카드 넣으라는 화면이 안 뜨거나 통신중만 뜬다. 껐다 켜면 하루 종일
 *    잘 된다."
 *
 *   코드에서 확인한 원인은 '불안정' 이 아니라 구조였다:
 *
 *     1) 플러그인의 모든 fetch 에 시간 제한이 없었다. fetch 는 스스로 포기하지 않는다.
 *     2) 폴링은 finally 안에서만 다음 바퀴를 예약한다. 그러니 요청 하나가 영원히
 *        안 끝나면 finally 도 영원히 안 오고, **1초 폴링이 통째로, 영구히 죽는다.**
 *     3) 폴링이 죽으면 결제요청을 아무도 집어가지 않는다 → 태블릿은 "통신 중" 만
 *        띄운다. 재부팅이 유일한 복구였다. 원장이 매일 아침 하던 그 일이다.
 *
 *   밤새 유휴 상태로 두면 공유기·통신사 NAT 가 조용히 연결을 끊는다. 단말기는
 *   그 사실을 모른 채 죽은 소켓으로 요청을 보내고, 답을 기다리며 매달린다.
 *   그래서 **하필 아침 첫 결제**에서만 재현됐다.
 *
 * ══ 이 시험이 지키는 두 방향 ══
 *
 *   너무 느슨하면 → 아침마다 같은 일이 반복된다. (위 사고)
 *   너무 공격적이면 → 학생이 카드를 대고 있는 60초 결제 도중에 폴링이 되살아나
 *                     다음 결제요청을 집는다. 한 단말기에서 두 건이 겹친다.
 *                     **이쪽이 훨씬 나쁘다. 돈이 걸려 있다.**
 *
 *   그래서 "멈춤을 잡는다" 와 "결제 중에는 절대 건드리지 않는다" 를 같이 건다.
 *
 * 실행: npx tsx scripts/test-idle-recovery.ts
 */

import assert from "node:assert/strict";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  IDLE_GAP_MS,
  LOG_REQUEST_TIMEOUT_MS,
  POLL_REQUEST_TIMEOUT_MS,
  POLL_STUCK_MS,
  RequestTimeoutError,
  fetchWithTimeout,
  isLongIdleGap,
  isPollStuck,
} from "../plugins/toss-front/src/net";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

const 초 = 1000;
const 분 = 60 * 초;
const 시간 = 60 * 분;

async function main() {
  console.log("\n[상한값이 서로 모순되지 않는가]");

  test("★ 워치독은 정상 최악 경로보다 반드시 길어야 한다", () => {
    // 정상적으로도 오래 걸릴 수 있는 최악: 세션 재발급 + 폴링 요청.
    // 워치독이 이보다 짧으면 멀쩡히 돌고 있는 폴링을 "멈췄다" 며 계속 재시작한다.
    const 정상최악 = DEFAULT_REQUEST_TIMEOUT_MS + POLL_REQUEST_TIMEOUT_MS;
    assert.ok(
      POLL_STUCK_MS > 정상최악,
      `워치독(${POLL_STUCK_MS}ms)이 정상 최악(${정상최악}ms)보다 짧으면 멀쩡한 폴링을 죽인다`,
    );
  });

  test("폴링 요청은 일반 요청보다 짧게 끊는다 (1초마다 다시 두드리므로)", () => {
    assert.ok(POLL_REQUEST_TIMEOUT_MS < DEFAULT_REQUEST_TIMEOUT_MS);
  });

  test("로그 전송이 가장 짧다 (로그 때문에 소켓을 오래 붙들지 않는다)", () => {
    assert.ok(LOG_REQUEST_TIMEOUT_MS <= POLL_REQUEST_TIMEOUT_MS);
  });

  test("유휴 판정선은 정상 폴링 간격보다 한참 커야 한다", () => {
    // 정상 간격 1초. 90초는 그 90배다. 이보다 작게 잡으면 조금만 느려도
    // 매번 세션을 새로 맺느라 서버를 두들기게 된다.
    assert.ok(IDLE_GAP_MS >= 60 * 초);
  });

  console.log("\n[폴링이 멈췄는지 판정 — 마지막 방어선]");

  const 지금 = 1_700_000_000_000;

  test("★ 결제창이 떠 있는 동안에는 무슨 일이 있어도 개입하지 않는다", () => {
    // 학생이 카드를 들고 서 있는 중이다. 여기서 폴링을 되살리면 되살아난
    // 폴링이 다음 결제요청을 집어 한 단말기에서 두 건이 겹친다.
    // 멈춘 폴링보다 이게 훨씬 나쁘다.
    assert.equal(isPollStuck(지금 - 10 * 분, 지금, true), false);
    assert.equal(isPollStuck(지금 - 24 * 시간, 지금, true), false);
  });

  test("놀고 있을 때(진행 중인 바퀴 없음)는 멈춤이 아니다", () => {
    assert.equal(isPollStuck(null, 지금, false), false);
  });

  test("★ 정상 폴링(1초)을 멈춤으로 오해하지 않는다", () => {
    assert.equal(isPollStuck(지금 - 1 * 초, 지금, false), false);
  });

  test("★ 상한을 넘겨야만 멈춤으로 본다 (경계 바로 앞은 아니다)", () => {
    assert.equal(isPollStuck(지금 - (POLL_STUCK_MS - 1), 지금, false), false);
    assert.equal(isPollStuck(지금 - (POLL_STUCK_MS + 1), 지금, false), true);
  });

  test("★ 밤새 매달려 있던 요청은 반드시 잡는다 (이게 재부팅을 없앤다)", () => {
    assert.equal(isPollStuck(지금 - 9 * 시간, 지금, false), true);
  });

  console.log("\n[밤샘 유휴를 알아보는가 — 세션을 새로 맺을 시점]");

  test("첫 폴링(이전 기록 없음)은 유휴가 아니다", () => {
    // 부팅 직후는 방금 세션을 맺은 참이다. 여기서 또 맺으면 낭비다.
    assert.equal(isLongIdleGap(null, 지금), false);
  });

  test("정상 간격 1초는 유휴가 아니다", () => {
    assert.equal(isLongIdleGap(지금 - 1 * 초, 지금), false);
  });

  test("★ 60초짜리 결제가 막 끝난 직후를 유휴로 오해하지 않는다", () => {
    // 폴링은 '한 바퀴의 끝' 에서도 시각을 갱신한다. 결제 중 폴링이 멈춰 있는
    // 것은 정상이므로, 결제 직후의 간격은 1초로 측정돼야 한다.
    assert.equal(isLongIdleGap(지금 - 1 * 초, 지금), false);
    // 혹시 결제 시간을 통째로 세더라도 90초선 밑이면 여전히 유휴가 아니다.
    assert.equal(isLongIdleGap(지금 - 60 * 초, 지금), false);
  });

  test("★ 밤새 방치(9시간)는 유휴로 잡는다", () => {
    assert.equal(isLongIdleGap(지금 - 9 * 시간, 지금), true);
  });

  test("★ 단말기 시계가 뒤로 가도 유휴로 오해하지 않는다", () => {
    // 시각 보정으로 시계가 뒤로 뛰면 (now - prev) 가 음수가 된다.
    // 이걸 유휴로 세면 매 폴링마다 세션을 새로 맺는다.
    assert.equal(isLongIdleGap(지금 + 5 * 분, 지금), false);
  });

  test("경계: 딱 90초는 아직 아니고, 90초를 넘기면 유휴다", () => {
    assert.equal(isLongIdleGap(지금 - IDLE_GAP_MS, 지금), false);
    assert.equal(isLongIdleGap(지금 - (IDLE_GAP_MS + 1), 지금), true);
  });

  console.log("\n[요청에 시간 제한이 실제로 걸리는가]");

  const 원래fetch = globalThis.fetch;

  await testAsync("정상 응답은 그대로 통과한다", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as any;
    const res = await fetchWithTimeout("https://example.test/x", {}, 500);
    assert.equal(res.status, 200);
  });

  await testAsync("★ 답이 없는 요청은 정해진 시간에 끊긴다 (이 한 줄이 사고의 핵심)", async () => {
    // 죽은 소켓을 흉내 낸다: 영원히 resolve 하지 않고, abort 되면 그때 거부한다.
    globalThis.fetch = ((_url: string, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("The user aborted a request.");
          e.name = "AbortError";
          reject(e);
        });
      })) as any;

    const 시작 = Date.now();
    await assert.rejects(
      fetchWithTimeout("https://example.test/hang", {}, 120),
      (err: unknown) => err instanceof RequestTimeoutError,
      "시간 제한이 걸리지 않으면 폴링이 영구히 죽는다 — 이 시험이 그 재발을 막는다",
    );
    const 걸린시간 = Date.now() - 시작;
    assert.ok(걸린시간 < 3000, `너무 오래 매달렸다: ${걸린시간}ms`);
  });

  await testAsync("★ 우리가 끊은 것과 다른 네트워크 오류를 섞지 않는다", async () => {
    // 웹뷰가 막은 경우(ACL 미등록 등)는 원인이 완전히 다르다. 그 원문이
    // RequestTimeoutError 로 덮이면 현장에서 엉뚱한 곳을 보게 된다.
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as any;

    await assert.rejects(
      fetchWithTimeout("https://example.test/blocked", {}, 500),
      (err: unknown) =>
        err instanceof TypeError && !(err instanceof RequestTimeoutError),
    );
  });

  await testAsync("AbortController 가 없는 구형 웹뷰에서는 예전과 똑같이 동작한다", async () => {
    // 새 안전장치가 구형 단말기의 결제를 막으면 안 된다.
    const 원래Abort = globalThis.AbortController;
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as any;
    (globalThis as any).AbortController = undefined;
    try {
      const res = await fetchWithTimeout("https://example.test/x", {}, 10);
      assert.equal(res.status, 200);
    } finally {
      globalThis.AbortController = 원래Abort;
    }
  });

  await testAsync("시간 제한을 0 이하로 주면 제한 없이 동작한다", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as any;
    const res = await fetchWithTimeout("https://example.test/x", {}, 0);
    assert.equal(res.status, 200);
  });

  globalThis.fetch = 원래fetch;

  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
