/**
 * 레벨테스트 서버 저장 검증.
 *
 * 실행: npx tsx scripts/test-level-test.ts  (= npm run test:level-test)
 *
 * ── 이 테스트가 막으려는 사고 ──
 *
 *  ① 앱이 보내는 본문과 서버가 받는 스키마가 어긋나는 것.
 *     앱은 5.5MB 단일 HTML 안의 자바스크립트이고, 서버는 zod 스키마다. 둘은
 *     서로를 import 하지 않으므로 타입 검사가 불일치를 잡아 주지 못한다.
 *     그래서 **HTML 에서 저장 블록을 실제로 꺼내 실행**하고, 그 결과를
 *     **진짜 서버 스키마**에 통과시킨다. 한쪽만 고쳤을 때 여기서 터진다.
 *
 *  ② 로고 base64 가 결과지 원본(rawState)에 섞여 들어가는 것.
 *     앱 state 에는 11만 자짜리 로고가 들어 있다. 그걸 그대로 보내면 한 건이
 *     수백 KB가 되어 저장이 실패하거나 DB 가 이미지 사본으로 부푼다.
 *     payload 를 만들 때 이미지가 빠지는지 매번 확인한다.
 *
 *  ③ "엑셀 파일 직접 덮어쓰기" 코드가 되살아나는 것.
 *     이제 저장 위치는 서버다. File System Access API 로 파일을 직접 쓰던
 *     옛 경로가 다시 들어오면 같은 기록이 두 곳에 갈라져 쌓인다.
 *
 *  ④ 결과지 인쇄 레이아웃이 깨지는 것.
 *     이 기능의 가치는 학부모에게 주는 종이다. A4 mm 단위 인쇄 CSS 가
 *     남아 있는지 확인한다 (저장 기능을 손보다 건드리기 쉬운 부분이다).
 *
 * DB 연결은 필요 없다. 순수 로직만 본다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { saveLevelTestBodySchema } from "../shared/schema";

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

// package.json 에 "type": "module" 이라 __dirname 이 없다. import.meta 로 구한다.
const here = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = path.resolve(here, "..", "apps", "level-test", "index.html");
const html = readFileSync(APP_HTML, "utf8");

// ─── 앱의 저장 블록을 꺼내 실행할 준비 ───────────────────────────────────
//
// 마지막 <script> 블록이 "서버 저장" 블록이다. 앞쪽 블록들은 문항 데이터와
// SheetJS(수 MB)라 실행하지 않는다 — 꺼낼 범위를 마지막 하나로 한정한다.
function extractSaveBlock(): string {
  const open = html.lastIndexOf("<script>");
  const close = html.lastIndexOf("</script>");
  assert.ok(open > 0 && close > open, "저장 블록을 찾지 못했습니다.");
  return html.slice(open + "<script>".length, close);
}

/**
 * HTML 안에서 이름으로 함수 한 개의 소스만 떼어 온다.
 *
 * 채점 화면 코드는 로고 base64 가 섞여 240KB 가 넘는 블록 안에 있고, DOM 을
 * 잔뜩 만진다. 블록 전체를 돌리는 건 과하므로, 검증하려는 함수 하나만 꺼내
 * 가짜 환경에서 실행한다. 중괄호 짝을 세어 끝을 찾는다 (이 함수들 안에는
 * 중괄호가 든 문자열이 없다 — 있으면 테스트가 먼저 깨지므로 금방 안다).
 */
function extractFunction(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} 함수를 찾지 못했습니다.`);
  let depth = 0;
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${name} 함수의 끝을 찾지 못했습니다.`);
}

/** 테스트용 가짜 앱 상태. 로고는 일부러 크게 넣어 둔다 (사고 ②의 재현). */
function makeState() {
  return {
    exam: "m3",
    tab: "select",
    student: "  홍길동  ", // 앞뒤 공백 — trim 되는지 본다
    school: "숭의중학교",
    grade: "중2",
    parentPhone: "010-1234-1234",
    teacher: "김선생",
    date: "2026-10-11",
    goal: "기초를 탄탄하게",
    minutes: 30,
    brand: "페이지원영어학원",
    color: "#F96E00",
    logo: "data:image/png;base64," + "A".repeat(120000),
    marks: { "m3:1": "right", "m3:2": "wrong", "m1:5": "right" },
    edits: { "m3:1": { prompt: "고친 문항" }, "m2:9": { prompt: "다른 회차" } },
    custom: { m3: [{ id: "C1" }], m2: [{ id: "C9" }] },
    notes: "어휘가 약함",
    focus: "1",
    consultationId: "",
    trackOverride: "",
    startMonth: "",
    noExamSemester: "",
    learningSupport: "unset",
    classProgram: "auto",
  };
}

