/**
 * 단말기가 서버에 "닿을 수 있는지"를 검증한다.
 *
 * 고정하려는 사고 (2026-08):
 *   단말기 등록이 실패하는데 서버 로그에는 아무것도 없었다. 웹뷰가 CORS 때문에
 *   요청을 아예 보내지 않았기 때문이다. 원인을 볼 수 없는 실패였다.
 *
 *   CORS 는 서버 코드를 읽어서는 맞는지 알기 어렵다. 실제로 헤더가 나가는지를 봐야 한다.
 *   그래서 여기서는 진짜 HTTP 서버를 띄우고 preflight(OPTIONS)와 본 요청을 보내
 *   응답 헤더를 직접 확인한다.
 *
 * 실행: npx tsx scripts/test-cors.ts
 */

import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";

import { pluginCors, isDeviceApi } from "../server/lib/pluginCors";

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
  app.use(pluginCors);
  app.use(express.json());

  // 단말기 경로 (페어링 교환 — 오늘 실패한 바로 그 요청)
  app.post("/api/toss-front/devices/exchange", (_req, res) => res.json({ ok: "device" }));
  app.get("/api/toss-front/dispatch/pending", (_req, res) => res.json({ pending: null }));
  // 원장 화면용 경로 — 쿠키 인증이라 열면 안 된다
  app.get("/api/toss-front/admin/devices", (_req, res) => res.json({ ok: "admin" }));
  // 일반 앱 경로
  app.get("/api/students", (_req, res) => res.json({ ok: "app" }));

  return app;
}

async function main() {
  console.log("─── 단말기 CORS ───");

  const app = buildApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const preflight = (path: string, origin: string) =>
    fetch(`${base}${path}`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

  // ─── 오늘의 사고 재현 방지 ────────────────────────────────────────────
  // 단말기 웹뷰의 origin 이 무엇이든 요청은 통해야 한다. 우리가 origin 을 맞히지
  // 못하는 것이 곧 학원 마비가 되어서는 안 된다.
  for (const origin of [
    "null",                                                  // 로컬 파일에서 실행되는 웹뷰
    "https://edusyncpro-front.plugin.tossplace.com",         // 문서상 운영 origin
    "https://edusyncpro-front.plugin-dev.tossplace.com",     // 문서상 개발 origin
    "https://EduSyncPro-Front.plugin.tossplace.com",         // appName 에 대문자가 섞인 경우
    "https://whatever-unknown.example.com",                  // 우리가 예상 못 한 origin
  ]) {
    await test(`preflight 통과: Origin=${origin}`, async () => {
      const r = await preflight("/api/toss-front/devices/exchange", origin);
      assert.equal(r.status, 204, `preflight 가 204 가 아닙니다 (${r.status})`);
      assert.equal(
        r.headers.get("access-control-allow-origin"),
        "*",
        "Access-Control-Allow-Origin 헤더가 없으면 웹뷰가 요청을 보내지 않습니다"
      );
    });

    await test(`본 요청에도 CORS 헤더가 붙는다: Origin=${origin}`, async () => {
      const r = await fetch(`${base}/api/toss-front/devices/exchange`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ pairingCode: "ABC123", pin: "1234", serialNumber: "S1" }),
      });
      assert.equal(r.headers.get("access-control-allow-origin"), "*");
      assert.deepEqual(await r.json(), { ok: "device" });
    });
  }

  await test("폴링 경로(dispatch/pending)도 열려 있다", async () => {
    const r = await fetch(`${base}/api/toss-front/dispatch/pending`, {
      headers: { origin: "null" },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
  });

  // ─── 열어서는 안 되는 것 ──────────────────────────────────────────────
  await test("Allow-Credentials 는 켜지 않는다 (* 와 함께 쓰면 위험·무효)", async () => {
    const r = await preflight("/api/toss-front/devices/exchange", "null");
    assert.equal(r.headers.get("access-control-allow-credentials"), null);
  });

  await test("원장 화면용 /admin 은 아무 origin 에나 열리지 않는다", async () => {
    const r = await fetch(`${base}/api/toss-front/admin/devices`, {
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(
      r.headers.get("access-control-allow-origin"),
      null,
      "쿠키로 보호되는 관리자 API 가 교차 출처에 노출됐습니다"
    );
  });

  await test("일반 앱 API 는 모르는 origin 에 열리지 않는다", async () => {
    const r = await fetch(`${base}/api/students`, {
      headers: { origin: "https://evil.example.com" },
    });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });

  await test("일반 앱 API 는 Toss 플러그인 origin 에는 열린다 (기존 동작 유지)", async () => {
    const origin = "https://edusyncpro-front.plugin.tossplace.com";
    const r = await fetch(`${base}/api/students`, { headers: { origin } });
    assert.equal(r.headers.get("access-control-allow-origin"), origin);
  });

  // ─── 경로 판정 ────────────────────────────────────────────────────────
  await test("isDeviceApi 경계", () => {
    assert.equal(isDeviceApi("/api/toss-front/session"), true);
    assert.equal(isDeviceApi("/api/toss-front/devices/exchange"), true);
    assert.equal(isDeviceApi("/api/toss-front/admin/devices"), false);
    assert.equal(isDeviceApi("/api/toss-kiosk/session"), false);
    assert.equal(isDeviceApi("/api/students"), false);
    // prefix 를 흉내 낸 경로에 속지 않는다
    assert.equal(isDeviceApi("/api/toss-frontier/x"), false);
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));

  console.log("\n─── 결과 ───");
  console.log(`  통과 ${passed} / 실패 ${failed}`);

  // process.exit() 을 쓰지 않는다 (이유는 test-server-resilience.ts 주석 참고).
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
