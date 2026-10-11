/**
 * 학부모용 결과지 링크 — 토큰 규칙과 공개 페이지 그리기.
 *
 * 이 파일은 **이 시스템에서 유일하게 로그인 없이 열리는 화면**을 만든다.
 * 그래서 판단을 전부 여기 적어 둔다. 나중에 누가 "왜 이렇게 복잡한가" 하고
 * 단순화하려 할 때 읽을 수 있어야 한다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 왜 이 기능이 필요한가
 * ════════════════════════════════════════════════════════════════════════
 *   지금까지 결과지를 학부모에게 주는 방법은 A4 로 인쇄해 손에 들려 보내는
 *   것뿐이었다. 학원에 다시 오지 않는 학부모(= 등록을 망설이는 사람)에게는
 *   결과가 전달될 길이 아예 없었다. 등록 전환이 가장 아쉬운 사람에게 가장
 *   전달이 안 되는 구조였다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 이 문을 열면서 지킨 선
 * ════════════════════════════════════════════════════════════════════════
 * 1) **토큰 하나 = 결과지 한 장.** 토큰은 행 하나를 가리킨다. 학원 전체도,
 *    학생 한 명의 과거 기록 목록도 열리지 않는다. 토큰이 새어도 새는 것은
 *    그 한 장이다.
 *
 * 2) **보여 줄 것을 고른다(allowlist).** DB 행을 그대로 뿌리지 않고
 *    shareReport.ts 의 renderSharePage 가 쓰는 칸만 고른다. 특히
 *    **학부모 연락처(parentPhone) · 학교(school) · 상담 메모(notes) ·
 *    문항별 채점 상태(rawState) 는 내보내지 않는다.** 링크를 잘못 보냈을 때
 *    연락처가 같이 새는 것이 가장 되돌리기 어렵고, 상담 메모는 애초에
 *    교사용으로 적은 글이다(결과지에도 인쇄되지 않는다).
 *
 * 3) **쓰기가 없다.** 공개 경로에서 할 수 있는 유일한 쓰기는 "열어 본 횟수 +1"
 *    이다. 점수를 고치거나 다른 기록을 보는 입구는 없다.
 *
 * 4) **끝낼 수 있다.** 기한(기본 5일)이 지나면 저절로 닫히고, 원장이 직접
 *    끊을 수도 있다. "한 번 보낸 링크가 영원히 열려 있는" 상태를 만들지 않는다.
 *    그리고 발급 6개월 뒤에는 토큰 값 자체를 지운다(purgeExpiredShareTokens).
 *
 * 5) **검색에 안 걸린다.** noindex 헤더 + robots.txt. 카카오톡으로 보낸 링크가
 *    구글에 올라가는 일은 없어야 한다.
 *
 * 6) **토큰을 찍지 않는다.** 로그에 토큰이 남으면 로그를 보는 사람 전원이
 *    그 결과지를 열 수 있다. 이 파일은 토큰을 console 에 절대 내보내지 않는다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 왜 레벨테스트 앱(5.3MB HTML)을 재활용하지 않는가
 * ════════════════════════════════════════════════════════════════════════
 *   그 파일 안에는 **12개월치 문제와 정답**이 들어 있다. 로그인 없이 그걸
 *   내려받게 하면 시험지가 통째로 공개된다(server/level-test/routes.ts 가
 *   앱을 정적 폴더에 두지 않는 이유와 같다). 게다가 그 앱은 채점·수정 기능이
 *   달린 편집기다. 학부모에게 줄 것은 읽기 전용 한 장이므로, 서버가 직접
 *   작은 HTML 을 그린다. 휴대폰에서 1초 안에 열리는 것이 덤으로 따라온다.
 */

import crypto from "crypto";
import type { LevelTest } from "@shared/schema";

// ─── 토큰 ────────────────────────────────────────────────────────────────

/**
 * 공개 링크 토큰. 9바이트 난수 → base64url **12자**.
 *
 * ── 왜 12자인가 (43자에서 줄였다) ──
 *   학부모가 카카오톡으로 받는 주소를 짧게 하려고 줄였다. 9바이트는 3의
 *   배수라 base64url 로 바꾸면 패딩(=) 없이 정확히 12자가 나온다.
 *
 * ── 12자가 안전한가 ──
 *   64^12 = 2^72 ≈ 4.7 × 10^21 가지다. 봇이 하루 100만 번 찍고 링크가
 *   300개 살아 있다고 해도 하루에 맞출 확률이 10^-13 수준이다. 게다가
 *   아래 checkShareRate 가 한 IP 당 10분에 40번으로 끊는다. 실제로는
 *   무차별 시도 자체가 불가능하다.
 *
 *   **12자 아래로 더 줄이지 말 것.** 8자(2^48)까지 내려가면 위 계산이
 *   100만 분의 1 수준으로 올라와, 횟수 제한이 유일한 방어선이 된다.
 *
 * ── 왜 base64url 인가 ──
 *   카카오톡·문자에서 링크가 잘리지 않는다 (+, / 가 들어가면 메신저가
 *   주소 끝을 잘못 잡는 경우가 있다).
 */