/**
 * 저장 블록을 Node 안에서 돌린다.
 *
 * 브라우저 전역(document/location/XLSX/…)과 앱 상단 함수(summary/domains/…)는
 * 가짜로 넣는다. 우리가 보려는 것은 "payload 를 어떻게 만드는가" 뿐이고,
 * 채점 계산과 화면 그리기는 이 테스트의 대상이 아니다.
 */
function runSaveBlock(state: ReturnType<typeof makeState>) {
  const sandbox: any = {
    state,
    console,
    URLSearchParams,
    crypto: globalThis.crypto,
    location: { protocol: "https:", search: "" },
    // 채점 결과 (고정값). 총점 50, 정답 1 / 평가 2, 미채점 3, 미응시 4.
    summary: () => ({ qs: [], valid: [{}, {}], right: 1, wrong: 1, pending: 3, skip: 4, score: 50 }),
    // 영역별 점수. 서술형은 일부러 null (미평가) 로 둔다.
    domains: () => [
      { name: "문법", score: 70 },
      { name: "독해", score: 80 },
      { name: "서술형", score: null },
      { name: "어휘", score: 90 },
    ],
    exam: () => ({ level: 3, title: "Bridge" }),
    save: () => {},
    render: () => {},
    renderSelect: () => "<label>현재 학년",
    esc: (s: any) => String(s ?? ""),
    toast: () => {},
    fetch: async () => {
      throw new Error("이 테스트는 서버를 호출하지 않습니다.");
    },
    XLSX: { utils: { book_new: () => ({ SheetNames: [], Sheets: {} }), aoa_to_sheet: () => ({}) }, writeFile: () => {} },
    // 저장 성공 신호(다른 탭 깨우기)를 확인하려고 둔다.
    localStorage: (() => {
      const store: Record<string, string> = {};
      return { store, setItem: (k: string, v: string) => { store[k] = v; }, getItem: (k: string) => store[k] ?? null };
    })(),
    document: {
      getElementById: () => null,
      createElement: () => ({}),
      querySelector: () => ({ prepend: () => {} }),
      body: { append: () => {} },
    },
  };

  // const 로 선언된 값(LEDGER_COLUMNS)은 vm 컨텍스트의 속성이 되지 않는다.
  // 꺼내 보려면 블록 끝에서 명시적으로 내보내야 한다.
  const code = extractSaveBlock() + "\n;__exports={LEDGER_COLUMNS:LEDGER_COLUMNS};";
  vm.runInNewContext(code, sandbox, { timeout: 5000 });
  return sandbox;
}

