/**
 * 통화 상담 자동 등록(/api/call-intake) 검증. `npm run test:call-intake`
 *
 * ════════════════════════════════════════════════════════════════════════
 * 무엇을 못 박는가
 * ════════════════════════════════════════════════════════════════════════
 *   이 경로는 **학부모 통화 녹음**이 지나가는 길이다. 기능이 틀리면 상담이
 *   안 적히는 정도지만, 규칙이 무너지면 통화 내용이 디스크·로그에 남는다.
 *   그래서 세 묶음을 본다:
 *     · 문이 잠겨 있는가 — 토큰도 로그인도 없으면 401, 틀린 토큰도 401
 *     · 규칙이 지켜지는가 — memoryStorage 만, 전사 텍스트 로그 금지,
 *       응답 전 버퍼 해제, needsReview=true 저장 (코드 모양 고정)
 *     · 시간 해석이 맞는가 — "모레 오후 5시" 를 트리거 시점 기준 절대
 *       날짜로 바꾸는 규칙이 프롬프트에 들어 있는가
 *
 *   OpenAI 를 실제로 부르는 테스트는 없다 — 돈이 들고 네트워크가 필요해
 *   매번 돌 수 없다. 대신 그 직전(인증·크기·키 확인)까지 실제 서버를
 *   띄워 두드리고, 호출부는 코드 모양으로 고정한다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { kstNowLabel, buildExtractionPrompt } from "../server/call-intake/routes";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}\n`);
  }
}

/**
 * 주석을 떼고 실제 코드만 남긴다 (설명문이 금지어 검사에 걸리지 않게).
 * ⚠️ call-intake 소스에는 쓰지 않는다 — 코드 속 "audio/*" 문자열이 블록 주석
 * 시작으로 잘못 읽혀 multer 설정부가 통째로 지워진다. 그 파일은 원문으로
 * 검사한다 (금지어들이 주석에 없음을 전제로 — 주석에 diskStorage 같은 말을
 * 적으면 이 테스트가 틀리게 실패하니 적지 말 것).
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const intakeSrc = readFileSync(join(process.cwd(), "server", "call-intake", "routes.ts"), "utf8");
const intakeCode = intakeSrc;
const serverRoutesSrc = readFileSync(join(process.cwd(), "server", "routes.ts"), "utf8");
const schemaSrc = readFileSync(join(process.cwd(), "shared", "schema.ts"), "utf8");
const pkgSrc = readFileSync(join(process.cwd(), "package.json"), "utf8");
const migrateSrc = readFileSync(
  join(process.cwd(), "scripts", "migrate-add-call-intake.ts"),
  "utf8"
);
const uiSrc = readFileSync(
  join(process.cwd(), "client", "src", "pages", "Consultations.tsx"),
  "utf8"
);

async function main() {
  console.log("\n통화 상담 자동 등록 테스트\n");

  /* ── 시간 해석 ──────────────────────────────────────────────────────── */
  console.log("기준 시각(KST) 계산:");

  await test("UTC 05:30 → 한국 14:30, 요일 포함", () => {
    assert.equal(kstNowLabel(new Date("2026-10-19T05:30:00Z")), "2026-10-19 (월) 14:30");
  });

  await test("UTC 저녁은 한국에서 다음날 — 날짜가 넘어간다", () => {
    assert.equal(kstNowLabel(new Date("2026-10-19T16:05:00Z")), "2026-10-20 (화) 01:05");
  });

  console.log("\n추출 프롬프트 (상대 날짜·예약 시간 규칙):");

  const prompt = buildExtractionPrompt("2026-10-19 (월) 14:30");

  await test("트리거(흔들기) 시점이 기준으로 박힌다", () => {
    assert.ok(prompt.includes("2026-10-19 (월) 14:30"), "지금 시각이 프롬프트에 없습니다");
  });

  await test("'모레 오후 5시' → 절대 날짜 예시가 들어 있다 (수요일 17:00)", () => {
    assert.ok(prompt.includes("모레 오후 5시"), "상대 날짜 예시가 없습니다");
    assert.ok(prompt.includes("2026-10-21 (수) 17:00"), "절대 날짜 변환 예시가 없습니다");
  });

  await test("평일 예약 규칙: 오전 없음, 오후 4시~10시", () => {
    assert.ok(prompt.includes("평일"), "평일 규칙이 없습니다");
    assert.ok(prompt.includes("오전 예약 없음"), "'오전 예약 없음' 이 없습니다");
    assert.ok(prompt.includes("오후 4시") && prompt.includes("오후 10시"), "평일 시간대가 없습니다");
  });

  await test("주말 예약 규칙: 오전 9시~오후 6시 이전", () => {
    assert.ok(prompt.includes("주말"), "주말 규칙이 없습니다");
    assert.ok(prompt.includes("오전 9시") && prompt.includes("오후 6시"), "주말 시간대가 없습니다");
  });

  await test("지역 학교 목록으로 전사 오류를 교정하게 한다", () => {
    assert.ok(prompt.includes("봉선중") && prompt.includes("숭의중"), "학교 목록이 없습니다");
  });

  await test("전화번호는 AI가 '듣고' 적지 않는다 (요청에서 받음)", () => {
    assert.ok(prompt.includes("전화번호는 추출하지 마십시오"), "번호 추출 금지문이 없습니다");
  });

  await test("불확실하면 null — 추측 금지가 명시돼 있다", () => {
    assert.ok(prompt.includes("추측하지 마십시오"), "추측 금지문이 없습니다");
  });

  /* ── 코드 모양 고정 (규칙 위반 감지) ──────────────────────────────────── */
  console.log("\n규칙 고정 (녹음 파일·개인정보 보호):");

  await test("multer 는 memoryStorage 만 — 디스크 저장 경로가 없다", () => {
    assert.ok(intakeCode.includes("memoryStorage()"), "memoryStorage 가 없습니다");
    assert.ok(!intakeCode.includes("diskStorage"), "diskStorage 가 생겼습니다 — 녹음 파일 디스크 저장 금지");
    assert.ok(!/dest\s*:/.test(intakeCode), "multer dest 옵션이 생겼습니다 — 디스크 저장 금지");
    assert.ok(!intakeCode.includes("writeFile"), "파일 쓰기가 생겼습니다 — 녹음 파일 저장 금지");
  });

  await test("응답 전에 오디오 버퍼 참조를 끊는다 (buf = null)", () => {
    assert.ok(/buf\s*=\s*null/.test(intakeCode), "버퍼 해제(buf = null)가 없습니다");
  });

  await test("전사 텍스트(transcript)를 로그에 적지 않는다", () => {
    const logs = intakeCode.match(/console\.(log|error|warn)\([^;]*\)/g) ?? [];
    for (const l of logs) {
      assert.ok(!l.includes("transcript"), `로그에 전사 텍스트가 들어갑니다: ${l.slice(0, 80)}`);
    }
  });

  await test("저장은 항상 needsReview=true (원장 확인 필요 표시)", () => {
    const hits = intakeCode.match(/needsReview:\s*true/g) ?? [];
    assert.ok(hits.length >= 2, "생성·갱신 양쪽에 needsReview: true 가 있어야 합니다");
  });

  await test("토큰 비교는 timingSafeEqual (글자별 시간차 공격 방지)", () => {
    assert.ok(intakeCode.includes("timingSafeEqual"), "timingSafeEqual 이 없습니다");
  });

  await test("인증(intakeAuth)이 본문 파싱보다 먼저다", () => {
    assert.ok(/intakeAuth,\s*rawBody/.test(intakeCode), "인증이 본문 파싱 앞에 있어야 합니다");
  });

  await test("음성인식 모델은 환경변수로 바꿀 수 있고 whisper-1 로 재시도한다", () => {
    assert.ok(intakeCode.includes("TRANSCRIBE_MODEL"), "TRANSCRIBE_MODEL 환경변수가 없습니다");
    assert.ok(intakeCode.includes("gpt-4o-mini-transcribe"), "기본 모델이 없습니다");
    assert.ok(intakeCode.includes('"whisper-1"'), "whisper-1 재시도가 없습니다");
  });

  /* ── 배선 확인 ──────────────────────────────────────────────────────── */
  console.log("\n배선 (라우터·스키마·화면):");

  await test("server/routes.ts 가 callIntakeRouter 를 마운트한다", () => {
    assert.ok(serverRoutesSrc.includes('from "./call-intake/routes"'), "import 가 없습니다");
    assert.ok(serverRoutesSrc.includes("app.use(callIntakeRouter)"), "app.use 가 없습니다");
  });

  await test("consultations 에 needs_review 칼럼이 있다", () => {
    assert.ok(/needsReview:\s*boolean\("needs_review"\)/.test(schemaSrc), "스키마에 칼럼이 없습니다");
  });

  await test("마이그레이션은 ADD COLUMN IF NOT EXISTS (여러 번 돌려도 안전)", () => {
    assert.ok(migrateSrc.includes("ADD COLUMN IF NOT EXISTS"), "IF NOT EXISTS 가 아닙니다");
    assert.ok(migrateSrc.includes("needs_review"), "needs_review 가 없습니다");
    assert.ok(!stripComments(migrateSrc).includes("DROP"), "마이그레이션에 DROP 이 있습니다");
  });

  await test("npm 스크립트 (db:migrate:call-intake, test:call-intake)", () => {
    assert.ok(pkgSrc.includes('"db:migrate:call-intake"'), "마이그레이션 스크립트가 없습니다");
    assert.ok(pkgSrc.includes('"test:call-intake"'), "테스트 스크립트가 없습니다");
  });

  await test("상담 화면: 확인 필요 배지 + 확인 완료 버튼 + 직접 업로드", () => {
    assert.ok(uiSrc.includes("확인 필요"), "배지 글자가 없습니다");
    assert.ok(/needsReview:\s*false/.test(uiSrc), "확인 완료(needsReview:false PATCH)가 없습니다");
    assert.ok(uiSrc.includes("/api/call-intake"), "웹앱 직접 업로드 경로가 없습니다");
    assert.ok(uiSrc.includes('credentials: "include"'), "로그인 쿠키 전송(credentials)이 없습니다");
  });

  /* ── 실제 서버를 띄워 문단속 ──────────────────────────────────────────── */
  await testRoutes();

  console.log(`\n결과: 통과 ${passed} · 실패 ${failed}\n`);
  if (failed > 0) process.exit(1);
}

