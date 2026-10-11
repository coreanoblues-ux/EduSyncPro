/**
 * 학부모가 링크로 보는 **실제 결과지** — 2페이지를 휴대폰 한 화면으로.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 왜 이 파일이 생겼는가 (앞 버전과 무엇이 다른가)
 * ════════════════════════════════════════════════════════════════════════
 *   처음 만든 학부모 링크는 총점·영역별 점수·선생님 메모만 있는 **간단한 한
 *   장**이었다. 원장이 인쇄해서 손에 들려 보내는 결과지는 2페이지(진단 +
 *   12개월 커리큘럼)인데, 링크로 받은 학부모는 그 절반도 못 본 셈이었다.
 *   등록을 망설이는 학부모에게 가장 중요한 쪽이 **커리큘럼 페이지**인데
 *   그게 빠져 있었다.
 *
 *   그래서 이 파일이 인쇄물과 **같은 내용**을 그린다. 문구는 사람이 다시
 *   타이핑하지 않고 기계가 앱에서 뽑아 둔 것을 쓴다
 *   (server/level-test/reportData.ts · npm run gen:report-data).
 *
 * ════════════════════════════════════════════════════════════════════════
 * 인쇄물과 **일부러 다르게** 한 것 — 고치기 전에 읽을 것
 * ════════════════════════════════════════════════════════════════════════
 * 1) **학교 이름을 넣지 않는다.** 인쇄물에는 "○○중 · 중2" 가 나온다. 종이는
 *    학부모 손에 직접 건네지만, 링크는 카카오톡으로 전달되다가 엉뚱한 방에
 *    잘못 올라갈 수 있다. 그때 "이름 + 학교 + 학년 + 점수" 가 한 화면에 모이면
 *    그 학생이 누구인지 바로 특정된다. 학년만 남기면 그 연결이 끊긴다.
 *    학부모는 자기 아이 학교를 이미 알고 있으므로 잃는 것이 없다.
 *
 * 2) **상담 메모(notes)를 넣지 않는다.** 이건 인쇄물과 **같아진** 쪽이다.
 *    레벨테스트 앱은 "상담 메모는 교사용으로 저장되며 결과지에는 출력되지
 *    않습니다" 라고 분명히 적어 두었는데, 앞 버전 링크는 그 메모를 "선생님
 *    의견" 이라는 제목으로 학부모에게 그대로 보여 주고 있었다. 교사용으로
 *    적은 글("어머니가 성적에 민감함" 같은 것)이 학부모 화면에 뜨는 사고가
 *    한 번만 나도 되돌릴 수 없다. 이제 안 보낸다.
 *
 * 3) **영역별 "정답 N / 평가 M" 을 쓰지 않는다.** 인쇄물은 문항 하나하나의
 *    채점 상태를 들고 있어서 영역별 문항 수를 셀 수 있다. 서버 DB 에는
 *    영역별 **점수만** 저장된다(reading/grammar/vocab/writing). 없는 숫자를
 *    추측해서 쓰지 않고, 그 줄만 뺀다.
 *
 * 4) **종이 2장 → 한 번에 쭉 내려 읽는 한 장.** 인쇄물 CSS 는 A4 여백을 mm
 *    단위로 맞춘 것이라 휴대폰에서 쓸 수 없다. 여기 CSS 는 처음부터 좁은
 *    화면 기준으로 새로 썼다. 대신 "진단 / 다음 12개월" 두 덩어리의 구분과
 *    순서는 종이와 똑같이 유지한다.
 *
 * 5) **단계별 기간(2026년 11월 – 2027년 1월)을 적어 준다.** 인쇄물은 이 값을
 *    계산해 두고도 지면이 좁아 표시하지 않는다. 휴대폰은 세로로 길어서 넣을
 *    자리가 있고, 학부모가 가장 궁금해하는 것이 "언제까지 무엇을 하느냐" 다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 절대 깨뜨리지 말 것
 * ════════════════════════════════════════════════════════════════════════
 *   · **던지지 않는다.** 이 함수가 예외를 내면 학부모는 오류 화면을 본다.
 *     모르는 시험 코드·빈 설정값·깨진 날짜가 들어와도 그 부분만 빼고 그린다.
 *     (앱 쪽 원본은 CURRICULUM[exam][band] 를 바로 참조해서 모르는 코드면
 *      터진다. 서버에서는 그럴 수 없어 전부 ?. 와 기본값으로 받아 둔다.)
 *   · **스크립트가 없다.** 라우터가 CSP 로 script-src 를 통째로 막는다.
 *     인터랙션이 필요해지면 CSP 부터 다시 생각할 것.
 *   · **모든 바깥값은 esc() 를 통과한다.** 학생 이름·교사 이름·학원 이름은
 *     사람이 자유롭게 타이핑한 글이다.
 *   · **DB 를 모른다.** 이 파일은 storage 를 import 하지 않는다. 그래서
 *     테스트(npm run test:share)가 DB 접속 없이 HTML 을 만들어 검사할 수 있다.
 */