async function main() {
  console.log("─── 레벨테스트 서버 저장 ───");

  // ── 1) 앱이 만든 본문이 서버 스키마를 통과한다 ──────────────────────
  await test("앱이 만든 저장 본문이 서버 스키마를 그대로 통과한다", () => {
    const state = makeState();
    const app = runSaveBlock(state);
    const payload = app.levelTestPayload();

    const parsed = saveLevelTestBodySchema.safeParse(payload);
    assert.ok(
      parsed.success,
      "서버가 앱 본문을 거부했습니다: " +
        (parsed.success ? "" : JSON.stringify(parsed.error.errors))
    );
  });

  await test("점수·개수가 채점 결과대로 담긴다", () => {
    const app = runSaveBlock(makeState());
    const p = app.levelTestPayload();
    assert.equal(p.studentName, "홍길동", "이름 앞뒤 공백이 제거돼야 한다");
    assert.equal(p.totalScore, 50);
    assert.equal(p.readingScore, 80);
    assert.equal(p.grammarScore, 70);
    assert.equal(p.vocabScore, 90);
    assert.equal(p.writingScore, null, "미평가 영역은 null 이어야 한다 ('미평가' 문자열이면 서버가 거부한다)");
    assert.equal(p.questionCount, 2);
    assert.equal(p.correctCount, 1);
    assert.equal(p.pendingCount, 3);
    assert.equal(p.skippedCount, 4);
    assert.equal(p.examCode, "m3");
    assert.equal(p.examTitle, "Level 3 Bridge");
  });

  await test("같은 학생·같은 회차는 같은 기록 ID 를 쓴다 (덮어쓰기 키)", () => {
    const state = makeState();
    const app = runSaveBlock(state);
    const first = app.levelTestPayload();
    const second = app.levelTestPayload();
    assert.equal(first.clientRecordId, second.clientRecordId, "두 번 저장하면 새 줄이 생긴다");
    assert.ok(first.clientRecordId.endsWith(":m3"), "기록 ID 뒤에 시험 코드가 붙어야 한다");
    assert.ok(state.consultationId.length > 0, "상담 ID 가 상태에 기록돼야 한다");
  });

  await test("회차를 바꾸면 기록 ID 도 달라진다 (회차별로 한 줄)", () => {
    const state = makeState();
    const app = runSaveBlock(state);
    const m3 = app.levelTestPayload().clientRecordId;
    state.exam = "m5";
    const m5 = app.levelTestPayload().clientRecordId;
    assert.notEqual(m3, m5);
    assert.ok(m5.endsWith(":m5"));
  });

  // ── 2) 로고·이미지가 결과지 원본에 섞이지 않는다 ────────────────────
  await test("결과지 원본에 로고 base64 가 들어가지 않는다", () => {
    const app = runSaveBlock(makeState());
    const raw = app.levelTestPayload().rawState;
    const json = JSON.stringify(raw);
    assert.ok(!json.includes("base64"), "rawState 에 base64 이미지가 섞였습니다");
    assert.equal(raw.logo, undefined, "logo 는 서버로 보내지 않는다");
    assert.ok(json.length < 60_000, `rawState 가 너무 큽니다 (${json.length}자)`);
  });

  await test("결과지 원본에는 지금 회차의 채점만 담긴다", () => {
    const app = runSaveBlock(makeState());
    const raw = app.levelTestPayload().rawState;
    assert.deepEqual(Object.keys(raw.marks).sort(), ["m3:1", "m3:2"], "다른 회차 채점이 따라왔다");
    assert.deepEqual(Object.keys(raw.edits), ["m3:1"], "다른 회차 문항 수정이 따라왔다");
    assert.deepEqual(Object.keys(raw.custom), ["m3"], "다른 회차 추가 문항이 따라왔다");
  });

  await test("로고가 섞이면 서버가 거부한다 (크기 안전망)", () => {
    const state = makeState();
    const app = runSaveBlock(state);
    const payload = app.levelTestPayload();
    // 규칙이 깨진 상황을 일부러 만든다.
    payload.rawState = { ...payload.rawState, logo: state.logo };
    const parsed = saveLevelTestBodySchema.safeParse(payload);
    assert.equal(parsed.success, false, "60KB 초과 rawState 를 서버가 통과시켰다");
  });

  // ── 3) 서버 스키마 자체의 방어선 ────────────────────────────────────
  function base() {
    const app = runSaveBlock(makeState());
    return app.levelTestPayload();
  }

  await test("학생 이름이 없으면 거부한다", () => {
    const p = { ...base(), studentName: "   " };
    assert.equal(saveLevelTestBodySchema.safeParse(p).success, false);
  });

  await test("날짜 형식이 YYYY-MM-DD 가 아니면 거부한다", () => {
    for (const bad of ["2026/10/11", "26-10-11", "2026-10-11T00:00:00Z", ""]) {
      assert.equal(
        saveLevelTestBodySchema.safeParse({ ...base(), testDate: bad }).success,
        false,
        `"${bad}" 를 통과시켰다`
      );
    }
  });

  await test("기록 ID 가 없으면 거부한다 (덮어쓰기 키가 비면 중복이 쌓인다)", () => {
    const p: any = base();
    delete p.clientRecordId;
    assert.equal(saveLevelTestBodySchema.safeParse(p).success, false);
  });

  await test("0~100 범위를 벗어난 점수는 거부한다", () => {
    for (const bad of [101, -1, 1.5]) {
      assert.equal(
        saveLevelTestBodySchema.safeParse({ ...base(), totalScore: bad }).success,
        false,
        `${bad} 점을 통과시켰다`
      );
    }
  });

  await test("채점이 덜 끝난 상태(점수 null)는 허용한다", () => {
    const p = { ...base(), totalScore: null, readingScore: null, writingScore: null };
    assert.equal(saveLevelTestBodySchema.safeParse(p).success, true);
  });

  await test("본문에 tenantId/createdBy 를 끼워 넣어도 버린다 (다른 학원 기록 방지)", () => {
    const p: any = { ...base(), tenantId: "남의-학원", createdBy: "남의-계정", id: "강제-id" };
    const parsed = saveLevelTestBodySchema.safeParse(p);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal((parsed.data as any).tenantId, undefined);
      assert.equal((parsed.data as any).createdBy, undefined);
      assert.equal((parsed.data as any).id, undefined);
    }
  });

  // ── 4) 앱 파일 자체의 회귀 방어 ─────────────────────────────────────
  await test("엑셀 파일 직접 덮어쓰기 코드가 되살아나지 않았다", () => {
    for (const banned of ["showSaveFilePicker", "showOpenFilePicker", "createWritable"]) {
      assert.ok(!html.includes(banned), `${banned} 가 다시 들어왔습니다 — 저장 경로가 두 갈래가 됩니다`);
    }
  });

  await test("앱이 서버 저장 경로를 호출한다", () => {
    assert.ok(html.includes("/api/level-tests"), "서버 저장 경로가 없습니다");
  });

  await test("결과지 A4 인쇄 레이아웃이 남아 있다", () => {
    // 결과지 용지 크기. 이 값이 사라지면 학부모용 결과지 여백이 틀어진다.
    assert.ok(html.includes("186mm"), "결과지 가로 치수(186mm)가 사라졌습니다");
    assert.ok(html.includes("270mm"), "결과지 세로 치수(270mm)가 사라졌습니다");
  });

  await test("엑셀 내려받기 열 구성이 예전과 같다 (19칸)", () => {
    const app = runSaveBlock(makeState());
    const cols = app.__exports.LEDGER_COLUMNS;
    assert.equal(cols.length, 19, "열 개수가 바뀌면 원장이 보던 엑셀 서식이 깨진다");
    assert.equal(cols[0], "번호");
    assert.equal(cols[1], "학생 이름");
    assert.equal(cols[18], "기록 ID");

    // 서버 기록 한 건을 엑셀 한 줄로 바꿨을 때 열 수가 맞아야 한다.
    const row = app.ledgerRow({
      studentName: "홍길동",
      school: "숭의중",
      grade: "중2",
      parentPhone: "010-0000-0000",
      examTitle: "Level 3 Bridge",
      totalScore: 50,
      readingScore: 80,
      grammarScore: 70,
      vocabScore: 90,
      writingScore: null,
      questionCount: 2,
      correctCount: 1,
      pendingCount: 3,
      skippedCount: 4,
      teacherName: "김선생",
      notes: "메모",
      updatedAt: "2026-10-11T03:00:00.000Z",
      clientRecordId: "abc:m3",
    });
    assert.equal(row.length, cols.length, "엑셀 한 줄의 칸 수가 열 수와 다르다");
    assert.equal(row[6], 50, "총점 위치가 어긋났다");
    assert.equal(row[10], "미평가", "미평가 영역은 '미평가' 로 표기한다");
    assert.equal(row[18], "abc:m3", "기록 ID 위치가 어긋났다");
  });

  await test("file:// 로 열면 서버 저장을 시도하지 않고 안내한다", async () => {
    const app = runSaveBlock(makeState());
    app.location.protocol = "file:";
    await assert.rejects(
      () => app.levelTestApi("/api/level-tests"),
      /EduSyncPro 에서 열어야/,
      "file:// 로 열었을 때 원인을 알려 주지 않는다"
    );
  });

  // ── 전체 정답으로 체크 (채점 속도) ───────────────────────────────────
  //
  // 원장이 채점하는 방식은 "맞은 것을 세는" 게 아니라 "틀린 것만 골라내는"
  // 것이다. 전부 O 로 깔고 틀린 번호만 X 로 바꾼다. 이 버튼이 그 출발점이라
  // 다음 두 가지가 절대 깨지면 안 된다:
  //   · 이미 매긴 O·X·미응시를 덮어쓰지 않을 것 (채점하던 걸 날리면 큰일이다)
  //   · 되돌리기(Z)로 복구할 수 있게 이력을 남길 것
  function runBulkRightPending(marks: Record<string, string>, confirmAnswer = true) {
    const ids = ["1", "2", "3", "4", "5"];
    const sandbox: any = {
      state: { exam: "m3", marks },
      gradingHistory: [] as any[],
      qkey: (q: any) => "m3:" + q.id,
      questions: () => ids.map((id) => ({ id })),
      status: (q: any) => marks["m3:" + q.id] || "pending",
      confirm: () => confirmAnswer,
      toast: (m: string) => {
        sandbox.lastToast = m;
      },
      save: () => {},
      render: () => {},
      lastToast: "",
    };
    vm.runInNewContext(extractFunction("bulkRightPending") + "\n;bulkRightPending();", sandbox, {
      timeout: 5000,
    });
    return sandbox;
  }

  await test("전체 정답으로 체크: 빈 시험지를 한 번에 전부 정답으로 만든다", () => {
    const marks: Record<string, string> = {};
    const s = runBulkRightPending(marks);
    assert.deepEqual(Object.values(marks), ["right", "right", "right", "right", "right"]);
    assert.equal(s.gradingHistory.length, 5, "되돌리기 이력이 없으면 Z 로 복구할 수 없다");
  });

  await test("전체 정답으로 체크: 이미 매긴 오답·미응시는 건드리지 않는다", () => {
    const marks: Record<string, string> = { "m3:2": "wrong", "m3:4": "skip" };
    runBulkRightPending(marks);
    assert.equal(marks["m3:2"], "wrong", "틀렸다고 매긴 문항이 정답으로 뒤집혔다");
    assert.equal(marks["m3:4"], "skip", "미응시로 매긴 문항이 정답으로 뒤집혔다");
    assert.equal(marks["m3:1"], "right");
    assert.equal(marks["m3:5"], "right");
  });

  await test("전체 정답으로 체크: 채점 중이면 한 번 묻고, 거절하면 아무것도 바꾸지 않는다", () => {
    const marks: Record<string, string> = { "m3:2": "wrong" };
    runBulkRightPending(marks, false);
    assert.deepEqual(marks, { "m3:2": "wrong" }, "확인창에서 취소했는데 채점이 바뀌었다");
  });

  await test("전체 정답으로 체크: 빈 시험지에서는 확인창을 띄우지 않는다", () => {
    // 아무것도 채점하지 않았으면 이 버튼이 곧 채점의 시작이다. 매번 묻는 것은
    // 속도를 위해 만든 버튼의 취지를 깎는다. confirm 이 '취소'를 돌려줘도
    // 그대로 진행돼야 한다 = 아예 묻지 않았다는 뜻.
    const marks: Record<string, string> = {};
    runBulkRightPending(marks, false);
    assert.equal(marks["m3:1"], "right", "빈 시험지인데도 확인창을 띄우고 있다");
  });

  await test("전체 정답으로 체크: 채점 화면에 버튼이 남아 있다", () => {
    assert.ok(html.includes("전체 정답으로 체크"), "채점 속도를 올리는 버튼이 사라졌습니다");
    assert.ok(
      html.includes('onclick="bulkRightPending()"'),
      "버튼이 전체 정답 처리 함수에 연결돼 있지 않습니다"
    );
    // 틀린 것만 X 로 바꾸는 흐름이므로 문항판의 X 버튼도 함께 있어야 한다.
    assert.ok(html.includes("markFromTile"), "문항판 O/X 버튼이 사라졌습니다");
  });

  // ── 저장 직후 다른 탭을 깨우는 신호 ──────────────────────────────────
  //
  // 고정하려는 사고 (2026-10): 저장은 성공했는데 EduSyncPro 목록 화면은
  // "아직 기록이 없습니다" 를 계속 보여 줬다. 저장 버튼은 레벨테스트 앱 탭에
  // 있고 목록은 관리 화면 탭에 있는데, 이 앱의 조회 캐시가 한 번 받아온 뒤로는
  // 다시 묻지 않도록 설정돼 있었기 때문이다. 원장 눈에는 저장 실패로 보인다.
  //
  // 두 탭을 잇는 끈은 localStorage 키 문자열 하나뿐이다. 양쪽이 같은 문자열을
  // 쓰는지는 타입 검사가 봐 주지 못하므로 여기서 직접 맞춰 본다.
  const SAVED_SIGNAL_KEY = "edusync-level-test-saved";

  await test("저장에 성공하면 다른 탭이 알아들을 표시를 남긴다", async () => {
    const app = runSaveBlock(makeState());
    app.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: "saved" }) });
    await app.saveStudentToServer();
    assert.ok(
      app.localStorage.store[SAVED_SIGNAL_KEY],
      "저장 신호가 없으면 목록 탭이 갱신되지 않아 '저장이 안 된다' 는 신고가 다시 들어온다"
    );
  });

  await test("저장에 실패하면 표시를 남기지 않는다", async () => {
    const app = runSaveBlock(makeState());
    app.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "서버 오류" }) });
    await app.saveStudentToServer();
    assert.equal(
      app.localStorage.store[SAVED_SIGNAL_KEY],
      undefined,
      "실패했는데 저장 신호를 보내면 목록이 헛돌고 원장이 저장된 줄 안다"
    );
  });

  await test("목록 화면이 앱과 같은 신호 키를 듣는다", () => {
    const page = readFileSync(
      path.resolve(here, "..", "client", "src", "pages", "LevelTests.tsx"),
      "utf8"
    );
    assert.ok(page.includes(SAVED_SIGNAL_KEY), "목록 화면의 신호 키가 앱과 다릅니다");
    assert.ok(
      /refetchOnWindowFocus:\s*true/.test(page),
      "다른 탭에서 저장하고 돌아왔을 때 목록을 다시 불러오지 않습니다"
    );
    assert.ok(
      /refetchOnMount:\s*"always"/.test(page),
      "메뉴를 다시 눌러 들어와도 예전 목록이 그대로 보입니다"
    );
  });

  // ─── 라우터 수준 검증 ──────────────────────────────────────────────────
  //
  // 위 테스트들은 "본문이 맞는지" 를 본다. 여기서는 "문이 잠겨 있는지" 를 본다.
  // 앱 HTML 안에는 12개월치 문제와 **정답**이 들어 있다. 이 경로가 로그인 없이
  // 열리면 그 파일이 그대로 밖으로 나간다. 코드만 읽어서는 미들웨어가 실제로
  // 걸려 있는지 확신할 수 없으므로, 진짜 express 서버를 띄워 응답 코드를 본다.
  // (DB 는 쓰지 않는다 — 인증에서 막히므로 핸들러까지 가지 않는다.)
  await testRoutes();

  console.log(`\n통과 ${passed} · 실패 ${failed}`);
  if (failed > 0) process.exit(1);
}

