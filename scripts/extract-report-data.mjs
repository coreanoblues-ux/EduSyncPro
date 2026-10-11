/**
 * 레벨테스트 결과지 문구를 앱에서 뽑아 서버 모듈로 만든다.
 *
 *   실행: npm run gen:report-data
 *   입력: apps/level-test/index.html   (원장이 인쇄하는 결과지를 만드는 앱)
 *   출력: server/level-test/reportData.ts
 *
 * ════════════════════════════════════════════════════════════════════════
 * 왜 손으로 옮기지 않는가
 * ════════════════════════════════════════════════════════════════════════
 *   원장이 인쇄해서 손에 들려 보내는 결과지와, 학부모가 카카오톡 링크로 보는
 *   결과지는 **같은 문장이어야 한다.** 학부모가 둘 다 받았을 때 문구가 다르면
 *   "어느 쪽이 진짜냐" 가 된다. 그 문구는 12개월 커리큘럼 약속이므로 특히
 *   달라서는 안 된다.
 *
 *   사람이 2만 자를 다시 타이핑하면 반드시 어딘가 한 글자가 달라진다. 그래서
 *   기계가 옮긴다. 문구를 고칠 때는 **앱(index.html)만 고치고 이 스크립트를
 *   다시 돌린다.**
 *
 * ════════════════════════════════════════════════════════════════════════
 * 왜 index.html 을 서버에서 직접 읽지 않는가
 * ════════════════════════════════════════════════════════════════════════
 *   그 파일은 5.3MB 이고 **12개월치 문제와 정답**이 들어 있다. 서버가 그걸
 *   메모리에 올릴 이유가 없고, 공개 경로가 실수로 그 파일을 건드릴 자리를
 *   만들 이유도 없다. 필요한 문구(약 20KB)만 미리 떼어 둔다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 이 스크립트는 "모양이 다르면 만들지 않는다"
 * ════════════════════════════════════════════════════════════════════════
 *   아래 검사(4단계 × 3개월, 수준 3가지, 영역 4가지…)를 하나라도 통과하지
 *   못하면 **아무것도 쓰지 않고 멈춘다.** 반쯤 맞는 커리큘럼으로 학부모에게
 *   약속을 보내는 것이 가장 나쁜 결과다.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const APP = join(process.cwd(), "apps", "level-test", "index.html");
const OUT = join(process.cwd(), "server", "level-test", "reportData.ts");

const src = readFileSync(APP, "utf8");

/** `const NAME = {...};` 를 떼어 JSON 으로 읽는다. 끝은 다음 선언 앞까지. */
function grab(name, endMarker) {
  const open = `const ${name} = `;
  const start = src.indexOf(open);
  if (start < 0) throw new Error(`${name} 선언을 앱에서 찾지 못했습니다.`);
  const from = start + open.length;
  const end = src.indexOf(endMarker, from);
  if (end < 0) throw new Error(`${name} 의 끝(${endMarker})을 찾지 못했습니다.`);
  const body = src.slice(from, end).trimEnd();
  if (!body.endsWith("};")) {
    throw new Error(`${name} 가 '};' 로 끝나지 않습니다: ${JSON.stringify(body.slice(-40))}`);
  }
  return JSON.parse(body.slice(0, -1));
}

const CURRICULUM = grab("CURRICULUM", "\nconst SCHOOL_CALENDAR");
const CURRICULUM_PERSONALIZATION = grab("CURRICULUM_PERSONALIZATION", "\nconst LEARNING_SUPPORT");
const LEARNING_SUPPORT = grab("LEARNING_SUPPORT", "\n// ");

/**
 * ACADEMY_PROGRAM 은 JSON 이 아니라 손으로 쓴 JS 객체다(작은따옴표 + 배열 짝).
 * JSON.parse 로는 읽을 수 없어서 **값만 들어 있는 식**으로 한 번 평가한다.
 *
 * 왜 이게 안전한가: 평가하는 대상은 우리 저장소의 파일이고, 아래에서 모양을
 * 검사한 뒤에만 쓴다. 외부 입력을 평가하는 것이 아니다. 그리고 이 스크립트는
 * 빌드 전에 손으로 돌리는 도구이지 서버에서 도는 코드가 아니다.
 */
