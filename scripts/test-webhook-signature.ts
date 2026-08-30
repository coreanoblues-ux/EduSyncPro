/**
 * 웹훅 서명 검증 테스트.
 *
 * 왜 이 테스트가 필요한가:
 *   이 코드는 2026-08-30 까지 **한 번도 성공한 적이 없었다.** base64 로 계산해서
 *   hex 헤더와 비교했으니 모든 웹훅이 401 이었고, 401 은 토스가 재발송을 멈추게 한다.
 *   즉 "결제 확정 유실 보완"과 "취소 반영" 이라는 두 교정 경로가 통째로 죽어 있었는데
 *   아무도 몰랐다. 테스트가 없으면 다음에 또 모른다.
 *
 *   그래서 여기서는 **토스 문서 그대로** 서명을 만들어서 넣는다. 우리 함수가
 *   우리 함수와 일치하는지가 아니라, 문서와 일치하는지를 본다.
 */

import crypto from "crypto";
import {
  SIGNATURE_AGE_WARN_MS,
  buildSignatureMessage,
  parseSignatureHeader,
  signatureAgeMs,
  verifyTossSignature,
} from "../server/toss-front/webhookSignature";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n── ${title} ──`);
}

const SECRET = "whsec_test_0123456789abcdef";
const BODY = JSON.stringify({
  type: "payment.payment.cancelled.v1",
  merchantId: "614624",
  data: {
    payment: {
      id: "tf_abcdef0123456789",
      orderId: "TF-20260830-a1b2c3d4",
      state: "CANCELED",
      amount: 1000,
      approvedAt: "2026-08-30T01:00:00.000Z",
      cancelledAt: "2026-08-30T02:00:00.000Z",
    },
  },
});
const TS = String(Date.now());

/** 토스 문서가 기술한 방식 그대로 서명을 만든다. 이게 이 테스트의 기준점이다. */
function signLikeToss(body: string, timestamp: string, secret: string): string {
  const hex = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("hex");
  return `v1=${hex}`;
}

// ───────────────────────────────────────────────────────────────────────
section("문서 규격 (hex + v1= 접두사)");

{
  const header = signLikeToss(BODY, TS, SECRET);
  const r = verifyTossSignature(BODY, TS, header, SECRET);
  check("문서대로 만든 서명이 통과한다", r.valid === true);
  check("인코딩이 hex 로 보고된다", r.valid === true && r.encoding === "hex");
  check(
    "헤더 길이가 hex 규격(v1= + 64자)이다",
    header.length === 3 + 64,
    `실제 ${header.length}자`
  );
}

{
  // 접두사 없이 hex 만 온 경우도 받아 준다 (문서와 다르게 오는 환경 대비).
  const hex = crypto.createHmac("sha256", SECRET).update(`${TS}.${BODY}`, "utf8").digest("hex");
  const r = verifyTossSignature(BODY, TS, hex, SECRET);
  check("v1= 접두사가 없어도 hex 면 통과한다", r.valid === true);
}

{
  // hex 는 대소문자 동치.
  const hex = crypto.createHmac("sha256", SECRET).update(`${TS}.${BODY}`, "utf8").digest("hex");
  const r = verifyTossSignature(BODY, TS, `v1=${hex.toUpperCase()}`, SECRET);
  check("대문자 hex 도 통과한다", r.valid === true);
}

// ───────────────────────────────────────────────────────────────────────
section("옛 구현이 만들던 base64 (관찰용 폴백)");

{
  const b64 = crypto.createHmac("sha256", SECRET).update(`${TS}.${BODY}`, "utf8").digest("base64");
  const r = verifyTossSignature(BODY, TS, b64, SECRET);
  check("base64 서명도 통과한다", r.valid === true);
  check("인코딩이 base64 로 보고된다", r.valid === true && r.encoding === "base64");
  check("base64 는 44자다 (hex 64자와 길이가 다르다)", b64.length === 44, `실제 ${b64.length}자`);
}

// ───────────────────────────────────────────────────────────────────────
section("위조·오설정은 반드시 막는다");

{
  const header = signLikeToss(BODY, TS, "wrong_secret");
  const r = verifyTossSignature(BODY, TS, header, SECRET);
  check("다른 시크릿으로 만든 서명은 거절된다", r.valid === false);
}

{
  const header = signLikeToss(BODY, TS, SECRET);
  const tampered = JSON.stringify({ ...JSON.parse(BODY), merchantId: "999999" });
  const r = verifyTossSignature(tampered, TS, header, SECRET);
  check("본문이 한 글자라도 바뀌면 거절된다", r.valid === false);
}

{
  const header = signLikeToss(BODY, TS, SECRET);
  const r = verifyTossSignature(BODY, String(Number(TS) + 1), header, SECRET);
  check("타임스탬프가 바뀌면 거절된다 (서명 메시지에 포함되므로)", r.valid === false);
}

{
  const header = signLikeToss(BODY, TS, SECRET);
  const r = verifyTossSignature(BODY, TS, header, "");
  check("시크릿 미설정이면 거절된다", r.valid === false);
  check(
    "거절 사유가 '불일치'가 아니라 '미설정'으로 구분된다",
    r.valid === false && r.reason.includes("미설정"),
    r.valid === false ? r.reason : ""
  );
}

{
  const r = verifyTossSignature(BODY, TS, "", SECRET);
  check("서명 헤더가 비어 있으면 거절된다", r.valid === false);
}

{
  const r = verifyTossSignature(BODY, "", signLikeToss(BODY, TS, SECRET), SECRET);
  check("타임스탬프 헤더가 없으면 거절된다", r.valid === false);
}

{
  const r = verifyTossSignature(BODY, TS, "v1=", SECRET);
  check("접두사만 있고 값이 없으면 거절된다", r.valid === false);
}

{
  const r = verifyTossSignature(BODY, TS, "v1=zzzz!!!not-hex-or-base64", SECRET);
  check("hex 도 base64 도 아닌 쓰레기는 거절된다 (예외 없이)", r.valid === false);
}

{
  // 길이만 맞춘 0 채움 공격.
  const r = verifyTossSignature(BODY, TS, `v1=${"0".repeat(64)}`, SECRET);
  check("길이만 맞춘 0 서명은 거절된다", r.valid === false);
}

{
  // 짧은 서명 조각 — timingSafeEqual 이 예외를 던지면 500 이 나가고 토스가 재전송한다.
  // 반드시 조용히 false 여야 한다.
  let threw = false;
  let r: ReturnType<typeof verifyTossSignature> | null = null;
  try {
    r = verifyTossSignature(BODY, TS, "v1=ab", SECRET);
  } catch {
    threw = true;
  }
  check("길이가 짧은 서명에서 예외가 나지 않는다", !threw);
  check("그리고 거절된다", r !== null && r.valid === false);
}

// ───────────────────────────────────────────────────────────────────────
section("헤더 파싱");

{
  check("v1= 접두사를 떼어 낸다", parseSignatureHeader("v1=abc")[0] === "abc");
  check("접두사 없는 값은 그대로 둔다", parseSignatureHeader("abc")[0] === "abc");
  check(
    "공백 구분 다중 서명을 모두 꺼낸다 (키 교체 대비)",
    parseSignatureHeader("v1=aaa v1=bbb").join(",") === "aaa,bbb"
  );
  check("앞뒤 공백을 무시한다", parseSignatureHeader("  v1=abc  ")[0] === "abc");
  check("빈 문자열은 빈 배열", parseSignatureHeader("").length === 0);
}

{
  // 키 교체 상황: 두 개 중 하나만 우리 시크릿과 맞아도 통과해야 한다.
  const good = crypto.createHmac("sha256", SECRET).update(`${TS}.${BODY}`, "utf8").digest("hex");
  const bad = crypto.createHmac("sha256", "other").update(`${TS}.${BODY}`, "utf8").digest("hex");
  check(
    "다중 서명 중 하나만 맞아도 통과한다 (틀린 것이 앞)",
    verifyTossSignature(BODY, TS, `v1=${bad} v1=${good}`, SECRET).valid === true
  );
  check(
    "둘 다 틀리면 거절된다",
    verifyTossSignature(BODY, TS, `v1=${bad} v1=${bad}`, SECRET).valid === false
  );
}

// ───────────────────────────────────────────────────────────────────────
section("메시지 구성");

{
  check(
    "메시지는 timestamp.rawBody 형태다",
    buildSignatureMessage("{\"a\":1}", "1756512000000") === "1756512000000.{\"a\":1}"
  );
  // 파싱 후 재직렬화하면 서명이 깨진다는 사실을 고정해 둔다.
  //
  // 키 순서로는 이걸 보일 수 없다 — V8 은 문자열 키의 삽입 순서를 보존하므로
  // {"b":2,"a":1} 은 재직렬화해도 그대로다. 실제로 깨지는 건 **공백**이다.
  // 토스가 보내는 본문에 들여쓰기나 키 뒤 공백이 하나라도 있으면 재직렬화 순간
  // 서명이 어긋난다. express.json({ verify }) 로 rawBody 를 따로 보관하는 이유.
  const raw = '{"a": 1, "b": 2}';
  const reserialized = JSON.stringify(JSON.parse(raw));
  const header = signLikeToss(raw, TS, SECRET);
  check("원문 대신 재직렬화한 본문을 쓰면 실패한다 (rawBody 를 써야 하는 이유)",
    reserialized !== raw && verifyTossSignature(reserialized, TS, header, SECRET).valid === false);
  check("원문 그대로면 통과한다", verifyTossSignature(raw, TS, header, SECRET).valid === true);
}

// ───────────────────────────────────────────────────────────────────────
section("타임스탬프 나이 (경고용, 거절하지 않음)");

{
  const now = 1_756_512_000_000;
  check("같은 시각이면 0", signatureAgeMs(String(now), now) === 0);
  check("1분 전이면 60000", signatureAgeMs(String(now - 60_000), now) === 60_000);
  check("미래여도 절댓값으로 잰다", signatureAgeMs(String(now + 60_000), now) === 60_000);
  check("숫자가 아니면 null", signatureAgeMs("not-a-number", now) === null);
  check("빈 문자열이면 null", signatureAgeMs("", now) === null);
  check("경고 기준은 15분", SIGNATURE_AGE_WARN_MS === 15 * 60 * 1000);

  // 가장 중요한 성질: 오래된 타임스탬프여도 서명 자체는 여전히 유효하다.
  // (재전송을 우리가 막아 버리면 안 된다.)
  const oldTs = String(now - 24 * 60 * 60 * 1000);
  const header = signLikeToss(BODY, oldTs, SECRET);
  check(
    "하루 지난 타임스탬프의 서명도 검증은 통과한다 (재전송을 막지 않기 위해)",
    verifyTossSignature(BODY, oldTs, header, SECRET).valid === true
  );
}

// ───────────────────────────────────────────────────────────────────────
section("현장 시나리오: 1,000원 취소 웹훅");

{
  // 3단계에서 실제로 받게 될 모양. 여기서 미리 통과시켜 둔다.
  const body = JSON.stringify({
    type: "payment.payment.cancelled.v1",
    merchantId: "614624",
    data: {
      payment: {
        id: "tf_1000won_test",
        orderId: "TF-20260830-deadbeef",
        state: "CANCELED",
        amount: 1000,
        cancelledAt: "2026-08-30T05:00:00.000Z",
      },
    },
  });
  const ts = String(Date.now());
  const header = signLikeToss(body, ts, SECRET);
  const r = verifyTossSignature(body, ts, header, SECRET);
  check("1,000원 취소 웹훅 서명이 통과한다", r.valid === true);

  // 그리고 옛 구현이었다면 실패했다는 것도 함께 고정한다 (회귀 방지).
  const oldStyleExpected = crypto
    .createHmac("sha256", SECRET)
    .update(`${ts}.${body}`, "utf8")
    .digest("base64");
  const oldWouldMatch =
    Buffer.from(oldStyleExpected, "base64").length ===
    Buffer.from(header.slice(3), "base64").length;
  check("옛 base64 구현으로는 길이조차 맞지 않았다 (버그 재현)", oldWouldMatch === false);
}

// ───────────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`✅ 통과 ${passed} · 실패 ${failed}`);
console.log("═".repeat(50));
if (failed > 0) process.exitCode = 1;
