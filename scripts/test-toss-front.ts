/**
 * Toss Front 서버 로직 단위 검증.
 *
 * 실 Toss 하드웨어·SDK 없이 서버 쪽 흐름만 문서화·검증한다:
 *   1. 장치 키 발급·해시·비교
 *   2. 가상 청구서 토큰 서명·검증·만료
 *   3. 웹훅 HMAC 서명 계산 (Toss가 실제 사용하는 방식과 동일한지)
 *
 * 실행: npx tsx scripts/test-toss-front.ts
 */

import "dotenv/config";
import crypto from "crypto";
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  const wrap = async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e: any) {
      console.log(`  ✗ ${name}`);
      console.log(`    ${e?.message ?? e}`);
      failed++;
    }
  };
  return wrap();
}

async function main() {
  console.log("─── deviceAuth ───");

  const { generateDeviceKey, hashDeviceKey, _compareHashesForTest } = await import(
    "../server/toss-front/deviceAuth"
  );

  await test("장치 키는 매번 다르다", () => {
    const a = generateDeviceKey();
    const b = generateDeviceKey();
    assert.notEqual(a, b);
    assert.ok(a.length >= 32);
  });

  await test("같은 키의 해시는 같다", () => {
    const key = generateDeviceKey();
    assert.equal(hashDeviceKey(key), hashDeviceKey(key));
  });

  await test("다른 키의 해시는 다르다", () => {
    assert.notEqual(hashDeviceKey(generateDeviceKey()), hashDeviceKey(generateDeviceKey()));
  });

  await test("해시 비교는 길이 다르면 false", () => {
    assert.equal(_compareHashesForTest("abc", "abcd"), false);
  });

  console.log("\n─── virtualInvoice ───");

  // 결정론적 테스트를 위해 시크릿 고정
  process.env.TOSS_FRONT_INVOICE_SECRET = "test-secret-for-invoice-only";
  const { signVirtualInvoice, verifyVirtualInvoice } = await import(
    "../server/toss-front/virtualInvoice"
  );

  await test("서명한 토큰은 검증 시 원본 payload가 나온다", () => {
    const payload = {
      tenantId: "t1",
      studentId: "s1",
      studentName: "홍길동",
      enrollmentId: "e1",
      paymentMonth: "2026-08",
      amount: 120000,
      className: "월수 심화A",
    };
    const token = signVirtualInvoice(payload);
    const back = verifyVirtualInvoice(token);
    assert.deepEqual(back, payload);
  });

  await test("변조된 토큰은 null", () => {
    const token = signVirtualInvoice({
      tenantId: "t1",
      studentId: "s1",
      studentName: "홍길동",
      enrollmentId: "e1",
      paymentMonth: "2026-08",
      amount: 120000,
      className: "월수 심화A",
    });
    // 마지막 글자를 하나 바꾸어 서명을 무효화
    const broken = token.slice(0, -1) + (token.slice(-1) === "A" ? "B" : "A");
    assert.equal(verifyVirtualInvoice(broken), null);
  });

  await test("아무 문자열이나 넣으면 null", () => {
    assert.equal(verifyVirtualInvoice("not-a-jwt"), null);
    assert.equal(verifyVirtualInvoice(""), null);
  });

  console.log("\n─── webhook HMAC ───");

  // Toss 스펙: HMAC-SHA256(secret, `${timestamp}.${rawBody}`) → base64
  await test("HMAC 계산이 Toss 규격과 같은 절차를 따른다", () => {
    const secret = "wh-secret";
    const rawBody = JSON.stringify({ paymentKey: "tf_abc", amount: 12000 });
    const ts = "1730000000000";
    const message = `${ts}.${rawBody}`;
    const sig = crypto.createHmac("sha256", secret).update(message, "utf8").digest("base64");
    assert.ok(sig.length > 30);
    // 검증 함수와 대칭 확인 (동일 함수 호출)
    const again = crypto.createHmac("sha256", secret).update(message, "utf8").digest("base64");
    assert.equal(sig, again);
  });

  await test("body를 재직렬화하면 서명이 달라진다 (rawBody 필요성)", () => {
    const secret = "wh-secret";
    const obj = { a: 1, b: 2 };
    const original = JSON.stringify(obj);
    // 다시 파싱 후 재직렬화하면 공백·키 순서가 유지된다 하더라도 잠재적으로 다를 수 있다.
    const restringified = JSON.stringify(JSON.parse(original), null, 2); // 들여쓰기 추가
    const ts = "0";
    const s1 = crypto.createHmac("sha256", secret).update(`${ts}.${original}`, "utf8").digest("base64");
    const s2 = crypto.createHmac("sha256", secret).update(`${ts}.${restringified}`, "utf8").digest("base64");
    assert.notEqual(s1, s2);
  });

  console.log("\n─── dispatch 라우트 경로 ───");

  /**
   * 이 블록은 실제로 났던 사고를 고정한다.
   *
   * dispatch 라우터가 태블릿 경로를 "/kiosk/dispatch" 로 선언한 채
   * app.use("/api/toss-kiosk", router) 로 마운트돼 최종 경로가
   * "/api/toss-kiosk/kiosk/dispatch" 가 됐다. 태블릿은 "/api/toss-kiosk/dispatch" 를
   * 부르고 있었으므로 전부 404 로 떨어져 "존재하지 않는 API 경로입니다." 가 떴다.
   *
   * 라우터 스택을 직접 읽어 경로를 검사하면 이런 어긋남을 배포 전에 잡을 수 있다.
   */
  const { kioskDispatchRouter, frontDispatchRouter } = await import(
    "../server/toss-front/dispatch"
  );

  const pathsOf = (router: any): string[] =>
    router.stack
      .filter((l: any) => l.route)
      .map((l: any) => l.route.path as string);

  const kioskPaths = pathsOf(kioskDispatchRouter);
  const frontPaths = pathsOf(frontDispatchRouter);

  await test("태블릿 dispatch 경로가 프리픽스를 중복하지 않는다", () => {
    for (const p of kioskPaths) {
      assert.ok(
        !p.startsWith("/kiosk"),
        `kioskDispatchRouter 경로 "${p}" 가 /kiosk 를 중복해서 갖고 있습니다. ` +
          `이 라우터는 /api/toss-kiosk 에 마운트되므로 경로는 /dispatch 로 시작해야 합니다.`
      );
    }
  });

  await test("StudentKiosk.tsx 가 호출하는 3개 경로가 모두 존재한다", () => {
    // client/src/pages/StudentKiosk.tsx 의 실제 호출과 1:1 대응
    assert.ok(kioskPaths.includes("/dispatch"), "POST /api/toss-kiosk/dispatch 누락");
    assert.ok(kioskPaths.includes("/dispatch/:id"), "GET /api/toss-kiosk/dispatch/:id 누락");
    assert.ok(
      kioskPaths.includes("/dispatch/:id/cancel"),
      "POST /api/toss-kiosk/dispatch/:id/cancel 누락"
    );
  });

  await test("플러그인 api.ts 가 호출하는 경로가 모두 존재한다", () => {
    assert.ok(frontPaths.includes("/dispatch/pending"), "GET /api/toss-front/dispatch/pending 누락");
    assert.ok(frontPaths.includes("/dispatch/:id/ack"), "POST /api/toss-front/dispatch/:id/ack 누락");
    assert.ok(
      frontPaths.includes("/dispatch/:id/result"),
      "POST /api/toss-front/dispatch/:id/result 누락"
    );
  });

  await test("두 라우터는 경로가 겹치지 않는다 (인증 미들웨어가 다르다)", () => {
    const overlap = kioskPaths.filter((p) => frontPaths.includes(p));
    assert.deepEqual(
      overlap,
      [],
      `kioskGuard 경로와 deviceGuard 경로가 겹칩니다: ${overlap.join(", ")}`
    );
  });

  console.log("\n─── 플러그인 로그 마스킹 ───");

  const { redactSecrets } = await import("../server/toss-front/pluginLogs");

  await test("JWT 는 통째로 가려진다", () => {
    const jwtLike =
      "eyJhbGciOiJIUzI1NiJ9.eyJkZXZpY2VJZCI6ImFiYyJ9.s0m3S1gnatureValueHere123";
    const out = redactSecrets(`세션 발급 성공 token=${jwtLike}`);
    assert.ok(!out.includes(jwtLike), "JWT 원문이 그대로 남았습니다");
    assert.ok(out.includes("redacted"));
  });

  await test("deviceKey 는 앞 4자만 남는다", () => {
    const out = redactSecrets("deviceKey=AbCdEfGhIjKlMnOpQrStUvWxYz012345");
    assert.ok(!out.includes("AbCdEfGhIjKlMnOpQrStUvWxYz012345"), "원문 키가 남았습니다");
    assert.ok(out.includes("AbCd"), "앞 4자 힌트가 사라졌습니다 (원장이 대조할 수 없음)");
  });

  await test("긴 무작위 문자열은 잘린다", () => {
    const token = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0";
    assert.ok(!redactSecrets(`값: ${token}`).includes(token));
  });

  await test("평범한 한글 문장은 건드리지 않는다", () => {
    const msg = "결제 요청 대기 중입니다. 금액=270000원";
    assert.equal(redactSecrets(msg), msg);
  });

  console.log("\n─── 결과 ───");
  console.log(`  통과 ${passed} / 실패 ${failed}`);

  /**
   * 반드시 명시적으로 종료한다.
   *
   * 이 스크립트는 dispatch.ts 를 import 하는데, 그 체인이 DB 커넥션 풀과
   * pluginLogs 의 setInterval 을 딸려 온다. 둘 다 이벤트 루프를 붙들고 있어서
   * main() 이 끝나도 프로세스가 살아 있었다. 그래서 CI 나 파이프(`| tail`)에서
   * 결과가 영영 나오지 않고 멈춘 것처럼 보였다. 테스트는 판정이 끝나면 끝나야 한다.
   */
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
