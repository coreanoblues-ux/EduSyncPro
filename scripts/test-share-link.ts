/**
 * 학부모용 결과지 링크 검증. `npm run test:share`
 *
 * ════════════════════════════════════════════════════════════════════════
 * 이 테스트가 왜 다른 것보다 깐깐한가
 * ════════════════════════════════════════════════════════════════════════
 *   /r/:token 은 이 시스템에서 **유일하게 로그인 없이 열리는 경로**다. 다른
 *   기능이 틀리면 원장이 화면에서 이상한 숫자를 본다. 이 기능이 틀리면
 *   남의 아이 성적이나 학부모 연락처가 바깥으로 나간다. 되돌릴 수 없다.
 *
 *   그래서 "동작하는가" 만 보지 않고 **"새면 안 되는 것이 안 새는가"** 를
 *   같이 못 박는다. 아래 두 묶음이 그것이다:
 *     · 개인정보 비노출 — 연락처·학교·상담id·원본 상태가 HTML 에 없다
 *     · 코드 모양 고정 — 공개 라우트에 인증이 붙거나 빠지는 변화를 잡는다
 *
 *   코드 모양을 글자로 확인하는 것이 투박해 보이지만, 여기서는 그게 맞다.
 *   서버를 띄워 실제 요청을 보내는 테스트는 DB 가 필요해 매번 돌릴 수 없고,
 *   매번 돌지 않는 보안 테스트는 없는 것과 같다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateShareToken,
  isWellFormedShareToken,
  shareExpiryFrom,
  shareState,
  checkShareRate,
  sweepShareRate,
  __resetShareRateForTest,
  escapeHtml,
  formatKoreanDate,
  renderShareError,
  SHARE_DEFAULT_DAYS,
  SHARE_TOKEN_LENGTH,
  SHARE_PURGE_DAYS,
  sharePurgeCutoff,
} from "../server/lib/shareLink";
/*
  결과지 HTML 은 shareReport.ts 가 그린다(2026-10 부터). shareLink.ts 에는
  주소·수명·안내문만 남았다. 이 파일을 DB 없이 돌리기 위해 pickReportSettings
  도 거기에 두었다 — shareRoutes.ts 를 import 하면 storage 가 따라 들어와
  Postgres 연결을 시도한다.
*/
import {
  renderSharePage,
  buildShareReportModel,
  pickReportSettings,
  autoBandFor,
  interpretDomain,
  academyProgramKey,
} from "../server/lib/shareReport";
import { buildShareMessage } from "../shared/shareMessage";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}\n`);
  }
}

/**
 * 검사 대상 소스. "코드 모양 고정" 테스트들이 이 글자들을 읽는다.
 * main() 밖에 두는 이유: 파기 테스트와 라우터 테스트가 떨어진 자리에서
 * 같은 파일을 보기 때문이다 (한쪽에서만 읽으면 선언 순서에 걸린다).
 */
const routesSrc = readFileSync(
  join(process.cwd(), "server", "level-test", "shareRoutes.ts"),
  "utf8"
);
const schemaSrc = readFileSync(join(process.cwd(), "shared", "schema.ts"), "utf8");
const storageSrc = readFileSync(join(process.cwd(), "server", "storage.ts"), "utf8");
const libSrc = readFileSync(join(process.cwd(), "server", "lib", "shareLink.ts"), "utf8");
const purgeSrc = readFileSync(join(process.cwd(), "server", "lib", "sharePurge.ts"), "utf8");
const reportSrc = readFileSync(join(process.cwd(), "server", "lib", "shareReport.ts"), "utf8");
const reportDataSrc = readFileSync(
  join(process.cwd(), "server", "level-test", "reportData.ts"),
  "utf8"
);

/**
 * 주석을 떼고 **실제로 돌아가는 코드만** 남긴다.
 *
 * "이 파일에 db.delete 가 없다" 같은 검사를 할 때 필요하다. 주석에
 * "db.delete 를 쓰지 않는다" 라고 적어 두면 검사가 자기 설명문에 걸린다
 * (처음에 그렇게 썼다가 틀린 실패를 봤다). 설명을 자세히 적는 것과
 * 검사가 엄격한 것이 서로를 방해하지 않게 한다.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** 공개 페이지에 절대 나와서는 안 되는 값들을 눈에 띄는 문자열로 심어 둔다. */
const SECRET_PHONE = "010-7777-8888";
const SECRET_SCHOOL = "비밀중학교";
const SECRET_CONSULTATION = "cccccccc-1111-2222-3333-444444444444";

function row(over: Partial<any> = {}) {
  return {
    studentName: "김민준",
    grade: "중2",
    testDate: "2026-10-11",
    // 실제 시험 코드는 네 개뿐이다: m1(Lv1) · all(Lv2) · m3(Lv3) · high(Lv4).
    // 이 값이 12개월 커리큘럼을 고르는 열쇠다.
    examCode: "all",
    examTitle: "중등 종합",
    totalScore: 78,
    readingScore: 72,
    grammarScore: 81,
    vocabScore: 85,
    writingScore: 60,
    questionCount: 40,
    correctCount: 31,
    notes: "어휘가 강점입니다. 서술형 보완이 필요합니다.",
    teacherName: "이선생",
    ...over,
  };
}

function page(over: Partial<any> = {}, extra: Partial<any> = {}) {
  return renderSharePage({
    row: row(over) as any,
    academyName: "페이지원영어학원",
    academyPhone: "031-123-4567",
    expiresAt: new Date("2026-12-10T00:00:00Z"),
    ...extra,
  });
}

function main() {
  console.log("─── 토큰 ───");

  test("토큰은 base64url 12자다 (카카오톡에서 안 잘리는 글자만)", () => {
    const t = generateShareToken();
    assert.equal(t.length, 12, `길이 ${t.length}`);
    assert.equal(SHARE_TOKEN_LENGTH, 12);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(t), `허용되지 않은 글자: ${t}`);
    // 패딩이 붙으면 주소에 = 가 들어간다. 9바이트(3의 배수)라 붙지 않아야 한다.
    assert.ok(!t.includes("="), "패딩(=)이 주소에 들어갔다");
  });

  test("토큰이 겹치지 않는다 (20000개 전부 다름)", () => {
    // 12자(2^72)로 줄였으니 겹침을 더 많은 표본으로 확인한다.
    const seen = new Set<string>();
    for (let i = 0; i < 20000; i++) seen.add(generateShareToken());
    assert.equal(seen.size, 20000, "같은 주소가 두 번 나왔다");
  });

  test("토큰이 추측 가능한 크기가 아니다 (12자 아래로 줄이지 못하게 막는다)", () => {
    // 64^12 ≈ 4.7 × 10^21. 이 아래로 내려가면 횟수 제한이 유일한 방어선이 된다.
    const keyspace = Math.pow(64, SHARE_TOKEN_LENGTH);
    assert.ok(keyspace >= 1e21, `주소 가짓수가 너무 적다: ${keyspace}`);
  });

  test("모양이 다른 주소는 DB 조회 전에 끊는다", () => {
    assert.ok(isWellFormedShareToken(generateShareToken()));
    for (const bad of [
      "",
      "짧다",
      "a".repeat(11),
      "a".repeat(13),
      "a".repeat(43), // 옛 길이 — 이제 받지 않는다
      "a".repeat(11) + "+", // base64 표준 글자 — 우리는 발급하지 않는다
      "a".repeat(11) + "/",
      "a".repeat(11) + "=",
      "../../etc/pw",
      "a' OR 1=1 --",
      null,
      undefined,
      123,
      {},
    ]) {
      assert.equal(isWellFormedShareToken(bad as any), false, `통과하면 안 됨: ${String(bad)}`);
    }
  });

  console.log("\n─── 링크의 수명 (끝낼 수 있는가) ───");

  test("기본 기한은 5일이다", () => {
    assert.equal(SHARE_DEFAULT_DAYS, 5);
    const now = new Date("2026-10-11T00:00:00Z");
    const exp = shareExpiryFrom(now);
    assert.equal(Math.round((exp.getTime() - now.getTime()) / 86400000), 5);
  });

  test("영구 링크를 만들 방법이 없다 (상한 180일)", () => {
    assert.ok(
      /days:\s*z\.number\(\)\.int\(\)\.min\(1\)\.max\(180\)\.optional\(\)/.test(routesSrc),
      "발급 기간 범위가 1~180일이 아니다"
    );
  });

  test("링크가 없으면 none", () => {
    assert.equal(
      shareState({ shareToken: null, shareExpiresAt: null, shareRevokedAt: null } as any),
      "none"
    );
  });

  test("기한이 남아 있으면 active", () => {
    const now = new Date("2026-10-11T00:00:00Z");
    assert.equal(
      shareState(
        {
          shareToken: "t",
          shareExpiresAt: new Date("2026-12-10T00:00:00Z"),
          shareRevokedAt: null,
        } as any,
        now
      ),
      "active"
    );
  });

  test("기한이 지나면 expired — 저절로 닫힌다", () => {
    const now = new Date("2026-12-11T00:00:00Z");
    assert.equal(
      shareState(
        {
          shareToken: "t",
          shareExpiresAt: new Date("2026-12-10T00:00:00Z"),
          shareRevokedAt: null,
        } as any,
        now
      ),
      "expired"
    );
  });

  test("기한 경계(같은 시각)에서는 닫힌 것으로 본다", () => {
    const at = new Date("2026-12-10T00:00:00Z");
    assert.equal(
      shareState({ shareToken: "t", shareExpiresAt: at, shareRevokedAt: null } as any, at),
      "expired"
    );
  });

  test("원장이 끊으면 기한이 남아 있어도 revoked (끊기가 항상 이긴다)", () => {
    const now = new Date("2026-10-11T00:00:00Z");
    assert.equal(
      shareState(
        {
          shareToken: "t",
          shareExpiresAt: new Date("2099-01-01T00:00:00Z"),
          shareRevokedAt: new Date("2026-10-12T00:00:00Z"),
        } as any,
        now
      ),
      "revoked"
    );
  });

  console.log("\n─── 6개월 뒤 파기 (주소 값을 아예 지운다) ───");

  test("배포할 때 DB 칸이 자동으로 생긴다 (마이그레이션을 빠뜨리지 않았는가)", () => {
    /*
      이 테스트가 있는 이유 — 실제로 한 번 빠뜨렸다.

      코드를 올렸는데 railway.toml 의 preDeployCommand 에 이 마이그레이션을
      안 넣으면, 배포된 새 코드가 없는 칼럼을 조회한다. 레벨테스트 기록
      화면이 "column does not exist" 로 안 열린다. 코드는 멀쩡한데 화면이
      죽는, 찾기 어려운 종류의 사고다.

      순서도 함께 확인한다: level_tests 테이블을 만드는 level-test-records
      **뒤**여야 한다. 앞에 두면 빈 DB 에서 "테이블이 없습니다" 로 멈춘다.
    */
    const toml = readFileSync(join(process.cwd(), "railway.toml"), "utf8");
    assert.ok(
      toml.includes("db:migrate:level-test-share"),
      "railway.toml 에 공유 링크 마이그레이션이 없다 — 배포하면 화면이 안 열린다"
    );
    assert.ok(
      toml.indexOf("db:migrate:level-test-records") <
        toml.indexOf("db:migrate:level-test-share"),
      "공유 링크 마이그레이션이 level_tests 테이블 생성보다 먼저 돈다"
    );
  });

  test("파기 기준은 발급 후 180일(6개월)이다", () => {
    assert.equal(SHARE_PURGE_DAYS, 180);
    const now = new Date("2027-04-11T00:00:00Z");
    const cutoff = sharePurgeCutoff(now);
    assert.equal(Math.round((now.getTime() - cutoff.getTime()) / 86400000), 180);
    assert.ok(cutoff.getTime() < now.getTime(), "기준 시각이 과거여야 한다");
  });

  test("파기는 만료보다 훨씬 나중이다 (순서가 뒤집히지 않는다)", () => {
    // 만료가 파기보다 늦으면 "열리는데 주소는 지워진" 모순이 생긴다.
    assert.ok(
      SHARE_PURGE_DAYS > SHARE_DEFAULT_DAYS,
      `파기(${SHARE_PURGE_DAYS}일)가 만료(${SHARE_DEFAULT_DAYS}일)보다 빠르다`
    );
    // 원장이 발급 때 지정할 수 있는 최대값(180일)보다도 작지 않아야 한다.
    assert.ok(SHARE_PURGE_DAYS >= 180, "최대 기한보다 파기가 빠르면 안 된다");
  });

  test("파기하는 코드는 행을 지우지 않고 주소 한 칸만 비운다", () => {
    const m = /async purgeExpiredShareTokens\(before: Date\)[\s\S]*?\n  \}/.exec(storageSrc);
    assert.ok(m, "purgeExpiredShareTokens 의 구현을 찾을 수 없다");
    const body = m![0];

    // 1) UPDATE 다. 행을 지우는 코드가 아니다.
    assert.ok(/\.update\(levelTests\)/.test(body), "update 가 아니다");
    assert.ok(!/\.delete\(/.test(stripComments(body)), "삭제(delete) 를 쓰고 있다");

    // 2) set 에 share_token 말고 아무것도 없다. 점수가 날아가는 사고를 막는다.
    const setMatch = /\.set\(\{([^}]*)\}\)/.exec(body);
    assert.ok(setMatch, "set 블록을 찾을 수 없다");
    assert.equal(
      setMatch![1].trim(),
      "shareToken: null",
      `주소 외에 다른 칸을 건드린다: ${setMatch![1].trim()}`
    );

    // 3) 토큰이 있는 행만, 4) 발급일이 적혀 있고 오래된 행만.
    assert.ok(body.includes("isNotNull(levelTests.shareToken)"), "토큰 없는 행도 긁는다");
    assert.ok(
      body.includes("isNotNull(levelTests.shareCreatedAt)"),
      "발급일이 비어 있는 행을 걸러내지 않는다"
    );
    assert.ok(
      body.includes("lt(levelTests.shareCreatedAt, before)"),
      "기준 시각 비교가 없다 — 전체를 지울 위험"
    );
  });

  test("파기가 점수·이름·메모·열어 본 횟수를 건드리지 않는다", () => {
    const m = /async purgeExpiredShareTokens\(before: Date\)[\s\S]*?\n  \}/.exec(storageSrc);
    const body = m![0];
    for (const forbidden of [
      "totalScore",
      "studentName",
      "notes",
      "shareViewCount",
      "shareCreatedAt: null",
      "shareExpiresAt: null",
    ]) {
      assert.ok(!body.includes(forbidden), `파기가 ${forbidden} 를 건드린다`);
    }
  });

  test("파기 장치는 결제·학생 자료를 건드리지 않는다", () => {
    // 설명문은 떼고 실제 코드만 본다 (주석에 "db.delete 를 쓰지 않는다" 라고
    // 적혀 있어서, 그냥 검사하면 자기 설명문에 걸린다).
    const purgeCode = stripComments(purgeSrc);
    for (const forbidden of [
      "payments",
      "paymentIntents",
      "enrollments",
      "students",
      "db.delete",
      "db.update",
    ]) {
      assert.ok(!purgeCode.includes(forbidden), `파기 장치가 ${forbidden} 를 건드린다`);
    }
    // 삭제는 storage 의 그 함수 하나만 부른다.
    assert.ok(
      purgeSrc.includes("storage.purgeExpiredShareTokens(cutoff)"),
      "삭제 경로가 다르다"
    );
  });

  test("파기 장치가 주소를 로그에 찍지 않는다", () => {
    for (const line of purgeSrc.split(/\r?\n/)) {
      if (/console\.(log|error|warn|info)/.test(line)) {
        assert.ok(
          !/\bshareToken\b|\btoken\b/.test(line),
          `로그에 주소가 들어간다: ${line.trim()}`
        );
      }
    }
  });

  test("파기 장치가 다른 두 자동장치와 같은 방식으로 돌아간다", () => {
    assert.ok(
      /setInterval\(tick, 6 \* 60 \* 60 \* 1000\)/.test(purgeSrc),
      "6시간 간격이 아니다"
    );
    // 실패해도 서버가 죽지 않아야 한다.
    assert.ok(/runSharePurge\(\)\.catch\(/.test(purgeSrc), "실패를 삼키지 않는다");
    // 서버 시작 때 걸려 있는가.
    const indexSrc = readFileSync(join(process.cwd(), "server/index.ts"), "utf8");
    assert.ok(indexSrc.includes("startSharePurgeScheduler()"), "서버에 연결되지 않았다");
  });

  console.log("\n─── 무차별 긁기 완화 ───");

  test("정상 사용(가족이 여러 번 열기)은 막지 않는다", () => {
    __resetShareRateForTest();
    for (let i = 0; i < 40; i++) {
      assert.ok(checkShareRate("1.1.1.1"), `${i + 1}번째가 막혔다`);
    }
  });

  test("한도를 넘으면 막는다", () => {
    __resetShareRateForTest();
    for (let i = 0; i < 40; i++) checkShareRate("1.1.1.1");
    assert.equal(checkShareRate("1.1.1.1"), false);
  });

  test("IP 가 다르면 서로 영향이 없다", () => {
    __resetShareRateForTest();
    for (let i = 0; i < 41; i++) checkShareRate("1.1.1.1");
    assert.ok(checkShareRate("2.2.2.2"), "다른 집에서 여는 것이 막혔다");
  });

  test("시간이 지나면 다시 열린다", () => {
    __resetShareRateForTest();
    const t0 = 1_000_000;
    for (let i = 0; i < 41; i++) checkShareRate("1.1.1.1", t0);
    assert.equal(checkShareRate("1.1.1.1", t0), false);
    assert.ok(checkShareRate("1.1.1.1", t0 + 11 * 60 * 1000), "10분 뒤에도 막혀 있다");
  });

  test("오래된 기록을 치운다 (메모리가 끝없이 커지지 않는다)", () => {
    __resetShareRateForTest();
    const t0 = 1_000_000;
    for (let i = 0; i < 100; i++) checkShareRate(`10.0.0.${i}`, t0);
    sweepShareRate(t0 + 11 * 60 * 1000);
    // 치운 뒤에는 한도가 처음부터 다시 세어진다.
    for (let i = 0; i < 40; i++) {
      assert.ok(checkShareRate("10.0.0.1", t0 + 11 * 60 * 1000), `${i + 1}번째가 막혔다`);
    }
  });

  console.log("\n─── 학부모 화면: 새면 안 되는 것 ───");

  test("학부모 연락처가 결과지에 나오지 않는다", () => {
    const html = page({ parentPhone: SECRET_PHONE } as any);
    assert.ok(!html.includes(SECRET_PHONE), "학부모 연락처가 공개 페이지에 들어갔다");
    assert.ok(!html.includes("7777"), "연락처 일부가 공개 페이지에 들어갔다");
  });

  test("학교 이름이 결과지에 나오지 않는다", () => {
    const html = page({ school: SECRET_SCHOOL } as any);
    assert.ok(!html.includes(SECRET_SCHOOL), "학교가 공개 페이지에 들어갔다");
  });

  test("상담 메모는 어떤 경우에도 결과지에 나오지 않는다", () => {
    /*
      2026-10 에 바뀐 규칙이다. 그 전에는 메모를 "선생님 의견" 이라는 칸에
      그대로 찍었다. 메모는 **교사용으로 적는 글**이다 ("어머니가 예민함",
      "숙제 거의 안 함" 같은 문장이 들어간다). 레벨테스트 앱도 결과지에
      인쇄하지 않는다고 분명히 적어 두었으므로 링크도 같은 규칙을 지킨다.
    */
    const SECRET_MEMO = "내부메모유출금지";
    const html = page({ notes: SECRET_MEMO } as any);
    assert.ok(!html.includes(SECRET_MEMO), "상담 메모가 학부모 화면에 들어갔다");
    assert.ok(!html.includes("선생님 의견"), "메모를 찍는 칸이 되살아났다");
    // 렌더러가 notes 를 아예 받지 않는지도 못 박는다(주석은 떼고 본다).
    assert.ok(
      !/\bnotes\b/.test(stripComments(reportSrc)),
      "shareReport.ts 가 notes 를 다시 읽는다"
    );
  });

  test("상담 id·내부 id·원본 상태가 결과지에 나오지 않는다", () => {
    const html = page({
      consultationId: SECRET_CONSULTATION,
      id: "11111111-aaaa-bbbb-cccc-dddddddddddd",
      tenantId: "99999999-aaaa-bbbb-cccc-dddddddddddd",
      rawState: { 문항별정답: [1, 2, 3], 비밀: "유출되면안됨" },
      clientRecordId: "secret-record-key",
      shareToken: "TOKENTOKENTOKENTOKENTOKENTOKENTOKENTOKENTOK",
    } as any);
    assert.ok(!html.includes(SECRET_CONSULTATION), "상담 id 노출");
    assert.ok(!html.includes("유출되면안됨"), "결과지 원본(rawState) 노출");
    assert.ok(!html.includes("secret-record-key"), "내부 기록 키 노출");
    assert.ok(!html.includes("TOKENTOKEN"), "토큰이 페이지 본문에 박혔다");
    assert.ok(!html.includes("99999999-aaaa"), "학원 id 노출");
  });

  test("결과지에는 스크립트가 아예 없다", () => {
    const html = page();
    assert.ok(!/<script/i.test(html), "공개 페이지에 <script> 가 생겼다");
    assert.ok(!/on(click|load|error)\s*=/i.test(html), "인라인 이벤트 핸들러가 생겼다");
  });

  test("검색 로봇을 막는 표시가 들어 있다", () => {
    assert.ok(/noindex/i.test(page()), "noindex 메타태그가 없다");
  });

  console.log("\n─── 학부모 화면: 글자 끼워 넣기(XSS) ───");

  test("이름에 태그를 적어도 글자로만 나온다", () => {
    const html = page({ studentName: `<script>alert('x')</script>` });
    assert.ok(!html.includes("<script>alert"), "스크립트가 그대로 들어갔다");
    assert.ok(html.includes("&lt;script&gt;"), "이스케이프된 형태가 안 보인다");
  });

  test("시험 이름에 태그를 적어도 글자로만 나온다", () => {
    const html = page({ examTitle: `<img src=x onerror="alert(1)">` });
    assert.ok(!html.includes("<img"), "img 태그가 그대로 들어갔다");
    assert.ok(html.includes("&lt;img"), "이스케이프된 형태가 안 보인다");
    // "onerror" 라는 **글자** 는 화면에 남는다. 그건 괜찮다. 막아야 하는 것은
    // 그 글자가 **태그의 속성이 되는 것** 이다. 꺾쇠가 모두 &lt; 로 바뀌었으면
    // 될 수 없다.
    assert.ok(!/<[^>]*onerror/i.test(html), "onerror 가 태그 속성으로 살아 있다");
  });

  test("담당 교사 이름에 태그가 있어도 안전하다", () => {
    // clip() 이 18자에서 자른다. 잘린 뒤에도 꺾쇠가 남지 않는지 본다.
    const html = page({ teacherName: `<b>이선생</b>` });
    assert.ok(!html.includes("<b>이선생"), "태그가 살아 있다");
    assert.ok(html.includes("&lt;b&gt;"), "이스케이프된 형태가 안 보인다");
  });

  test("학원 이름에 태그가 있어도 안전하다", () => {
    const html = page({}, { academyName: `<svg onload=alert(1)>` });
    assert.ok(!html.includes("<svg"), "svg 태그가 그대로 들어갔다");
  });

  test("escapeHtml 이 다섯 글자를 모두 바꾼다", () => {
    assert.equal(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;");
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(undefined), "");
    assert.equal(escapeHtml(0), "0");
  });

  console.log("\n─── 학부모 화면: 제대로 보이는가 ───");

  test("총점·시험 이름·응시일이 보인다", () => {
    const html = page();
    assert.ok(html.includes("78"), "총점이 없다");
    assert.ok(html.includes("중등 종합"), "시험 이름이 없다");
    assert.ok(html.includes("2026년 10월 11일"), "응시일이 한국어로 없다");
    assert.ok(html.includes("정답 31 / 평가 40문항"), "정답 수가 없다");
  });

  test("네 영역이 모두 보이고, 점수가 없는 영역은 0 이 아니라 미평가다", () => {
    /*
      예전에는 점수가 없는 영역을 빼 버렸다. 그러면 학부모는 그 영역을
      "안 본 것" 인지 "0점" 인지 알 수 없고, 칸 수가 학생마다 달라져 비교도
      안 된다. 이제 네 칸을 항상 그리고, 없는 것은 **미평가**라고 적는다.
      0 을 찍으면 안 본 영역이 빵점으로 읽힌다 — 되돌릴 수 없는 오해다.
    */
    const html = page({ writingScore: null });
    for (const label of ["문법", "독해", "서술형", "어휘"]) {
      assert.ok(html.includes(`</i>${label}</b>`), `${label} 칸이 없다`);
    }
    assert.ok(html.includes("미평가"), "점수 없는 영역에 미평가 표시가 없다");
    // 막대 길이도 0% 여야 한다 (빈 칸이 꽉 찬 막대로 보이면 안 된다).
    assert.ok(html.includes('style="width:0%"'), "미평가 막대가 0% 가 아니다");
  });

  test("영역 순서가 인쇄물과 같다 (문법 → 독해 → 서술형 → 어휘)", () => {
    // DB 칼럼 순서(reading/grammar/vocab/writing)와 일부러 다르다. 학부모가
    // 종이 결과지와 링크를 나란히 놓고 볼 때 순서가 어긋나면 안 된다.
    const html = page();
    const at = (s: string) => html.indexOf(`</i>${s}</b>`);
    assert.ok(at("문법") < at("독해"), "문법이 독해보다 뒤에 있다");
    assert.ok(at("독해") < at("서술형"), "독해가 서술형보다 뒤에 있다");
    assert.ok(at("서술형") < at("어휘"), "서술형이 어휘보다 뒤에 있다");
  });

  test("가장 낮은 영역을 우선 보완으로, 80점 이상을 강점으로 고른다", () => {
    // 고정값: 문법81 · 독해72 · 서술형60 · 어휘85
    const html = page();
    assert.ok(html.includes("서술형 · 60%"), "가장 낮은 영역이 우선 보완이 아니다");
    assert.ok(html.includes("문법 · 어휘 — 유지·확장"), "80점 이상이 강점으로 안 묶였다");
  });

  test("점수가 하나도 없으면 단정하지 않고 '추가 확인 필요' 라고 적는다", () => {
    const html = page({
      readingScore: null,
      grammarScore: null,
      vocabScore: null,
      writingScore: null,
    });
    assert.ok(html.includes("추가 확인 필요"), "없는 점수로 약점을 지어낸다");
    assert.ok(!html.includes("· 0%"), "미평가를 0% 로 적는다");
  });

  test("학원 전화번호가 있으면 전화 버튼이 나온다", () => {
    const html = page();
    assert.ok(html.includes('href="tel:0311234567"'), "전화 링크가 숫자만으로 안 만들어졌다");
    assert.ok(!page({}, { academyPhone: null }).includes("전화하기"), "번호가 없는데 버튼이 있다");
  });

  test("기한 안내가 한국어로 나온다", () => {
    assert.ok(page().includes("2026년 12월 10일"), "기한이 안 보인다");
  });

  test("날짜 변환이 이상한 값에도 터지지 않는다", () => {
    assert.equal(formatKoreanDate(null), "");
    assert.equal(formatKoreanDate(""), "");
    assert.equal(formatKoreanDate("쓰레기값"), "");
    assert.equal(formatKoreanDate("2026-01-05"), "2026년 1월 5일");
  });

  /*
    ════════════════════════════════════════════════════════════════════
    12개월 커리큘럼 (결과지 2페이지)
    ════════════════════════════════════════════════════════════════════
    문구는 손으로 적은 것이 아니라 레벨테스트 앱에서 뽑아 온 것이다
    (scripts/extract-report-data.mjs → server/level-test/reportData.ts).
    인쇄물과 링크가 조용히 달라지는 일을 막기 위해서다. 아래 테스트는
    "뽑아 온 문구가 실제로 화면까지 도달하는가" 를 본다.
  */
  console.log("\n─── 12개월 커리큘럼 ───");

  test("커리큘럼 4단계가 모두 나온다", () => {
    const html = page();
    for (const name of [
      "통합 역량 재정비",
      "심화 이해와 표현",
      "종합 적용력 강화",
      "완성도 점검과 확장",
    ]) {
      assert.ok(html.includes(name), `${name} 단계가 없다`);
    }
    assert.equal(
      (html.match(/class="phase"/g) ?? []).length,
      4,
      "단계 개수가 4개가 아니다"
    );
  });

  test("단계마다 기간이 진단 다음 달부터 3개월씩 붙는다", () => {
    // 진단 2026-10-11 → 시작 2026년 11월. 1단계 11월~1월, 2단계 2월~4월.
    const html = page();
    assert.ok(html.includes("2026년 11월 – 2027년 1월"), "1단계 기간이 틀리다");
    assert.ok(html.includes("2027년 2월 – 2027년 4월"), "2단계 기간이 틀리다");
    assert.ok(html.includes("2026년 11월 시작"), "시작월 안내가 없다");
  });

  test("원장이 시작월을 정해 두면 그 달부터 센다", () => {
    const html = page({}, { settings: { startMonth: "2027-03" } });
    assert.ok(html.includes("2027년 3월 – 2027년 5월"), "지정한 시작월이 무시됐다");
  });

  test("보완 중점은 1·2단계에만 붙는다", () => {
    /*
      3·4단계에 안 붙이는 것은 빠뜨린 것이 아니다. 6개월 뒤의 약한 영역을
      오늘 점수로 단정하지 않겠다는 뜻이다(레벨테스트 앱도 같다).
    */
    const html = page();
    assert.equal(
      (html.match(/보완 중점/g) ?? []).length,
      2,
      "보완 중점이 1·2단계 말고 다른 단계에도 붙었다"
    );
  });

  test("수준 띠가 총점에 맞게 붙는다 (78점 → 실력 굳히기)", () => {
    assert.ok(page().includes("Level 2 · 중등 종합 역량 · 실력 굳히기"), "수준 표시가 틀리다");
  });

  test("총점 경계값에서 수준이 갈린다 (60 / 80)", () => {
    assert.equal(autoBandFor(59), "기초 다지기");
    assert.equal(autoBandFor(60), "실력 굳히기");
    assert.equal(autoBandFor(79), "실력 굳히기");
    assert.equal(autoBandFor(80), "한 단계 도약");
    // 점수가 없으면 가장 낮은 수준. 없는 실력을 높게 약속하지 않는다.
    assert.equal(autoBandFor(null), "기초 다지기");
  });

  test("원장이 수준을 손으로 바꿔 두면 그 커리큘럼이 나온다", () => {
    const html = page({}, { settings: { trackOverride: "m3|실력 굳히기" } });
    assert.ok(html.includes("Level 3 · 심화 종합 역량"), "직접 고른 과정이 무시됐다");
  });

  test("있지도 않은 수준을 지정하면 조용히 자동 판정으로 돌아간다", () => {
    for (const bad of ["없는시험|실력 굳히기", "all|없는수준", "쓰레기", "", "a|b|c"]) {
      const html = page({}, { settings: { trackOverride: bad } });
      assert.ok(
        html.includes("Level 2 · 중등 종합 역량"),
        `잘못된 지정(${bad})이 커리큘럼을 깨뜨렸다`
      );
    }
  });

  test("모르는 시험 종류면 커리큘럼을 지어내지 않는다", () => {
    /*
      예전 앱은 여기서 터졌다. 학부모 화면은 터지면 안 되고, 그렇다고
      아무 커리큘럼이나 보여 주면 거짓 약속이 된다. 그래서 2페이지를
      통째로 빼고 "상담에서 안내" 라고 적는다.
    */
    for (const code of ["m99", "", null, undefined]) {
      const html = page({ examCode: code } as any);
      assert.ok(html.includes("상담에서 안내"), `${String(code)}: 안내 문구가 없다`);
      assert.ok(!html.includes("통합 역량 재정비"), `${String(code)}: 가짜 커리큘럼이 나온다`);
    }
  });

  test("중등·고등 학년에 맞는 수업 과정이 나온다", () => {
    assert.ok(page({ grade: "중2" }).includes("중등부"), "중2 에 중등부 과정이 없다");
    assert.ok(page({ grade: "고2" }).includes("고등부"), "고2 에 고등부 과정이 없다");
  });

  test("학년으로 과정이 안 정해지면 단정하지 않는다", () => {
    const html = page({ grade: "초6" });
    assert.ok(!html.includes("중등부"), "초6 에 중등부 과정이 붙었다");
    assert.ok(!html.includes("고등부"), "초6 에 고등부 과정이 붙었다");
    assert.ok(html.includes("상담 내용을 바탕으로"), "대체 안내가 없다");
  });

  test("배정 과정 판단이 학년 표기에 휘둘리지 않는다", () => {
    assert.equal(academyProgramKey("중1", null), "middle");
    assert.equal(academyProgramKey("고3", null), "high");
    assert.equal(academyProgramKey("초6", null), null);
    assert.equal(academyProgramKey("중등부", null), null);
    assert.equal(academyProgramKey(null, null), null);
    // 원장이 직접 고른 값이 학년보다 우선이다.
    assert.equal(academyProgramKey("중2", "high"), "high");
    // 엉뚱한 값은 학년 판단으로 돌아간다.
    assert.equal(academyProgramKey("중2", "쓰레기"), "middle");
  });

  test("영역 해석이 점수대로 갈린다", () => {
    assert.equal(interpretDomain(null), "추가 확인 필요");
    assert.equal(interpretDomain(59), "개념 보완");
    assert.equal(interpretDomain(60), "적용 훈련");
    assert.equal(interpretDomain(79), "적용 훈련");
    assert.equal(interpretDomain(80), "유지·확장");
  });

  test("깨진 진단 날짜에도 터지지 않고 기간만 빠진다", () => {
    const html = page({ testDate: "쓰레기값" });
    assert.ok(html.includes("통합 역량 재정비"), "커리큘럼이 통째로 사라졌다");
    assert.ok(html.includes("시작월 상담에서 확정"), "시작월 대체 문구가 없다");
    assert.ok(!html.includes("NaN"), "NaN 이 화면에 나왔다");
    assert.ok(!html.includes("Invalid"), "Invalid Date 가 화면에 나왔다");
  });

  test("학습 방식 설정이 안내 문장에 반영된다", () => {
    assert.ok(page().includes("학생과 확인하며 조정합니다"), "기본 안내가 없다");
    assert.ok(
      page({}, { settings: { learningSupport: "practice" } }).includes("문제를 직접 풀고"),
      "고른 학습 방식이 무시됐다"
    );
  });

  console.log("\n─── 결과지 설정 고르기 (rawState 거르개) ───");

  test("rawState 에서 네 칸만 통과시킨다", () => {
    const picked = pickReportSettings({
      trackOverride: "all|실력 굳히기",
      startMonth: "2027-03",
      learningSupport: "practice",
      classProgram: "middle",
      // 아래는 전부 통과하면 안 되는 것들
      marks: [1, 0, 1],
      edits: { 3: "고침" },
      parentPhone: SECRET_PHONE,
      school: SECRET_SCHOOL,
      consultationId: SECRET_CONSULTATION,
    });
    assert.deepEqual(Object.keys(picked).sort(), [
      "classProgram",
      "learningSupport",
      "startMonth",
      "trackOverride",
    ]);
    assert.equal(JSON.stringify(picked).includes(SECRET_PHONE), false, "연락처가 통과했다");
    assert.equal(JSON.stringify(picked).includes(SECRET_SCHOOL), false, "학교가 통과했다");
  });

  test("문자열이 아니거나 너무 긴 값은 버린다", () => {
    const picked = pickReportSettings({
      trackOverride: { evil: true },
      startMonth: 12345,
      learningSupport: "x".repeat(41),
      classProgram: ["middle"],
    });
    for (const v of Object.values(picked)) {
      assert.equal(v, undefined, `이상한 값이 통과했다: ${String(v)}`);
    }
  });

  test("rawState 가 비어 있거나 없어도 터지지 않는다", () => {
    for (const v of [null, undefined, {}, "문자열", 0]) {
      assert.doesNotThrow(() => pickReportSettings(v), `${String(v)} 에서 터졌다`);
    }
  });

  test("설정 거르개가 라우터가 아니라 결과지 쪽에 있다 (테스트가 DB 없이 돈다)", () => {
    assert.ok(reportSrc.includes("export function pickReportSettings"), "거르개가 옮겨졌다");
    assert.ok(
      /settings: pickReportSettings\(row\.rawState\)/.test(routesSrc),
      "라우터가 거르개를 거치지 않는다"
    );
    assert.ok(
      !/settings:\s*row\.rawState/.test(routesSrc),
      "라우터가 rawState 를 그대로 넘긴다 — 채점 상태가 샌다"
    );
  });

  test("뽑아 온 문구 파일에 코드나 그림이 섞여 들지 않았다", () => {
    assert.ok(!reportDataSrc.includes("base64"), "이미지가 들어가 파일이 비대해졌다");
    assert.ok(!/\b(function|=>|require\(|process\.)/.test(reportDataSrc), "코드가 섞여 있다");
    assert.ok(reportDataSrc.length < 200_000, "문구 파일이 너무 커졌다");
    // 다시 뽑는 방법이 파일에 적혀 있어야 한다 (손으로 고치는 것을 막는다).
    assert.ok(reportDataSrc.includes("gen:report-data"), "다시 뽑는 명령이 안 적혀 있다");
  });

  console.log("\n─── 안 열릴 때 안내 ───");

  test("네 가지 상황마다 다른 한국어 안내가 나온다", () => {
    const kinds = ["expired", "revoked", "notfound", "ratelimited"] as const;
    const titles = new Set<string>();
    for (const k of kinds) {
      const html = renderShareError(k);
      assert.ok(/noindex/i.test(html), `${k}: noindex 가 없다`);
      assert.ok(!/<script/i.test(html), `${k}: 스크립트가 있다`);
      const m = /<title>(.*?)<\/title>/.exec(html);
      assert.ok(m, `${k}: 제목이 없다`);
      titles.add(m![1]);
    }
    assert.equal(titles.size, 4, "안내 문구가 겹친다 — 학부모가 원인을 알 수 없다");
  });

  test("안내 화면이 내부 사정을 알려주지 않는다", () => {
    for (const k of ["expired", "revoked", "notfound", "ratelimited"] as const) {
      const html = renderShareError(k);
      for (const leak of ["Error", "stack", "level_tests", "tenant", "SELECT", "token"]) {
        assert.ok(!html.includes(leak), `${k}: "${leak}" 가 학부모 화면에 보인다`);
      }
    }
  });

  console.log("\n─── 카카오톡에 붙여 넣을 메시지 ───");

  const msg = buildShareMessage({
    academyName: "페이지원영어학원",
    studentName: "김민준",
    testDate: "2026-10-11",
    examTitle: "중등 종합",
    totalScore: 78,
    questionCount: 40,
    correctCount: 31,
    url: "https://example.com/r/" + "a".repeat(43),
    expiresAt: new Date("2026-12-10T00:00:00Z"),
  });

  test("링크를 안 눌러도 총점이 전달된다", () => {
    assert.ok(msg.includes("78점"), "총점이 문구에 없다");
    assert.ok(msg.includes("40문항 중 31문항 정답"));
  });

  test("학원 이름·학생 이름·응시일·주소가 들어 있다", () => {
    assert.ok(msg.includes("페이지원영어학원입니다"));
    assert.ok(msg.includes("김민준 학생"));
    assert.ok(msg.includes("10월 11일"));
    assert.ok(msg.includes("https://example.com/r/"));
  });

  test("기한을 적어 준다 (나중에 안 열린다는 전화를 막는다)", () => {
    assert.ok(msg.includes("12월 10일까지"), msg);
  });

  test("전화 상담으로 안내하고 끝낸다 (등록 재촉 문구가 없다)", () => {
    assert.ok(msg.includes("전화로 상담"));
    for (const push of ["할인", "마감", "서둘러", "지금 등록", "특가", "이벤트"]) {
      assert.ok(!msg.includes(push), `재촉·광고 문구가 들어 있다: ${push}`);
    }
  });

  test("점수가 없으면 총점 줄을 아예 뺀다 (null점 이 가지 않는다)", () => {
    const m = buildShareMessage({
      academyName: "페이지원영어학원",
      studentName: "김민준",
      testDate: "2026-10-11",
      examTitle: "중등 종합",
      totalScore: null,
      url: "https://example.com/r/x",
    });
    assert.ok(!m.includes("총점"), "총점 줄이 남아 있다");
    assert.ok(!m.toLowerCase().includes("null"), "null 이 문구에 들어갔다");
    assert.ok(!m.includes("undefined"));
  });

  test("기한이 없으면 기한 문장을 넣지 않는다", () => {
    const m = buildShareMessage({
      academyName: "학원",
      studentName: "학생",
      testDate: "2026-10-11",
      examTitle: "시험",
      totalScore: 50,
      url: "https://example.com/r/x",
    });
    assert.ok(!m.includes("링크는"), "기한 문장이 억지로 들어갔다");
  });

  /*
    ════════════════════════════════════════════════════════════════════
    코드 모양 고정 — 공개 경로의 보호 장치가 사라지는 변화를 잡는다
    ════════════════════════════════════════════════════════════════════
    위 테스트들은 "함수가 맞게 동작하는가" 를 본다. 아래는 "그 함수를 부르는
    자리의 보호 장치가 그대로 있는가" 를 본다. 둘은 다른 종류의 사고를 막는다 —
    렌더러가 완벽해도 라우터에서 authGuard 가 빠지면 끝이다.
  */
  console.log("\n─── 서버 코드 모양 (보호 장치가 그대로 있는가) ───");

  test("발급·해제는 로그인 + 학원 확인 + 역할 확인을 모두 거친다", () => {
    for (const m of ["post", "delete"]) {
      const re = new RegExp(
        `router\\.${m}\\(\\s*\\n?\\s*"/api/level-tests/:id/share",\\s*\\n?\\s*authGuard,\\s*\\n?\\s*tenantGuard,\\s*\\n?\\s*roleGuard\\("owner", "teacher"\\)`
      );
      assert.ok(re.test(routesSrc), `${m.toUpperCase()} /share 의 인증 미들웨어가 바뀌었다`);
    }
  });

  test("공개 경로는 토큰 하나만 받고, 로그인 정보를 쓰지 않는다", () => {
    const m = /router\.get\("\/r\/:token"[\s\S]*?\n}\);/.exec(routesSrc);
    assert.ok(m, "공개 라우트를 찾을 수 없다");
    const handler = m![0];
    assert.ok(!handler.includes("authGuard"), "공개 경로에 authGuard 가 붙었다 (학부모가 못 연다)");
    assert.ok(!handler.includes("req.user"), "공개 경로가 req.user 를 읽는다");
    assert.ok(!handler.includes("tenantGuard"), "공개 경로에 tenantGuard 가 붙었다");
    // 학원 구분을 주소/본문에서 받으면 공격자가 그 값을 고른다.
    assert.ok(!/req\.(query|body)\.tenant/i.test(handler), "학원 구분을 요청에서 받는다");
  });

  test("공개 경로는 토큰 모양을 먼저 확인한 뒤 DB 를 본다", () => {
    const idxCheck = routesSrc.indexOf("isWellFormedShareToken");
    const idxDb = routesSrc.indexOf("getLevelTestByShareToken");
    assert.ok(idxCheck > 0 && idxDb > 0, "둘 중 하나가 없다");
    assert.ok(idxCheck < idxDb, "모양 확인보다 DB 조회가 먼저 일어난다");
  });

  test("공개 경로가 만료·해제를 실제로 확인한다", () => {
    assert.ok(routesSrc.includes("shareState(row)"), "상태 확인이 없다");
    assert.ok(routesSrc.includes('renderShareError("revoked")'));
    assert.ok(routesSrc.includes('renderShareError("expired")'));
    assert.ok(routesSrc.includes("checkShareRate"), "횟수 제한이 안 걸려 있다");
  });

  test("공개 경로가 캐시·검색·CSP 헤더를 세운다", () => {
    assert.ok(routesSrc.includes("no-store"), "브라우저·프록시에 결과지가 남는다");
    assert.ok(routesSrc.includes("X-Robots-Tag"), "검색 로봇 차단 헤더가 없다");
    assert.ok(routesSrc.includes("Content-Security-Policy"), "CSP 가 없다");
    assert.ok(routesSrc.includes("default-src 'none'"), "CSP 가 느슨해졌다");
    assert.ok(routesSrc.includes("Referrer-Policy"), "주소가 외부 사이트로 새어나갈 수 있다");
  });

  test("robots.txt 가 /r/ 를 막는다", () => {
    assert.ok(routesSrc.includes("robots.txt"));
    assert.ok(/Disallow: \/r\//.test(routesSrc), "robots.txt 에 /r/ 차단이 없다");
  });

  test("채점이 안 끝난 결과지는 링크를 만들 수 없다", () => {
    assert.ok(
      /totalScore == null \|\| \(row\.pendingCount \?\? 0\) > 0/.test(routesSrc),
      "미채점 확인이 없다 — 중간 점수가 학부모에게 최종 점수로 전달된다"
    );
  });

  test("살아 있는 링크는 다시 만들지 않고 그대로 돌려준다", () => {
    assert.ok(
      /shareState\(row\) === "active"[\s\S]{0,200}reused: true/.test(routesSrc),
      "복사할 때마다 새 토큰이 발급되면 이미 보낸 링크가 죽는다"
    );
  });

  test("토큰을 로그에 찍지 않는다", () => {
    for (const src of [routesSrc, libSrc]) {
      const logs = src.match(/console\.(log|warn|error)\([^\n]*/g) ?? [];
      for (const line of logs) {
        assert.ok(
          !/\btoken\b/.test(line.replace(/\/\/.*/, "")),
          `로그에 토큰이 들어갈 수 있다: ${line.trim()}`
        );
      }
    }
  });

  test("앱 저장 요청으로 링크 칸을 건드릴 수 없다", () => {
    // saveLevelTestBodySchema 가 share* 를 전부 omit 하는지 확인한다.
    const m = /saveLevelTestBodySchema[\s\S]*?\.omit\(\{([\s\S]*?)\}\)/.exec(schemaSrc);
    assert.ok(m, "saveLevelTestBodySchema 의 omit 목록을 찾을 수 없다");
    const omitted = m![1];
    for (const field of [
      "shareToken",
      "shareCreatedAt",
      "shareExpiresAt",
      "shareRevokedAt",
      "shareViewCount",
      "shareLastViewedAt",
    ]) {
      assert.ok(
        new RegExp(`${field}:\\s*true`).test(omitted),
        `${field} 가 본문으로 들어올 수 있다 — 토큰·기한·열람수를 조작할 수 있다`
      );
    }
  });

  test("다시 채점해 저장해도 이미 보낸 링크가 죽지 않는다", () => {
    // upsertLevelTest 의 onConflictDoUpdate set 목록에 share* 가 없어야 한다.
    const m = /onConflictDoUpdate\(\{[\s\S]*?set: \{([\s\S]*?)\n        \},/.exec(storageSrc);
    assert.ok(m, "upsert 의 set 목록을 찾을 수 없다");
    const setBlock = m![1];
    assert.ok(
      !/share/i.test(setBlock),
      "덮어쓰기 목록에 share* 가 들어갔다 — 재저장할 때 링크와 열람 기록이 날아간다"
    );
    assert.ok(setBlock.includes("totalScore"), "엉뚱한 블록을 검사하고 있다");
  });

  test("토큰 조회는 학원 구분 없이 토큰만으로 한다 (그리고 빈 값을 막는다)", () => {
    // "async" 를 꼭 붙여서 찾는다. 안 붙이면 인터페이스 선언(IStorage 안의
    // 한 줄)에 먼저 걸려서 엉뚱한 범위를 검사한다.
    const m = /async getLevelTestByShareToken\(token: string\)[\s\S]*?\n  \}/.exec(storageSrc);
    assert.ok(m, "getLevelTestByShareToken 의 구현을 찾을 수 없다");
    assert.ok(m![0].includes("if (!token) return undefined"), "빈 토큰을 막지 않는다");
    assert.ok(m![0].includes("eq(levelTests.shareToken, token)"));
  });

  test("열람 기록이 화면 표시를 막지 않는다", () => {
    assert.ok(
      /recordLevelTestShareView\(row\.id\)\.catch\(/.test(routesSrc),
      "열람 기록 실패가 학부모 화면을 깨뜨릴 수 있다"
    );
  });

  test("링크 기능이 결제·학생 데이터를 건드리지 않는다", () => {
    for (const banned of ["payments", "paymentIntents", "enrollments", "db.delete", "db.update"]) {
      assert.ok(!routesSrc.includes(banned), `공유 라우터가 ${banned} 를 건드린다`);
    }
  });

  test("링크 기능이 아무것도 발송하지 않는다 (복사만 한다)", () => {
    const all = routesSrc + libSrc + readFileSync(join(process.cwd(), "shared", "shareMessage.ts"), "utf8");
    for (const sender of ["solapi", "aligo", "twilio", "nodemailer", "sendMessage", "sendSms"]) {
      assert.ok(!all.toLowerCase().includes(sender.toLowerCase()), `발송 코드가 생겼다: ${sender}`);
    }
  });

  console.log("\n─── 학원 이름·전화번호 (학부모에게 나가는 값) ───");

  test("결과지에 학원 전화번호가 있으면 그것, 없으면 가입 번호로 돌아간다", () => {
    assert.ok(
      page({}, { academyPhone: "062-456-0990" }).includes("062-456-0990"),
      "지정한 학원 번호가 안 나온다"
    );
    // 라우터가 sharePhone → ownerPhone 순서로 고르는지 글자로 확인한다.
    assert.ok(
      /academyPhone: tenant\?\.sharePhone \?\? tenant\?\.ownerPhone \?\? null/.test(routesSrc),
      "번호 고르는 순서가 바뀌었다 — 원장 개인 번호가 먼저 나갈 수 있다"
    );
  });

  test("학원 이름은 코드가 아니라 학원 계정에서 읽는다", () => {
    /*
      이름이 코드에 박혀 있으면 상호가 바뀔 때마다 배포를 해야 하고, 그동안
      학부모에게는 옛 이름이 나간다. 결과지·카톡 메시지 모두 tenant 에서
      읽어야 한다.
    */
    assert.ok(routesSrc.includes("academyName: tenant.name"), "발급 응답이 학원 이름을 안 읽는다");
    assert.ok(
      routesSrc.includes('academyName: tenant?.name ?? "학원"'),
      "결과지가 학원 이름을 안 읽는다"
    );
    // 특정 학원의 상호가 서버 코드에 박혀 있으면 안 된다. 다른 학원이 쓰면
    // 그대로 사고이고, 이름이 바뀔 때 배포를 해야 한다.
    for (const [label, src] of [
      ["shareRoutes.ts", routesSrc],
      ["shareReport.ts", reportSrc],
      ["shareMessage.ts", readFileSync(join(process.cwd(), "shared", "shareMessage.ts"), "utf8")],
    ] as const) {
      const code = stripComments(src);
      for (const brand of ["페이지원", "시대영재"]) {
        assert.ok(!code.includes(brand), `${label} 에 학원 상호("${brand}")가 박혔다`);
      }
    }
  });

  test("원장만 학원 정보를 고칠 수 있다 (강사는 보기만)", () => {
    assert.ok(
      /router\.patch\(\s*\n?\s*"\/api\/academy-profile",\s*\n?\s*authGuard,\s*\n?\s*tenantGuard,[\s\S]{0,200}?roleGuard\("owner"\)/.test(
        routesSrc
      ),
      "고치기가 원장 전용이 아니다"
    );
    assert.ok(
      /router\.get\(\s*\n?\s*"\/api\/academy-profile",\s*\n?\s*authGuard,\s*\n?\s*tenantGuard,\s*\n?\s*roleGuard\("owner", "teacher"\)/.test(
        routesSrc
      ),
      "읽기의 인증 미들웨어가 바뀌었다"
    );
  });

  test("학원 정보 저장이 결제 상태·활성기한을 건드리지 못한다", () => {
    /*
      이것이 이 묶음에서 가장 중요한 테스트다. "학원 이름 저장" 버튼 하나가
      학원의 결제 상태나 활성기한까지 바꿀 수 있게 되면, 눌렀을 때 결제가
      멈추는 사고가 난다. set 에 들어가는 칸을 글자로 못 박는다.
    */
    const m = /async updateTenantProfile\([\s\S]*?\n  \}/.exec(storageSrc);
    assert.ok(m, "updateTenantProfile 의 구현을 찾을 수 없다");
    const body = stripComments(m![0]);
    for (const forbidden of ["status", "activeUntil", "ownerPhone", "ownerName", "email"]) {
      assert.ok(!body.includes(forbidden), `학원 정보 저장이 ${forbidden} 를 건드린다`);
    }
    assert.ok(body.includes("set(set)"), "set 을 조립해서 쓰지 않는다");
    assert.ok(body.includes("patch.name !== undefined"), "보내지 않은 칸을 덮어쓴다");
    assert.ok(body.includes("patch.sharePhone !== undefined"), "보내지 않은 칸을 덮어쓴다");
  });

  test("빈 학원 이름은 저장되지 않는다", () => {
    // 이름이 비면 결과지 워드마크와 카톡 첫 줄이 "학원" 으로 떨어지는데,
    // 원장은 그 사실을 한참 뒤에야 안다.
    assert.ok(
      /name: z\.string\(\)\.trim\(\)\.min\(1,/.test(routesSrc),
      "빈 이름을 막지 않는다"
    );
  });

  test("일반적인 '학원 아무 칸이나 고치기' 함수를 만들지 않았다", () => {
    const code = stripComments(storageSrc);
    assert.ok(
      !/async updateTenant\(/.test(code),
      "updateTenant(부분 수정) 가 생겼다 — 결제 칸까지 닿는 통로다"
    );
  });

  console.log("\n─── 화면 연결 ───");

  const shareUi = readFileSync(
    join(process.cwd(), "client", "src", "components", "LevelTestShare.tsx"),
    "utf8"
  );

  test("두 화면(상담·레벨테스트 기록)에 같은 컴포넌트가 붙어 있다", () => {
    for (const f of ["Consultations.tsx", "LevelTests.tsx"]) {
      const src = readFileSync(join(process.cwd(), "client", "src", "pages", f), "utf8");
      assert.ok(src.includes("<LevelTestShare"), `${f} 에 공유 버튼이 없다`);
      assert.ok(src.includes('from "@/components/LevelTestShare"'), `${f} 의 import 가 없다`);
    }
  });

  test("주소는 브라우저가 보는 출처로 만든다 (프록시 뒤에서 틀리지 않게)", () => {
    assert.ok(shareUi.includes("window.location.origin"), "주소 생성 방식이 바뀌었다");
  });

  test("열어 본 횟수를 버튼 옆에 보여 준다", () => {
    assert.ok(shareUi.includes("아직 안 봄"), "0회를 말로 알려 주지 않는다");
    assert.ok(shareUi.includes("shareViewCount"));
  });

  test("복사가 실패하면 사용자에게 알린다 (조용히 성공했다고 하지 않는다)", () => {
    assert.ok(shareUi.includes("자동 복사가 막혀 있습니다"), "복사 실패 안내가 없다");
    assert.ok(/const ok = await copyText/.test(shareUi), "복사 결과를 확인하지 않는다");
  });

  test("채점 중인 결과지에는 버튼을 띄우지 않는다", () => {
    assert.ok(shareUi.includes("채점을 마치면"), "채점 중 안내가 없다");
  });

  test("전역 캐시 설정을 건드리지 않는다 (결제 화면과 공유한다)", () => {
    for (const forbidden of ["staleTime", "refetchInterval", "refetchOnWindowFocus"]) {
      assert.ok(!shareUi.includes(forbidden), `${forbidden} 가 생겼다`);
    }
  });

  test("원장이 학원 이름·전화번호를 고칠 자리가 화면에 있다", () => {
    /*
      이 칸이 화면에 없으면 학원 이름을 고칠 방법이 아예 없다 (가입할 때 적은
      값이 DB 에 그대로 남는다). "서버에 길은 있는데 누를 데가 없는" 상태를
      막는다.
    */
    const src = readFileSync(join(process.cwd(), "client", "src", "pages", "LevelTests.tsx"), "utf8");
    assert.ok(src.includes("AcademyProfileCard"), "학원 정보 카드가 없다");
    assert.ok(src.includes('"/api/academy-profile"'), "저장 주소가 안 붙어 있다");
    assert.ok(src.includes('data-testid="input-academy-name"'), "학원 이름 칸이 없다");
    assert.ok(src.includes('data-testid="input-academy-phone"'), "전화번호 칸이 없다");
    // 원장에게만 보인다 (서버도 owner 만 고치게 막아 뒀다).
    assert.ok(
      /userRole === "owner" && <AcademyProfileCard \/>/.test(src),
      "강사에게도 보인다"
    );
    // 이름을 바꾸면 오른쪽 위 배지도 같이 새로 받아야 한다.
    assert.ok(
      src.includes('queryKey: ["/api/auth/me"]'),
      "이름을 고쳐도 화면 배지가 안 바뀐다"
    );
    for (const forbidden of ["staleTime", "refetchInterval", "refetchOnWindowFocus"]) {
      assert.ok(!src.includes(forbidden), `${forbidden} 가 생겼다`);
    }
  });

  console.log(`\n통과 ${passed} · 실패 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