import type { LevelTest } from "@shared/schema";
import { escapeHtml as esc, formatKoreanDate } from "./shareLink";
import {
  CURRICULUM,
  CURRICULUM_PERSONALIZATION,
  LEARNING_SUPPORT,
  ACADEMY_PROGRAM,
  REPORT_DOMAINS,
  type ReportTrack,
} from "../level-test/reportData";

// ─── 결과지 설정값 ───────────────────────────────────────────────────────

/**
 * 원장이 앱에서 고른 결과지 설정. 레벨테스트 기록의 rawState 안에 들어 있다.
 *
 * ⚠️ rawState 를 **그대로 넘기지 않는다.** 그 안에는 문항별 채점 상태가
 *    들어 있고, 그건 학부모에게 보낼 것이 아니다. 라우터가 이 네 칸만 골라
 *    뽑아서 넘긴다(shareRoutes.ts). 칸을 늘릴 때는 "링크가 잘못 전달됐을 때
 *    이것이 새도 괜찮은가" 를 먼저 묻는다.
 */
export type ShareReportSettings = {
  /** "시험코드|수준" — 원장이 자동 판정을 손으로 바꾼 경우에만 값이 있다. */
  trackOverride?: string | null;
  /** "YYYY-MM" — 커리큘럼 시작월을 직접 정한 경우. 없으면 진단 다음 달. */
  startMonth?: string | null;
  /** unset | explain | practice | gradual | challenge */
  learningSupport?: string | null;
  /** auto | middle | high — 배정 과정. auto 면 학년으로 판단한다. */
  classProgram?: string | null;
};

/**
 * rawState(JSON) 에서 결과지 설정 네 칸만 골라 뽑는다.
 *
 * ⚠️ 이 함수가 유일한 통로다. 라우터가 rawState 를 그대로 넘기지 못하게
 *    여기서 막는다. rawState 안에는 아래가 같이 들어 있고, 전부
 *    학부모에게 보낼 것이 아니다.
 *      marks       문항별 채점 상태 → 시험지 복원에 쓰일 수 있다
 *      edits       교사가 손으로 고친 흔적
 *      parentPhone 학부모 연락처
 *      school      학교 이름
 *    칸을 늘릴 때는 "링크가 엉뚱한 단톡방에 전달됐을 때 이것이 새도
 *    괜찮은가" 를 먼저 묻는다. 문자열만, 40자까지만 통과시킨다.
 *
 * DB 를 쓰지 않는다(그래서 테스트가 Postgres 없이 돈다).
 */
export function pickReportSettings(rawState: unknown): ShareReportSettings {
  const raw = (rawState ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length <= 40 ? v : undefined;
  return {
    trackOverride: str(raw.trackOverride),
    startMonth: str(raw.startMonth),
    learningSupport: str(raw.learningSupport),
    classProgram: str(raw.classProgram),
  };
}

type YM = { y: number; m: number };

/** "YYYY-MM-DD" → {y,m,d}. 모양이나 날짜가 틀리면 null. 앱과 같은 검사다. */
function dateParts(value: unknown): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  const ok =
    y >= 1900 &&
    y <= 2198 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d;
  return ok ? { y, m, d } : null;
}