function grabJsLiteral(name, endMarker) {
  const open = `const ${name} = `;
  const start = src.indexOf(open);
  if (start < 0) throw new Error(`${name} 선언을 앱에서 찾지 못했습니다.`);
  const from = start + open.length;
  const end = src.indexOf(endMarker, from);
  if (end < 0) throw new Error(`${name} 의 끝(${endMarker})을 찾지 못했습니다.`);
  const body = src.slice(from, end).trimEnd();
  if (!body.endsWith("};")) {
    throw new Error(`${name} 가 '};' 로 끝나지 않습니다: ${JSON.stringify(body.slice(-40))}`);
  }
  const literal = body.slice(0, -1);
  // 식별자·호출·템플릿이 섞여 있으면 "값만 들어 있는 식"이 아니다 → 멈춘다.
  if (/[`;]|\b(function|=>|require|import|process|global)\b/.test(literal)) {
    throw new Error(`${name} 안에 코드가 섞여 있습니다. 손으로 확인하세요.`);
  }
  return new Function(`return (${literal});`)();
}

const ACADEMY_PROGRAM_RAW = grabJsLiteral("ACADEMY_PROGRAM", "\nfunction academyProgramKey");

// ─── 모양 검사 ───────────────────────────────────────────────────────────
const BANDS = ["기초 다지기", "실력 굳히기", "한 단계 도약"];
const DOMAINS = ["문법", "독해", "서술형", "어휘"];
const SUPPORTS = ["unset", "explain", "practice", "gradual", "challenge"];

function sameSet(got, want, where) {
  const a = [...got].sort().join("|");
  const b = [...want].sort().join("|");
  if (a !== b) throw new Error(`${where}: 기대 [${b}] / 실제 [${a}]`);
}

const examIds = Object.keys(CURRICULUM);
if (examIds.length < 1) throw new Error("CURRICULUM 이 비어 있습니다.");
for (const exam of examIds) {
  sameSet(Object.keys(CURRICULUM[exam]), BANDS, `CURRICULUM.${exam} 의 수준`);
  for (const band of BANDS) {
    const t = CURRICULUM[exam][band];
    for (const key of ["title", "yearGoal", "phases"]) {
      if (!(key in t)) throw new Error(`CURRICULUM.${exam}.${band} 에 ${key} 가 없습니다.`);
    }
    if (t.phases.length !== 4) {
      throw new Error(`CURRICULUM.${exam}.${band}: 단계가 4개가 아닙니다 (${t.phases.length}).`);
    }
    for (const ph of t.phases) {
      sameSet(Object.keys(ph), ["name", "goal", "months", "check"], `단계 ${exam}.${band}.${ph.name}`);
      if (ph.months.length !== 3) {
        throw new Error(`${exam}.${band}.${ph.name}: 월 문구가 3개가 아닙니다 (${ph.months.length}).`);
      }
    }
  }
}
sameSet(Object.keys(CURRICULUM_PERSONALIZATION), BANDS, "CURRICULUM_PERSONALIZATION 의 수준");
for (const band of BANDS) {
  sameSet(Object.keys(CURRICULUM_PERSONALIZATION[band]), DOMAINS, `보완 문구 ${band} 의 영역`);
  for (const d of DOMAINS) {
    const arr = CURRICULUM_PERSONALIZATION[band][d];
    if (arr.length !== 2) throw new Error(`보완 문구 ${band}.${d}: 2개가 아닙니다 (${arr.length}).`);
  }
}
sameSet(Object.keys(LEARNING_SUPPORT), SUPPORTS, "LEARNING_SUPPORT 의 성향");

// ACADEMY_PROGRAM: items 가 [제목, 설명] 짝의 배열이다. 그대로 두면 TS 에서
// 다루기 번거로워서 { title, text } 로 바꿔 둔다 (문구는 손대지 않는다).
sameSet(Object.keys(ACADEMY_PROGRAM_RAW), ["middle", "high"], "ACADEMY_PROGRAM 의 과정");
const ACADEMY_PROGRAM = {};
for (const key of ["middle", "high"]) {
  const p = ACADEMY_PROGRAM_RAW[key];
  sameSet(Object.keys(p), ["title", "schedule", "items", "closing"], `ACADEMY_PROGRAM.${key}`);
  if (!Array.isArray(p.items) || p.items.length < 1) {
    throw new Error(`ACADEMY_PROGRAM.${key}.items 가 비어 있습니다.`);
  }
  ACADEMY_PROGRAM[key] = {
    title: p.title,
    schedule: p.schedule,
    items: p.items.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some((v) => typeof v !== "string")) {
        throw new Error(`ACADEMY_PROGRAM.${key}.items 의 짝이 [제목, 설명] 이 아닙니다.`);
      }
      return { title: pair[0], text: pair[1] };
    }),
    closing: p.closing,
  };
}

// ─── 안전 검사: 문항·정답·이미지가 섞여 들어오면 멈춘다 ──────────────────
const payload = JSON.stringify({
  CURRICULUM,
  CURRICULUM_PERSONALIZATION,
  LEARNING_SUPPORT,
  ACADEMY_PROGRAM,
});
if (payload.includes("base64")) {
  throw new Error("커리큘럼 문구에 이미지(base64)가 섞여 들어왔습니다. 추출 범위를 확인하세요.");
}
if (payload.length > 200_000) {
  throw new Error(`추출 결과가 너무 큽니다(${payload.length}자). 문항이 섞여 들어온 경우입니다.`);
}

// ─── 쓰기 ────────────────────────────────────────────────────────────────
const j = (v) => JSON.stringify(v, null, 2);

const out = `/**
 * 레벨테스트 결과지 2페이지(12개월 커리큘럼)에 쓰는 문구 모음.
 *
 * ⚠️ 이 파일은 **손으로 쓴 것이 아니다.** apps/level-test/index.html 안의
 *    CURRICULUM · CURRICULUM_PERSONALIZATION · LEARNING_SUPPORT 를 기계가
 *    그대로 옮긴 것이다. 원장이 인쇄해 손에 들려 보내는 결과지와 학부모가
 *    링크로 보는 결과지의 문구가 **한 글자도 달라서는 안 되기 때문이다.**
 *
 *    문구를 고칠 일이 생기면 **앱(index.html) 쪽을 고치고 다시 뽑는다:**
 *        npm run gen:report-data
 *    여기만 고치면 인쇄물과 링크가 조용히 달라진다.
 *
 *  · CURRICULUM[시험][수준] → { title, yearGoal, phases[4] }
 *      phases 는 "이해 → 적용 → 확장 → 자기 점검" 4단계, 각 단계가 3개월이다.
 *  · CURRICULUM_PERSONALIZATION[수준][영역][0..1] → 가장 약한 영역을 위해
 *      1·2단계의 둘째 달 문구를 갈아 끼우는 문장.
 *  · LEARNING_SUPPORT[성향] → 결과지 맨 아래 "학생에게 맞춘 지도" 문장.
 *  · ACADEMY_PROGRAM[중등부/고등부] → 실제 수업 운영 안내.
 */

export type ReportPhase = {
  name: string;
  goal: string;
  months: string[];
  check: string;
};

export type ReportTrack = {
  title: string;
  yearGoal: string;
  phases: ReportPhase[];
};

/** 수준 세 가지. 총점으로 자동 판정하고, 원장이 손으로 바꿀 수도 있다. */
export const REPORT_BANDS = ${j(BANDS)} as const;

/**
 * 결과지에 쓰는 영역 순서.
 *
 * ⚠️ DB 칼럼 순서(reading·grammar·vocab·writing)와 **다르다.** 인쇄물이
 *    문법 → 독해 → 서술형 → 어휘 순으로 나오므로 그 순서를 지킨다.
 *    앱의 domains() 와 같은 배열이다.
 */
export const REPORT_DOMAINS = ${j(DOMAINS)} as const;

export const CURRICULUM: Record<string, Record<string, ReportTrack>> =
${j(CURRICULUM)};

export const CURRICULUM_PERSONALIZATION: Record<string, Record<string, string[]>> =
${j(CURRICULUM_PERSONALIZATION)};

export type LearningSupport = { label: string; text: string };

export const LEARNING_SUPPORT: Record<string, LearningSupport> =
${j(LEARNING_SUPPORT)};

export type AcademyProgram = {
  title: string;
  schedule: string;
  items: { title: string; text: string }[];
  closing: string;
};

/**
 * 실제 수업 운영 안내. 결과지에는 **배정 과정에 맞는 쪽만** 나온다.
 * (중1~중3 → middle, 고1~고3 → high, 그 밖에는 안내 문장만)
 */
export const ACADEMY_PROGRAM: Record<string, AcademyProgram> =
${j(ACADEMY_PROGRAM)};
`;

writeFileSync(OUT, out, "utf8");
console.log(
  `✔ 결과지 문구 추출 완료 — 시험 ${examIds.length}종 × 수준 ${BANDS.length} ` +
    `(${out.length.toLocaleString()}자) → server/level-test/reportData.ts`
);