async function testRoutes() {
  console.log("\n문단속 (실제 요청):");

  // OpenAI 를 절대 부르지 않도록 키를 비운다. (.env 가 로드돼 있어도)
  delete process.env.OPENAI_API_KEY;
  const TOKEN = "test-intake-token-0123456789abcdef";

  const express = (await import("express")).default;
  const { default: callIntakeRouter } = await import("../server/call-intake/routes");
  const { storage } = await import("../server/storage");

  const app = express();
  app.use(callIntakeRouter);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const url = `${base}/api/call-intake`;

  const audio = (bytes: number) => ({
    method: "POST",
    headers: { "content-type": "audio/mpeg", "x-intake-token": TOKEN },
    body: Buffer.alloc(bytes, 1),
  });

  await test("토큰도 로그인도 없으면 401", async () => {
    delete process.env.CALL_INTAKE_TOKEN;
    const r = await fetch(url, { method: "POST" });
    assert.equal(r.status, 401, `401 이어야 하는데 ${r.status} — 통화 녹음 경로가 열려 있습니다`);
  });

  await test("틀린 토큰도 401 (쿠키 인증으로 넘어가 거절)", async () => {
    process.env.CALL_INTAKE_TOKEN = TOKEN;
    const r = await fetch(url, { method: "POST", headers: { "x-intake-token": "wrong-token" } });
    assert.equal(r.status, 401, `401 이어야 하는데 ${r.status}`);
  });

  await test("토큰이 맞아도 CALL_INTAKE_OWNER_EMAIL 이 없으면 503", async () => {
    delete process.env.CALL_INTAKE_OWNER_EMAIL;
    const r = await fetch(url, { method: "POST", headers: { "x-intake-token": TOKEN } });
    assert.equal(r.status, 503, `503 이어야 하는데 ${r.status}`);
  });

  await test("설정된 원장 계정을 못 찾으면 503", async () => {
    process.env.CALL_INTAKE_OWNER_EMAIL = "owner@test.local";
    (storage as any).getUserByEmail = async () => undefined;
    const r = await fetch(url, { method: "POST", headers: { "x-intake-token": TOKEN } });
    assert.equal(r.status, 503, `503 이어야 하는데 ${r.status}`);
  });

  // 이후 테스트: 원장 계정이 있다고 가정 (DB 없이 돌리기 위한 대역)
  (storage as any).getUserByEmail = async () => ({
    id: "u-test",
    email: "owner@test.local",
    name: "원장",
    role: "owner",
    tenantId: "t-test",
    isActive: true,
  });

  await test("인증은 됐지만 오디오가 없으면 400", async () => {
    const r = await fetch(url, { method: "POST", headers: { "x-intake-token": TOKEN } });
    assert.equal(r.status, 400, `400 이어야 하는데 ${r.status}`);
  });

  await test("1KB 미만(깨진 파일)도 400", async () => {
    const r = await fetch(url, audio(100) as any);
    assert.equal(r.status, 400, `400 이어야 하는데 ${r.status}`);
  });

  await test("25MB 초과는 413 (음성인식으로 보내기 전에 거절)", async () => {
    const r = await fetch(url, audio(26 * 1024 * 1024) as any);
    assert.equal(r.status, 413, `413 이어야 하는데 ${r.status}`);
  });

  await test("OPENAI_API_KEY 가 없으면 503 (밖으로 나가기 전에 멈춤)", async () => {
    const r = await fetch(url, audio(2048) as any);
    assert.equal(r.status, 503, `503 이어야 하는데 ${r.status}`);
    const j = (await r.json()) as any;
    assert.ok(String(j.error).includes("OPENAI_API_KEY"), "원인이 응답에 안 적혀 있습니다");
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