/** 기준 연월에서 offset 개월 뒤. 12월을 넘어가는 계산을 Date 에 맡긴다. */
function addMonths(y: number, m: number, offset: number): YM {
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

function monthLabel(p: YM): string {
  return `${p.y}년 ${p.m}월`;
}

// ─── 모델 만들기 ─────────────────────────────────────────────────────────

type DomainRow = { name: string; score: number | null };

export type ShareReportModel = {
  /** 총점으로 자동 판정한 수준. 원장이 손으로 바꾸면 band 와 달라진다. */
  autoBand: string;
  band: string;
  /** 커리큘럼을 찾지 못하면 null — 그때는 2페이지를 그리지 않는다. */
  track: ReportTrack | null;
  domains: DomainRow[];
  /** 점수가 있는 영역 중 가장 낮은 것. 전부 미평가면 null. */
  priority: DomainRow | null;
  /** 80점 이상인 영역들. */
  strong: DomainRow[];
  /** 커리큘럼 시작월. 진단 날짜가 깨져 있으면 null. */
  start: YM | null;
  phases: {
    index: number;
    name: string;
    goal: string;
    check: string;
    /** 가장 약한 영역을 위한 보완 문구. 1·2단계에만 붙는다. */
    weakFocus: string | null;
    /** "2026년 11월 – 2027년 1월" 또는 null(진단 날짜 미확인). */
    period: string | null;
  }[];
  supportText: string;
  /** middle | high | null(학년으로 판단이 안 될 때) */
  programKey: string | null;
};

const BAND_BASIC = "기초 다지기";
const BAND_SOLID = "실력 굳히기";
const BAND_LEAP = "한 단계 도약";

/**
 * 총점 → 수준. 앱의 getReportModel 과 같은 경계값(60 / 80)이다.
 * 점수가 없으면 가장 낮은 수준으로 둔다 — 없는 실력을 높게 약속하지 않는다.
 */
export function autoBandFor(totalScore: number | null | undefined): string {
  if (totalScore == null) return BAND_BASIC;
  if (totalScore < 60) return BAND_BASIC;
  if (totalScore < 80) return BAND_SOLID;
  return BAND_LEAP;
}

/**
 * 영역별 이해도 한 줄의 해석.
 *
 * 인쇄물은 평가 문항이 3개 미만이면 "추가 확인 필요" 를 쓴다. 서버에는 영역별
 * 문항 수가 없으므로 **점수가 아예 없을 때**를 그 자리에 쓴다(머리말 3번).
 */
export function interpretDomain(score: number | null): string {
  if (score == null) return "추가 확인 필요";
  if (score >= 80) return "유지·확장";
  if (score >= 60) return "적용 훈련";
  return "개념 보완";
}

/** 배정 과정. 원장이 직접 고른 값이 있으면 그것, 없으면 학년으로 판단한다. */
export function academyProgramKey(
  grade: string | null | undefined,
  classProgram: string | null | undefined
): string | null {
  if (classProgram === "middle" || classProgram === "high") return classProgram;
  const g = String(grade ?? "");
  if (/^고[1-3]$/.test(g)) return "high";
  if (/^중[1-3]$/.test(g)) return "middle";
  return null;
}

export function buildShareReportModel(input: {
  examCode: string | null | undefined;
  grade: string | null | undefined;
  testDate: string | null | undefined;
  totalScore: number | null | undefined;
  readingScore: number | null | undefined;
  grammarScore: number | null | undefined;
  vocabScore: number | null | undefined;
  writingScore: number | null | undefined;
  settings?: ShareReportSettings | null;
}): ShareReportModel {
  const s = input.settings ?? {};

  // 영역 순서는 인쇄물과 같다(문법 → 독해 → 서술형 → 어휘). DB 칼럼 순서와 다름.
  const byName: Record<string, number | null> = {
    문법: input.grammarScore ?? null,
    독해: input.readingScore ?? null,
    서술형: input.writingScore ?? null,
    어휘: input.vocabScore ?? null,
  };
  const domains: DomainRow[] = REPORT_DOMAINS.map((name) => ({
    name,
    score: byName[name] ?? null,
  }));

  const scored = domains
    .filter((d) => d.score != null)
    .slice()
    .sort((a, b) => (a.score as number) - (b.score as number));
  const priority = scored.length ? scored[0] : null;
  const strong = scored.filter((d) => (d.score as number) >= 80);

  const autoBand = autoBandFor(input.totalScore);

  // 원장이 "이 학생은 한 단계 아래 과정으로" 처럼 손으로 바꿔 둔 경우.
  // "시험코드|수준" 두 조각이 모두 실제로 존재할 때만 인정한다.
  const parts = String(s.trackOverride ?? "").split("|");
  const manual =
    parts.length === 2 &&
    !!CURRICULUM[parts[0]] &&
    !!CURRICULUM[parts[0]][parts[1]];
  const trackExam = manual ? parts[0] : String(input.examCode ?? "");
  const band = manual ? parts[1] : autoBand;

  // 모르는 시험 코드가 들어오면 null 로 둔다. 던지지 않는다(머리말 참고).
  const track: ReportTrack | null =
    (CURRICULUM[trackExam] && CURRICULUM[trackExam][band]) || null;

  // 시작월: 원장이 정한 값이 우선, 없으면 진단 다음 달.
  const custom = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s.startMonth ?? ""))
    ? dateParts(String(s.startMonth) + "-01")
    : null;
  const diagnosed = dateParts(input.testDate);
  const start: YM | null = custom
    ? { y: custom.y, m: custom.m }
    : diagnosed
      ? addMonths(diagnosed.y, diagnosed.m, 1)
      : null;

  const personalization = CURRICULUM_PERSONALIZATION[band];
  const phases = (track?.phases ?? []).map((phase, i) => {
    // 보완 문구는 1·2단계에만 붙인다(앱과 같다). 뒤 단계는 공통 문구로 둔다 —
    // 6개월 뒤의 약한 영역을 지금 점수로 단정하지 않겠다는 뜻이다.
    const weakFocus =
      priority && i < 2 && personalization && personalization[priority.name]
        ? personalization[priority.name][i] ?? null
        : null;
    return {
      index: i,
      name: phase.name,
      goal: phase.goal,
      check: phase.check,
      weakFocus,
      period: start
        ? `${monthLabel(addMonths(start.y, start.m, i * 3))} – ${monthLabel(
            addMonths(start.y, start.m, i * 3 + 2)
          )}`
        : null,
    };
  });

  const supportKey = String(s.learningSupport ?? "unset");
  const support = LEARNING_SUPPORT[supportKey] ?? LEARNING_SUPPORT.unset;

  return {
    autoBand,
    band,
    track,
    domains,
    priority,
    strong,
    start,
    phases,
    supportText: support.text,
    programKey: academyProgramKey(input.grade, s.classProgram),
  };
}

