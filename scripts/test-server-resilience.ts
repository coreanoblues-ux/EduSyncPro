/**
 * 서버가 요청 하나 때문에 죽지 않는지 검증한다.
 *
 * 고정하려는 사고 (2026-08):
 *   단말기 등록 버튼 한 번에 학원 전체가 멈췄다. DB에 컬럼이 없어 INSERT 가 실패했는데,
 *   Express 4 가 async 핸들러의 Promise 거부를 못 잡아 프로세스가 종료됐고 Railway 가
 *   502 를 뱉었다. 수납·출결·학생조회까지 같이 죽었다.
 *
 *   여기서는 진짜 HTTP 서버를 띄우고 실제로 요청을 보내 확인한다. 함수 단위로만 보면
 *   "예외가 났다"까지밖에 못 보는데, 정작 중요한 건 그 다음 — 응답이 오는가, 그리고
 *   서버가 살아 있는가 — 이기 때문이다.
 *
 * 실행: npx tsx scripts/test-server-resilience.ts
 */

import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

// 라우트를 등록하기 전에 보호가 설치되어야 한다 (실제 server/index.ts 와 같은 순서).
import "../server/lib/asyncErrors";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
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

function buildApp() {
  const app = express();

  // async 안에서 터지는 라우트 — 오늘 사고와 같은 모양 (DB 오류를 흉내낸다)
  app.get("/boom-async", async (_req, _res) => {
    throw new Error('column "pairing_code" does not exist');
  });

  // 동기적으로 터지는 라우트 — Express 가 원래 잡아 주던 경우가 안 깨졌는지 확인
  app.get("/boom-sync", (_req, _res) => {
    throw new Error("동기 예외");
  });

  // 라우트 인자로 넘긴 async 미들웨어에서 터지는 경우 (authGuard 와 같은 모양)
  const guard = async (_req: any, _res: any, _next: any) => {
    throw new Error("가드에서 터짐");
  };
  app.get("/boom-guard", guard, (_req, res) => res.json({ ok: true }));

  // 정상 라우트 — 사고 뒤에도 계속 응답하는지 확인할 대조군
  app.get("/ok", (_req, res) => res.json({ ok: true }));

  // status 를 지정한 오류는 그 코드로 나가야 한다
  app.get("/teapot", async (_req, _res) => {
    const err: any = new Error("나는 주전자다");
    err.status = 418;
    throw err;
  });

  // server/index.ts 와 동일한 전역 에러 핸들러
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status || err.statusCode || 500;
    if (!res.headersSent) res.status(status).json({ message: err.message });
  });

  return app;
}

async function main() {
  console.log("─── async 라우트 예외 처리 ───");

  const app = buildApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  // 프로세스가 죽었어야 할 상황에서 죽지 않았는지 보려면, 죽음을 관측해야 한다.
  let fatal: any = null;
  const onFatal = (e: any) => (fatal = e);
  process.on("unhandledRejection", onFatal);
  process.on("uncaughtException", onFatal);

  await test("async 라우트가 터져도 500 응답이 온다 (무한 대기 아님)", async () => {
    const r = await fetch(`${base}/boom-async`);
    assert.equal(r.status, 500);
    const body: any = await r.json();
    assert.match(body.message, /pairing_code/);
  });

  await test("동기 예외도 그대로 500 이다 (기존 동작 유지)", async () => {
    const r = await fetch(`${base}/boom-sync`);
    assert.equal(r.status, 500);
  });

  await test("라우트 미들웨어(guard)에서 터져도 500 이다", async () => {
    const r = await fetch(`${base}/boom-guard`);
    assert.equal(r.status, 500);
    const body: any = await r.json();
    assert.match(body.message, /가드/);
  });

  await test("err.status 를 지정하면 그 코드로 나간다 (500 으로 뭉개지 않는다)", async () => {
    const r = await fetch(`${base}/teapot`);
    assert.equal(r.status, 418);
  });

  await test("사고 이후에도 서버는 계속 정상 응답한다", async () => {
    const r = await fetch(`${base}/ok`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  });

  await test("프로세스를 죽일 만한 미처리 거부가 발생하지 않았다", () => {
    assert.equal(
      fatal,
      null,
      `미처리 오류가 관측됐습니다 — 운영에서는 이 시점에 프로세스가 종료됩니다: ${fatal}`
    );
  });

  await test("정상 라우트의 반환값을 건드리지 않는다", async () => {
    const r = await fetch(`${base}/ok`);
    assert.equal(r.headers.get("content-type")?.includes("application/json"), true);
  });

  process.off("unhandledRejection", onFatal);
  process.off("uncaughtException", onFatal);

  // 닫히기를 기다린 뒤에 끝낸다. 닫는 중에 process.exit 을 부르면 Windows 의 libuv 가
  // "UV_HANDLE_CLOSING" 어설션을 뱉는다 (종료 코드는 0이라 더 헷갈린다).
  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log("\n─── 결과 ───");
  console.log(`  통과 ${passed} / 실패 ${failed}`);

  // process.exit() 을 쓰지 않는다. Windows + tsx 조합에서 아직 닫히는 중인 핸들이
  // 있으면 libuv 가 UV_HANDLE_CLOSING 어설션으로 abort 해 버려서, 테스트가 다 통과했는데도
  // 종료 코드가 실패로 잡힌다. 서버를 닫았으니 이벤트 루프는 비어 있고 자연히 끝난다.
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