const SHARE_TOKEN_BYTES = 9;
export const SHARE_TOKEN_LENGTH = 12; // = ceil(9/3)*4, 패딩 없음

export function generateShareToken(): string {
  return crypto.randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

/** 주소에서 온 문자열이 우리가 발급한 모양인가. DB 조회 전에 끊는다. */
export function isWellFormedShareToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    new RegExp(`^[A-Za-z0-9_-]{${SHARE_TOKEN_LENGTH}}$`).test(token)
  );
}

/**
 * 기본 유효 기간. **5일.**
 *
 * ── 왜 이렇게 짧은가 ──
 *   레벨테스트 결과는 등록 여부가 며칠 안에 갈리는 자료다. 길게 열어 두면
 *   그만큼 "학부모 휴대폰 안에 열려 있는 점수" 가 오래 남는다. 5일이 지나
 *   학부모가 다시 누르면 "학원으로 연락 주세요" 안내가 뜨고, 원장이 버튼
 *   한 번으로 다시 보내 줄 수 있다. 그 전화는 손해가 아니라 상담 기회다.
 *
 *   원장이 필요하면 발급할 때 days 로 1~180 사이를 지정할 수 있다
 *   (shareRoutes.ts). 기본값만 5일이다.
 */
export const SHARE_DEFAULT_DAYS = 5;

export function shareExpiryFrom(now: Date, days: number = SHARE_DEFAULT_DAYS): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * 만료된 토큰을 DB 에서 아예 지우는 기준. **발급일로부터 180일(6개월).**
 *
 * ── 만료와 파기는 다르다 ──
 *   · 만료(5일): 학부모가 눌러도 안 열린다. 토큰은 DB 에 남아 있다.
 *   · 파기(6개월): 토큰 값 자체를 NULL 로 지운다. 죽은 주소를 보관하지 않는다.
 *
 *   학부모 입장에서는 5일 뒤 이미 못 본다. 파기는 "우리 DB 에 쓸모없는
 *   주소를 쌓아 두지 않는다" 는 추가 조치다.
 *
 * ── 왜 6개월이나 두는가 ──
 *   "그 학생에게 결과지를 보냈다" 는 사실은 상담 이력이다. 보낸 날짜와
 *   열어 본 횟수는 **지우지 않고 남긴다** — 비밀이 아니고 원장에게 쓸모가
 *   있다. 지우는 것은 토큰 한 칸뿐이다.
 *
 * ── 솔직한 한계 ──
 *   Railway 자동 백업에는 남는다. "완전 파기" 가 아니다. 다만 지금 DB 가
 *   유출될 경우의 노출은 실제로 줄어든다.
 */
export const SHARE_PURGE_DAYS = 180;

/** 파기 기준 시각. 이 시각보다 먼저 발급된 링크의 토큰을 지운다. */
export function sharePurgeCutoff(
  now: Date = new Date(),
  days: number = SHARE_PURGE_DAYS
): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export type ShareState = "active" | "expired" | "revoked" | "none";

/** 지금 이 기록의 링크가 어떤 상태인가. 화면과 공개 주소가 같은 함수를 쓴다. */
export function shareState(
  row: Pick<LevelTest, "shareToken" | "shareExpiresAt" | "shareRevokedAt">,
  now: Date = new Date()
): ShareState {
  if (!row.shareToken) return "none";
  if (row.shareRevokedAt) return "revoked";
  if (row.shareExpiresAt && new Date(row.shareExpiresAt).getTime() <= now.getTime()) {
    return "expired";
  }
  return "active";
}

// ─── 횟수 제한 ───────────────────────────────────────────────────────────

/**
 * IP 당 공개 주소 호출 횟수 제한.
 *
 * ── 왜 메모리에 두는가 ──
 *   이 서버는 Railway 인스턴스 한 대다. 외부 저장소(Redis)를 새로 들이면
 *   "그게 죽으면 결과지가 안 열린다" 는 새 고장 지점이 생긴다. 재시작하면
 *   초기화되는데, 그건 이 용도에서 문제가 아니다 — 막으려는 것은 지속적인
 *   무차별 긁기이고, 재시작은 공격자가 일으킬 수 없다.
 *
 * ── 왜 숫자가 이렇게 느슨한가 ──
 *   한 가족이 같은 집 와이파이에서 여러 번 열어 보는 것을 막으면 안 된다.
 *   40회/10분은 정상 사용의 수십 배이면서, 긁기에는 전혀 쓸모없는 속도다.
 */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 40;