// ─── HTML ────────────────────────────────────────────────────────────────

/** 길이 제한. 긴 메모 한 줄이 휴대폰 화면을 망가뜨리지 않게 한다. */
function clip(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function programHtml(key: string | null): string {
  const p = key ? ACADEMY_PROGRAM[key] : null;
  if (!p) {
    // 초등부·검정고시 등 학년으로 과정이 정해지지 않는 경우.
    return `<section class="program">
   <h3>학생에게 맞는 수업 과정</h3>
   <p class="program-closing">진단 결과와 상담 내용을 바탕으로 배정 과정과 수업 일정을 안내합니다.</p>
  </section>`;
  }
  return `<section class="program">
   <h3>${esc(p.title)}</h3>
   <div class="program-schedule">${esc(p.schedule)}</div>
   <ul class="program-items">${p.items
     .map((it) => `<li><b>${esc(it.title)}</b><span>${esc(it.text)}</span></li>`)
     .join("")}</ul>
   <p class="program-closing">${esc(p.closing)}</p>
  </section>`;
}

/**
 * 학부모가 보는 결과지.
 *
 * ── 여기 나오는 것이 곧 "내보내는 개인정보 전부" 다 ──
 *   학생 이름 · 학년 · 진단일 · 시험 이름 · 총점 · 영역별 점수 ·
 *   담당 교사 이름 · 학원 이름 · 학원 전화번호.
 *   **학교·연락처·상담 메모·문항별 채점 상태는 내보내지 않는다**(머리말 1·2·3번).
 *   칸을 더할 때는 "링크를 잘못 보냈을 때 이것이 새도 괜찮은가" 를 먼저 묻는다.
 *
 * ── 채점이 안 끝난 기록은 ──
 *   이 함수는 받지 않는다(라우터가 막는다). 미채점이 남은 점수를 학부모가
 *   먼저 보면 그 숫자가 최종 점수로 기억된다. 되돌릴 수 없는 사고다.
 */
export function renderSharePage(input: {
  row: Pick<
    LevelTest,
    | "studentName"
    | "grade"
    | "testDate"
    | "examCode"
    | "examTitle"
    | "totalScore"
    | "readingScore"
    | "grammarScore"
    | "vocabScore"
    | "writingScore"
    | "questionCount"
    | "correctCount"
    | "teacherName"
  >;
  settings?: ShareReportSettings | null;
  academyName: string;
  academyPhone?: string | null;
  expiresAt?: Date | null;
}): string {
  const { row, academyName, academyPhone, expiresAt } = input;
  const m = buildShareReportModel({
    examCode: row.examCode,
    grade: row.grade,
    testDate: row.testDate,
    totalScore: row.totalScore,
    readingScore: row.readingScore,
    grammarScore: row.grammarScore,
    vocabScore: row.vocabScore,
    writingScore: row.writingScore,
    settings: input.settings,
  });

  const student = clip(row.studentName, 32) || "이름 미입력";
  const teacher = clip(row.teacherName, 18) || "담당 교사";
  const brand = clip(academyName, 38) || "학원";

  // ── 1페이지: 영역별 이해도 ──
  const metrics = m.domains
    .map((d, i) => {
      const scoreText = d.score == null ? "미평가" : `${d.score}<small>%</small>`;
      const width = d.score == null ? 0 : Math.max(0, Math.min(100, d.score));
      return `<div class="metric tone-${i}">
     <div class="metric-top"><b><i class="dot" aria-hidden="true"></i>${esc(
       d.name
     )}</b><span class="metric-score">${scoreText}</span></div>
     <div class="meter" role="img" aria-label="${esc(d.name)} ${
       d.score == null ? "미평가" : d.score + "%"
     } · ${esc(interpretDomain(d.score))}"><i style="width:${width}%"></i></div>
     <div class="metric-caption">${esc(interpretDomain(d.score))}</div>
   </div>`;
    })
    .join("");

  const priorityTitle = m.priority
    ? `${m.priority.name} · ${m.priority.score}%`
    : "추가 확인 필요";
  const priorityBody = m.priority
    ? (m.priority.score as number) >= 80
      ? "전반적으로 잘 이해하고 있습니다. 이 영역을 조금 더 다듬으면 실력을 더욱 탄탄하게 키울 수 있습니다."
      : "기본 개념을 확인하고 다양한 문제에 적용하며 이해를 다집니다."
    : "영역별 평가 문항을 더 확보한 뒤 방향을 정합니다.";
  const strengthTitle = m.strong.length
    ? m.strong.map((d) => d.name).join(" · ") + " — 유지·확장"
    : "추가 평가로 안정적인 이해를 확인합니다.";

  const correctLine =
    row.correctCount != null && row.questionCount != null
      ? `정답 ${esc(row.correctCount)} / 평가 ${esc(row.questionCount)}문항`
      : "";

  // ── 2페이지: 12개월 커리큘럼 ──
  // 커리큘럼을 찾지 못한 경우(모르는 시험 코드)에는 이 덩어리를 통째로 빼고,
  // 빈 자리에 "상담에서 안내" 라고 적는다. 거짓 약속을 만들지 않는다.
  const curriculumHtml = m.track
    ? `<div class="pagebreak"><span>다음 12개월</span></div>

 <section class="card head">
  <div class="kicker">12-MONTH CURRICULUM</div>
  <h1>${esc(student)} 학생의 다음 12개월</h1>
  <p class="lead">${esc(m.track.yearGoal)}</p>
 </section>

 <section class="card roadmap">
  <b>이해 → 적용 → 확장 → 자기 점검</b>
  <span>${m.start ? esc(monthLabel(m.start)) + " 시작" : "시작월 상담에서 확정"} · 4단계 × 3개월</span>
  <div class="track-chip">${esc(m.track.title)} · ${esc(m.band)}</div>
 </section>

 <section class="card note">
  <b>매달 독해·어휘·문법·서술형을 함께 배우는 통합 커리큘럼</b>
  <p>Syntax 구문독해와 문법·서술형을 연결해 독해력과 표현력을 함께 키웁니다. 단계별 중점은 학생의 이해도와 학습 속도에 맞춰 조정합니다.</p>
 </section>

 ${programHtml(m.programKey)}

 <div class="phases">${m.phases
   .map(
     (p) => `<article class="phase">
    <div class="phase-top"><span class="phase-no">0${p.index + 1}</span><div><h3>${esc(
      p.name
     )}</h3>${p.period ? `<div class="phase-period">${esc(p.period)}</div>` : ""}</div></div>
    <p class="phase-goal">${esc(p.goal)}</p>
    ${
      p.weakFocus
        ? `<p class="phase-emphasis"><b>보완 중점</b> ${esc(p.weakFocus)}</p>`
        : ""
    }
    <div class="phase-check"><b>단계 점검</b> ${esc(p.check)}</div>
   </article>`
   )
   .join("")}</div>

 <section class="card manage">
  <b>학생에게 맞춘 지도</b>
  <p>${esc(m.supportText)} 학습 과정과 정기적인 재진단을 바탕으로 난도와 학습량을 조절합니다.</p>
 </section>`
    : `<section class="card note">
  <b>12개월 커리큘럼은 상담에서 안내해 드립니다</b>
  <p>이 시험 종류에 연결된 커리큘럼 안내를 찾지 못했습니다. 학원으로 연락 주시면 바로 설명해 드리겠습니다.</p>
 </section>`;

  const phoneHtml = academyPhone
    ? `<a class="call" href="tel:${esc(
        String(academyPhone).replace(/[^0-9+]/g, "")
      )}">학원에 전화하기 ${esc(academyPhone)}</a>`
    : "";

  const expiryHtml = expiresAt
    ? `<div class="expiry">이 링크는 ${esc(
        formatKoreanDate(expiresAt)
      )} 까지 볼 수 있습니다</div>`
    : "";

  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(student)} 학생 레벨테스트 결과지</title>
<style>
 /* 휴대폰 세로 화면 기준으로 새로 쓴 CSS. 인쇄용(mm) CSS 를 옮긴 것이 아니다.
    색은 페이지원 브랜드(#F96E00 / #37373A)를 따른다. */
 *{box-sizing:border-box}
 body{margin:0;background:#f4f5f7;padding:18px 14px 36px;
      font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","맑은 고딕",sans-serif;
      color:#37373A;-webkit-text-size-adjust:100%}
 .wrap{max-width:520px;margin:0 auto}
 .brand{text-align:center;font-size:13px;color:#F96E00;font-weight:800;
        letter-spacing:.06em;margin-bottom:12px}
 .card{background:#fff;border-radius:16px;padding:20px 18px;margin-bottom:10px;
       box-shadow:0 1px 3px rgba(0,0,0,.06)}
 .kicker{font-size:10px;letter-spacing:.14em;color:#F96E00;font-weight:800;margin-bottom:6px}
 h1{font-size:20px;margin:0;line-height:1.35}
 .lead{font-size:13px;color:#7a7a80;margin:8px 0 0;line-height:1.7}
 h2{font-size:12px;margin:0 0 12px;color:#9a9aa0;font-weight:700;letter-spacing:.02em}
 h3{font-size:15px;margin:0;line-height:1.4}

 /* 학생 정보 */
 .facts{display:grid;gap:9px}
 .facts div{display:flex;justify-content:space-between;gap:12px;font-size:13px}
 .facts span{color:#9a9aa0;flex:none}
 .facts strong{font-weight:600;text-align:right}

 /* 총점 */
 .total{text-align:center;padding:24px 18px}
 .total .examname{font-size:12px;color:#9a9aa0;margin-bottom:8px}
 .score{font-size:50px;font-weight:800;line-height:1;color:#F96E00;font-variant-numeric:tabular-nums}
 .score small{font-size:16px;font-weight:600;margin-left:3px;color:#b8b8be}
 .total p{font-size:13px;color:#7a7a80;margin:10px 0 0}
 .total .caption{font-size:11px;color:#b0b0b6;margin-top:6px;line-height:1.6}

 /* 영역별 이해도 */
 .scale{display:flex;justify-content:space-between;font-size:10px;color:#c2c2c8;margin-bottom:8px}
 .metric{margin-bottom:14px}
 .metric:last-child{margin-bottom:0}
 .metric-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
 .metric-top b{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
 .dot{width:7px;height:7px;border-radius:50%;display:inline-block;background:#F96E00}
 .tone-1 .dot{background:#F58A33}
 .tone-2 .dot{background:#E2A33C}
 .tone-3 .dot{background:#C2894B}
 .metric-score{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums}
 .metric-score small{font-size:10px;font-weight:600;color:#b8b8be}
 .meter{height:8px;background:#eef0f3;border-radius:4px;overflow:hidden}
 .meter i{display:block;height:100%;border-radius:4px;background:#F96E00}
 .tone-1 .meter i{background:#F58A33}
 .tone-2 .meter i{background:#E2A33C}
 .tone-3 .meter i{background:#C2894B}
 .metric-caption{font-size:11px;color:#9a9aa0;margin-top:5px}

 /* 우선 보완 · 강점 */
 .insights{display:grid;gap:14px}
 .insights>div>span{font-size:11px;color:#9a9aa0;font-weight:700}
 .insights h3{margin:4px 0 6px;color:#37373A}
 .insights p{font-size:12px;color:#7a7a80;margin:0;line-height:1.7}
 .cautions{font-size:11px;color:#a0a0a6;line-height:1.75;margin:0}

 /* 페이지 구분 */
 .pagebreak{display:flex;align-items:center;gap:10px;margin:26px 2px 12px;
            font-size:11px;color:#b0b0b6;font-weight:700;letter-spacing:.08em}
 .pagebreak:before,.pagebreak:after{content:"";flex:1;height:1px;background:#e2e4e8}

 /* 커리큘럼 */
 .roadmap b{display:block;font-size:14px}
 .roadmap span{display:block;font-size:12px;color:#9a9aa0;margin-top:5px}
 .track-chip{display:inline-block;margin-top:10px;background:#fff3e8;color:#C2560A;
             font-size:11px;font-weight:700;padding:5px 10px;border-radius:999px}
 .note b{display:block;font-size:13px;line-height:1.5}
 .note p{font-size:12px;color:#7a7a80;margin:7px 0 0;line-height:1.75}

 /* 수업 과정 */
 .program{background:#37373A;color:#fff;border-radius:16px;padding:20px 18px;margin-bottom:10px}
 .program h3{font-size:15px;color:#fff}
 .program-schedule{display:inline-block;margin-top:8px;font-size:11px;font-weight:700;
                   color:#FFC38F;border:1px solid #5c5c61;padding:4px 9px;border-radius:999px}
 .program-items{list-style:none;margin:14px 0 0;padding:0;display:grid;gap:12px}
 .program-items li b{display:block;font-size:12px;color:#FFB36B;margin-bottom:4px}
 .program-items li span{font-size:12px;color:#d6d6da;line-height:1.75}
 .program-closing{font-size:12px;color:#b6b6bb;margin:14px 0 0;line-height:1.7}

 /* 4단계 */
 .phases{display:grid;gap:10px;margin-bottom:10px}
 .phase{background:#fff;border-radius:16px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
 .phase-top{display:flex;gap:12px;align-items:flex-start}
 .phase-no{font-size:18px;font-weight:800;color:#F96E00;line-height:1.2;flex:none}
 .phase-period{font-size:11px;color:#9a9aa0;margin-top:3px}
 .phase-goal{font-size:13px;line-height:1.75;margin:12px 0 0;color:#4a4a50}
 .phase-emphasis{font-size:12px;line-height:1.75;margin:10px 0 0;color:#C2560A;
                 background:#fff6ee;border-radius:10px;padding:10px 12px}
 .phase-emphasis b{display:block;font-size:11px;margin-bottom:3px}
 .phase-check{font-size:12px;line-height:1.7;margin-top:10px;color:#8a8a90;
              border-top:1px solid #eef0f3;padding-top:10px}
 .phase-check b{display:block;font-size:11px;color:#9a9aa0;margin-bottom:3px}
 .manage b{display:block;font-size:13px}
 .manage p{font-size:12px;color:#7a7a80;margin:7px 0 0;line-height:1.75}

 /* 꼬리 */
 .call{display:block;text-align:center;background:#F96E00;color:#fff;text-decoration:none;
       padding:16px;border-radius:14px;font-weight:800;font-size:15px;margin-top:14px}
 .sign{text-align:center;font-size:11px;color:#a0a0a6;margin-top:14px;line-height:1.8}
 .expiry{text-align:center;font-size:11px;color:#b0b0b6;margin-top:6px;line-height:1.7}
</style></head>
<body><div class="wrap">

 <div class="brand">${esc(brand)}</div>

 <section class="card head">
  <div class="kicker">PLACEMENT TEST</div>
  <h1>입학 레벨테스트 결과지</h1>
  <p class="lead">지금의 이해를 확인하고, 다음 배움의 방향을 찾습니다.</p>
 </section>

 <section class="card">
  <div class="facts">
   <div><span>학생</span><strong>${esc(student)}</strong></div>
   <div><span>학년</span><strong>${esc(clip(row.grade, 8) || "미입력")}</strong></div>
   <div><span>진단일</span><strong>${esc(formatKoreanDate(row.testDate))}</strong></div>
   <div><span>시험</span><strong>${esc(clip(row.examTitle, 40))}</strong></div>
  </div>
 </section>

 <section class="card total">
  <div class="examname">01 / 종합 진단</div>
  <div class="score">${row.totalScore == null ? "—" : esc(row.totalScore)}<small>/ 100</small></div>
  ${correctLine ? `<p>${correctLine}</p>` : ""}
  <div class="caption">평가한 문항의 정답률 · 문항별 동일 배점</div>
 </section>

 <section class="card">
  <h2>영역별 이해도</h2>
  <div class="scale" aria-hidden="true"><span>0</span><span>50</span><span>100%</span></div>
  ${metrics}
 </section>

 <section class="card insights">
  <div>
   <span>우선 보완 영역</span>
   <h3>${esc(priorityTitle)}</h3>
   <p>${esc(priorityBody)}</p>
  </div>
  <div>
   <span>강점 영역</span>
   <h3>${esc(strengthTitle)}</h3>
   <p>익숙한 내용을 새로운 문장과 지문에 적용하며 학습의 폭을 넓힙니다.</p>
  </div>
 </section>

 <section class="card">
  <p class="cautions">미채점·미응시는 점수 계산에서 제외합니다. 어휘는 적은 문항으로 확인하는 간이 진단입니다. 듣기·말하기는 평가하지 않았습니다.</p>
 </section>

 ${curriculumHtml}

 ${phoneHtml}
 <div class="sign">${esc(brand)} · ${esc(teacher)}</div>
 ${expiryHtml}

</div></body></html>`;
}
