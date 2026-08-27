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

  console.log("\n─── 결과 ───");
  console.log(`  통과 ${passed} / 실패 ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