async function testRoutes() {
  const express = (await import("express")).default;
  const { default: levelTestRouter, resolveAppHtml } = await import("../server/level-test/routes");

  const app = express();
  app.use(express.json());
  app.use(levelTestRouter);

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  // 쿠키 없이 두드린다 = 로그인하지 않은 외부인.
  const closed: Array<[string, string]> = [
    ["GET", "/level-test/app"],
    ["GET", "/api/level-tests"],
    ["GET", "/api/level-tests/11111111-1111-1111-1111-111111111111"],
    ["POST", "/api/level-tests"],
    ["DELETE", "/api/level-tests/11111111-1111-1111-1111-111111111111"],
  ];

  for (const [method, p] of closed) {
    await test(`로그인 없이 ${method} ${p} → 401`, async () => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      assert.equal(
        r.status,
        401,
        `인증 없이 ${r.status} 이 돌아왔습니다. 문제·정답이 담긴 경로가 열려 있습니다`
      );
    });
  }

  await test("앱 HTML 경로가 실제로 찾아진다", () => {
    const file = resolveAppHtml();
    assert.ok(
      file,
      "apps/level-test/index.html 도 dist/level-test/index.html 도 없습니다. " +
        "이 상태로 배포하면 '새 레벨테스트 시작' 이 오류 화면을 띄운다"
    );
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