const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkShareRate(ip: string, now: number = Date.now()): boolean {
  const b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  b.count++;
  return b.count <= RATE_MAX;
}

/**
 * 오래된 칸을 치운다. 이걸 안 하면 Map 이 IP 수만큼 끝없이 커진다
 * (몇 달 도는 서버에서 조용히 메모리를 먹는 전형적인 자리다).
 */
export function sweepShareRate(now: number = Date.now()): void {
  for (const [ip, b] of Array.from(buckets.entries())) {
    if (b.resetAt <= now) buckets.delete(ip);
  }
}

/** 테스트에서 상태를 비운다. 운영 코드에서는 쓰지 않는다. */
export function __resetShareRateForTest(): void {
  buckets.clear();
}

// ─── HTML 그리기 ─────────────────────────────────────────────────────────

/**
 * HTML 이스케이프.
 *
 * 학생 이름과 선생님 메모는 원장·강사가 **자유롭게 타이핑한 글**이다.
 * 메모에 `<script>` 를 적을 사람은 없겠지만, 믿음이 아니라 구조로 막아야 한다.
 * 앞으로 이 페이지에 칸을 더할 때도 반드시 이 함수를 통과시킨다.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 2026-10-11 → 2026년 10월 11일. 학부모가 읽는 화면이라 한국어로 적는다. */
export function formatKoreanDate(ymd: string | Date | null | undefined): string {
  if (!ymd) return "";
  const s = typeof ymd === "string" ? ymd : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일`;
  const d = new Date(ymd as any);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/**
 * 공개 주소에서 안 열릴 때 보여 주는 안내.
 *
 * ── 왜 "만료" 와 "없는 주소" 를 구별해 알려 주는가 ──
 *   보안상 보통은 구별해 주지 않는 게 원칙이다. 하지만 여기서 구별이 새는
 *   정보는 "이 12자 난수가 한때 존재했다" 뿐이고, 그 난수를 이미 손에 쥔
 *   사람에게는 알려 줄 게 없다. 반대로 구별해 주지 않으면 학부모가
 *   "주소를 잘못 눌렀나" 하고 원장에게 전화한다. 그 전화가 실제 비용이다.
 */
export function renderShareError(kind: "expired" | "revoked" | "notfound" | "ratelimited"): string {
  const message = {
    expired: {
      title: "링크 사용 기간이 지났습니다",
      body: "결과지 링크는 일정 기간이 지나면 닫힙니다.<br>학원으로 연락 주시면 다시 보내 드리겠습니다.",
    },
    revoked: {
      title: "닫힌 링크입니다",
      body: "이 결과지 링크는 학원에서 닫았습니다.<br>학원으로 연락 주시면 안내해 드리겠습니다.",
    },
    notfound: {
      title: "결과지를 찾을 수 없습니다",
      body: "주소가 잘못되었거나 링크가 변경되었습니다.<br>받으신 메시지의 링크를 다시 확인해 주세요.",
    },
    ratelimited: {
      title: "잠시 후 다시 시도해 주세요",
      body: "짧은 시간에 너무 많이 열었습니다.<br>10분 뒤에 다시 눌러 주세요.",
    },
  }[kind];

  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(message.title)}</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","맑은 고딕",sans-serif;
      padding:24px;box-sizing:border-box}
 .box{background:#fff;border-radius:16px;padding:32px 24px;max-width:420px;text-align:center;
      box-shadow:0 1px 3px rgba(0,0,0,.08)}
 h1{font-size:19px;margin:0 0 12px;color:#37373A}
 p{font-size:15px;line-height:1.7;color:#666;margin:0}
</style></head>
<body><div class="box">
 <h1>${escapeHtml(message.title)}</h1>
 <p>${message.body}</p>
</div></body></html>`;
}

/**
 * ── 학부모가 보는 결과지 HTML 은 여기 없다 ──
 *
 *   server/lib/shareReport.ts 가 그린다(renderSharePage).
 *
 *   왜 갈랐나: 그 페이지는 원장이 인쇄하는 **2페이지 결과지와 같은 내용**
 *   (진단 + 12개월 커리큘럼)을 그려야 해서, 커리큘럼 문구 묶음과 단계 계산이
 *   붙는다. 이 파일은 토큰 규칙·만료·횟수 제한처럼 "문을 여닫는 규칙" 만
 *   담당한다. 섞어 두면 어느 쪽을 고치다 다른 쪽을 깨뜨리기 쉽다.
 *
 *   방향은 한쪽이다: shareReport → shareLink (esc·날짜 함수를 가져간다).
 *   이 파일에서 shareReport 를 import 하면 서로 물려 버린다. 하지 말 것.
 */
