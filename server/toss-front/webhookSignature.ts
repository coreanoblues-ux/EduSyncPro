/**
 * 웹훅 서명 검증 (순수 함수).
 *
 * 왜 별도 모듈인가:
 *   webhooks.ts 는 db·express·schema 를 전부 끌어온다. 그 안에 검증 로직이 있으면
 *   테스트가 DB 를 띄워야 하고, 결국 아무도 테스트를 안 쓰게 된다. refund.ts·lifecycle.ts
 *   와 같은 방침 — 판정은 여기, 집행은 라우터.
 *
 * ── 2026-08-30 에 고친 것 ──
 *   예전 코드는 HMAC 결과를 **base64** 로 만들어 헤더 값과 비교했다. 토스플레이스
 *   공식 문서(reference/open-api/webhook.html)는 **hex 인코딩 + `v1=` 접두사** 다.
 *
 *     문서: "Message의 HMAC 결과를 hex 인코딩 후 v1= Prefix를 붙여
 *            x-toss-signature 웹훅 요청 HTTP Header에 설정합니다."
 *
 *   base64 문자열과 hex 문자열은 길이부터 다르므로(32바이트 → base64 44자 / hex 64자)
 *   `aBuf.length !== bBuf.length` 에서 무조건 false 가 났다. 즉 **모든 웹훅이 401** 이었고,
 *   webhooks.ts 주석대로 401 은 토스가 재발송을 멈추게 한다. 교정 경로가 통째로 죽어
 *   있었다는 뜻이다. 환불을 붙이기 전에 이걸 먼저 고쳐야 하는 이유가 그것이다 —
 *   취소 웹훅이 우리 장부에 영원히 도달하지 못한다.
 *
 * 메시지 구성은 원래도 맞았다: `${x-toss-timestamp}.${rawBody}` (UTF-8, 점 구분자).
 */

import crypto from "crypto";

/** 문서상 현재 유일한 서명 버전. 나중에 v2 가 생기면 여기에 추가한다. */
const SIGNATURE_PREFIX = "v1=";

export type SignatureCheck =
  | { valid: true; encoding: "hex" | "base64" }
  | { valid: false; reason: string };

/**
 * 헤더 값에서 실제 서명 문자열만 꺼낸다.
 *
 * 방어적으로 공백 분리 다중 서명(`v1=aaa v1=bbb`)도 받아 둔다. 문서에는 단일 서명만
 * 나오지만, 키 교체(rotation) 기간에 두 개를 함께 보내는 건 웹훅 설계의 흔한 관행이라
 * 언젠가 생겨도 우리 쪽이 조용히 401 을 내지 않게 한다.
 *
 * 접두사가 아예 없는 값도 그대로 후보에 넣는다. 문서와 다른 형태로 오더라도
 * "서명이 틀렸다" 가 아니라 "형식이 다르다" 로 끝나야 원인을 찾을 수 있다.
 */
export function parseSignatureHeader(header: string): string[] {
  return header
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => (part.startsWith(SIGNATURE_PREFIX) ? part.slice(SIGNATURE_PREFIX.length) : part))
    .filter((part) => part.length > 0);
}

/** 서명해야 할 메시지. 토스 문서: `${timestamp}.${rawBody}` (UTF-8). */
export function buildSignatureMessage(rawBody: string, timestamp: string): string {
  return `${timestamp}.${rawBody}`;
}

/**
 * 길이가 달라도 예외를 던지지 않는 상수시간 비교.
 *
 * timingSafeEqual 은 길이가 다르면 throw 한다. 그렇다고 길이를 먼저 비교하고 리턴하면
 * 길이 정보가 새는데, HMAC-SHA256 은 출력 길이가 고정(32바이트)이라 길이는 애초에
 * 비밀이 아니다. 그래서 길이 불일치는 그냥 false 로 끝낸다.
 */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * 서명을 검증한다.
 *
 * hex 를 먼저 본다 (문서 규격). 실패하면 base64 도 한 번 시도한다.
 *
 * ── base64 를 왜 아직 받아 주나 ──
 *   두 인코딩 모두 "같은 비밀키로 계산한 HMAC-SHA256" 을 표현한 것뿐이다. 비밀키가
 *   없으면 어느 쪽도 만들어 낼 수 없으므로 보안이 약해지지 않는다. 반면 얻는 게 있다 —
 *   실제 운영에서 어느 인코딩이 왔는지 반환값(`encoding`)으로 알 수 있다. 우리는 아직
 *   진짜 웹훅을 한 번도 성공적으로 받아 본 적이 없다. 문서와 실제가 다를 가능성을
 *   401 로 덮어 버리는 대신 로그로 남기고, 현장 데이터가 쌓이면 hex 로 좁힌다.
 *
 *   (base64 만 계속 관찰되면 문서가 틀린 것이고, hex 만 오면 이 분기를 지우면 된다.)
 */
export function verifyTossSignature(
  rawBody: string,
  timestamp: string,
  signatureHeader: string,
  secret: string
): SignatureCheck {
  if (!secret) {
    return { valid: false, reason: "TOSS_WEBHOOK_SECRET 미설정" };
  }
  if (!signatureHeader) {
    return { valid: false, reason: "x-toss-signature 헤더 없음" };
  }
  if (!timestamp) {
    return { valid: false, reason: "x-toss-timestamp 헤더 없음" };
  }

  const candidates = parseSignatureHeader(signatureHeader);
  if (candidates.length === 0) {
    return { valid: false, reason: "서명 헤더에서 값을 찾지 못함" };
  }

  const digest = crypto
    .createHmac("sha256", secret)
    .update(buildSignatureMessage(rawBody, timestamp), "utf8")
    .digest();

  for (const candidate of candidates) {
    // hex — 문서 규격. 대소문자를 가리지 않는다 (hex 는 대소문자 동치).
    if (/^[0-9a-fA-F]+$/.test(candidate)) {
      if (safeEqual(digest, Buffer.from(candidate, "hex"))) {
        return { valid: true, encoding: "hex" };
      }
    }
    // base64 — 관찰용 폴백. 위 주석 참고.
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(candidate)) {
      if (safeEqual(digest, Buffer.from(candidate, "base64"))) {
        return { valid: true, encoding: "base64" };
      }
    }
  }

  return { valid: false, reason: "서명 불일치" };
}

/**
 * 타임스탬프가 지금과 얼마나 벌어져 있는지(밀리초, 절댓값). 파싱 불가면 null.
 *
 * ⚠️ 이 값으로 **거절하지 않는다.** 왜인지가 중요하다:
 *
 *   1) 재전송 때 토스가 원래 타임스탬프를 그대로 다시 보내는지, 새로 찍는지 문서에
 *      명시가 없다. 원본을 재사용한다면 시간 창으로 자르는 순간 정상 재전송을
 *      우리가 막아 버린다. 재전송은 우리가 놓친 결제를 되찾는 마지막 경로다.
 *   2) 재생 공격(replay)은 이미 장부 층에서 막혀 있다. 승인은 payments 의 부분
 *      유니크 인덱스(external_payment_key, amount > 0)가 두 번째 삽입을 거부하고,
 *      취소는 webhookCancelAmount 가 "이미 적힌 만큼 빼고" 계산해서 0 이 나온다.
 *      서명을 통과한 재생 요청이라도 돈은 두 번 움직이지 않는다.
 *
 *   그래서 시간은 경고 로그로만 쓴다. 시계가 크게 어긋나 있다는 신호는 유용하지만,
 *   그걸 이유로 돈에 관한 메시지를 버리지는 않는다.
 */
export function signatureAgeMs(timestamp: string, now: number = Date.now()): number | null {
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.abs(now - parsed);
}

/** 이 이상 벌어지면 로그로 알린다 (거절하지 않는다). 15분. */
export const SIGNATURE_AGE_WARN_MS = 15 * 60 * 1000;
