/**
 * 레벨테스트 결과를 보고 "어느 반이 맞을지" 를 줄 세운다.
 *
 * ── 이 파일이 하지 않는 일 ──
 *   **반을 정하지 않는다.** 순서를 매겨 근거와 함께 보여 주기만 한다. 결정은
 *   원장이 한다. 반 배정은 학생의 1년을 좌우하고, 숫자로 드러나지 않는 사정
 *   (형제가 같은 반, 셔틀 시간, 성격, 전 학원 이력)이 늘 끼어든다. 그걸 모르는
 *   코드가 "이 반입니다" 라고 단정하면, 틀렸을 때 원장이 시스템을 못 믿게 된다.
 *
 *   그래서 모든 후보에 **왜 그렇게 봤는지(reasons)** 와 **걸리는 점(cautions)** 을
 *   한국어 문장으로 같이 달아 준다. 원장이 근거를 읽고 뒤집을 수 있어야 한다.
 *
 * ── 무엇을 근거로 삼는가 ──
 *   짐작을 최소로 줄이려고, 순서의 대부분을 **원장이 이미 입력해 둔 사실**로
 *   정한다. 점수로 난이도를 가르는 부분은 가중치를 작게 두고, 쓸 때마다
 *   기준 숫자를 문장에 적어 둔다 (아래 LEVEL_CUT 주석 참조).
 *
 *     1. 반 이름에 적힌 학년      ("[란]중1 기본 - 월수금" → 중1)  ← 가장 센 근거
 *     2. 그 반에 실제로 다니는 학생들의 학년                        ← 이름이 없을 때
 *     3. 정원과 현재 인원 (자리가 없으면 추천이 아니라 대기다)
 *     4. 점수로 보는 난이도 (반 이름에 기본/심화가 있을 때만)       ← 가장 약한 근거
 *
 * ── 왜 정원을 여기서 보는가 ──
 *   maxStudents 칸은 지금까지 화면에 "(최대 20명)" 으로 적히기만 했고, 실제
 *   인원과 비교된 적이 한 번도 없었다. 그래서 정원이 넘은 반에 등록이 그냥
 *   됐다. 추천과 정원을 같은 자리에서 계산해 두면 "추천했는데 자리가 없다" 가
 *   구조적으로 생기지 않는다.
 */

import { parseGrade, type ParsedGrade } from "./gradePromotion";

// ─── 받는 값 ────────────────────────────────────────────────────────────

export interface RecommendClass {
  id: string;
  name: string;
  subject?: string | null;
  schedule?: string | null;
  maxStudents: number | null;
  isActive: boolean;
}

/** 그 반에 실제로 다니는 학생 한 명. 반 분위기(학년 구성)를 읽는 데 쓴다. */
export interface RecommendMember {
  classId: string;
  grade: string | null;
  school?: string | null;
  isActive: boolean;
}

/** 배정을 고민하는 학생. 점수는 없으면 없는 대로 둔다 (학년만으로도 줄은 세운다). */
export interface RecommendStudent {
  grade: string | null;
  school?: string | null;
  totalScore?: number | null;
  readingScore?: number | null;
  grammarScore?: number | null;
  vocabScore?: number | null;
  writingScore?: number | null;
}

export type Fit = "추천" | "가능" | "정원초과" | "학년이 다름";

export interface ClassCandidate {
  classId: string;
  name: string;
  schedule: string | null;
  /** 정원 상황. max 가 null 이면 정원을 정하지 않은 반이라 판단하지 않는다. */
  seats: { max: number | null; taken: number; left: number | null };
  fit: Fit;
  /** 줄 세우기용 점수. 화면에 보여 줄 숫자가 아니다 (근거 문장을 보여 준다). */
  rank: number;
  reasons: string[];
  cautions: string[];
}

// ─── 기준 숫자 ──────────────────────────────────────────────────────────
//
// 아래 두 숫자만이 이 파일에서 "코드가 정한" 값이다. 나머지는 원장이 입력해
// 둔 사실에서 나온다. 숫자를 바꾸고 싶으면 여기만 고치면 되고, 바꿀 때
// scripts/test-class-recommend.ts 가 무엇이 달라지는지 바로 보여 준다.
const LEVEL_CUT = {
  /** 이 점수 이상이면 심화반 쪽에 힘을 준다 */
  advanced: 80,
  /** 이 점수 미만이면 기본반 쪽에 힘을 준다 */
  basic: 65,
};

// 가중치. 학년이 난이도보다 훨씬 세다 — 중2를 고1 반에 넣는 실수가
// 기본/심화를 바꿔 넣는 것보다 압도적으로 나쁘다.
const W = {
  gradeExact: 50, // 반 이름의 학년이 딱 맞는다
  gradeByMembers: 30, // 다니는 학생들의 다수 학년이 맞는다
  sameLevel: 12, // 학교급은 같지만 학년이 다르다 (중2 → 중1 반)
  levelMismatch: -60, // 학교급이 다르다 (중2 → 고1 반)
  hasSeat: 8, // 자리가 있다
  difficulty: 10, // 점수로 본 난이도가 반 이름과 맞는다
  difficultyOff: -8, // 반대로 어긋난다
};

// ─── 보조 ───────────────────────────────────────────────────────────────

/** 반 이름에서 학년을 읽는다. "[란]중1 기본 - 월수금" → 중1. 못 읽으면 null. */
export function gradeFromClassName(name: string): ParsedGrade | null {
  // 학생 학년 해석과 **같은 함수**를 쓴다. 규칙이 둘로 갈리면
  // "중1 반인데 중1 학생이 안 맞는다" 같은 설명 불가능한 상태가 생긴다.
  return parseGrade(name, null);
}

/** 그 반에 다니는 학생들의 다수 학년. 같은 수로 갈리면 판단을 포기한다. */
function majorityGrade(members: RecommendMember[]): ParsedGrade | null {
  // Map 대신 배열로 센다. tsconfig 의 target 이 낮아 Map 을 펼칠 수 없고,
  // 한 반의 학년 종류는 많아도 몇 개라 배열 탐색으로 충분하다.
  // (tsconfig 를 건드리면 결제 등 전체 코드의 컴파일 조건이 바뀐다.)
  const counts: { key: string; n: number; parsed: ParsedGrade }[] = [];
  for (const m of members) {
    const p = parseGrade(m.grade, m.school);
    if (!p) continue;
    const key = `${p.level}${p.year}`;
    const cur = counts.find((x) => x.key === key);
    if (cur) cur.n++;
    else counts.push({ key, n: 1, parsed: p });
  }
  if (!counts.length) return null;
  const sorted = counts.slice().sort((a, b) => b.n - a.n);
  // 1등이 2등과 같은 수면 "이 반은 몇 학년 반" 이라고 말할 수 없다.
  if (sorted.length > 1 && sorted[0].n === sorted[1].n) return null;
  return sorted[0].parsed;
}

/** 반 이름에 난이도 표시가 있는가. 없으면 null — 그러면 점수를 쓰지 않는다. */
function difficultyOf(name: string): "기본" | "심화" | null {
  if (/심화|상위|고급|advanced/i.test(name)) return "심화";
  if (/기본|기초|입문|basic/i.test(name)) return "기본";
  return null;
}

/** 가장 약한 영역. 점수가 둘 이상 있을 때만 말한다. */
export function weakestDomain(s: RecommendStudent): { name: string; score: number } | null {
  const pairs: [string, number | null | undefined][] = [
    ["독해", s.readingScore],
    ["문법", s.grammarScore],
    ["어휘", s.vocabScore],
    ["서술형", s.writingScore],
  ];
  const known = pairs.filter((p): p is [string, number] => typeof p[1] === "number");
  if (known.length < 2) return null;
  known.sort((a, b) => a[1] - b[1]);
  return { name: known[0][0], score: known[0][1] };
}

// ─── 본체 ───────────────────────────────────────────────────────────────

/**
 * 후보 반을 줄 세운다. 넣은 반 전부를 돌려준다 (닫힌 반만 뺀다).
 *
 * 왜 전부 돌려주는가: 화면에서 위 3개만 보여 줄지, 정원초과까지 보여 줄지는
 * 화면이 정할 일이다. 여기서 미리 잘라 버리면 "그 반은 왜 안 나오나" 를
 * 원장이 확인할 길이 없어진다.
 */
export function recommendClasses(input: {
  student: RecommendStudent;
  classes: readonly RecommendClass[];
  members: readonly RecommendMember[];
}): ClassCandidate[] {
  const { student } = input;
  const mine = parseGrade(student.grade, student.school);
  const weak = weakestDomain(student);

  const out: ClassCandidate[] = [];

  for (const cls of input.classes) {
    if (!cls.isActive) continue;

    const active = input.members.filter((m) => m.classId === cls.id && m.isActive);
    const taken = active.length;
    const left = cls.maxStudents == null ? null : cls.maxStudents - taken;

    const reasons: string[] = [];
    const cautions: string[] = [];
    let rank = 0;
    let levelMismatch = false;

    // ── 1) 학년 ──
    const byName = gradeFromClassName(cls.name);
    const byMembers = majorityGrade(active);
    const classGrade = byName ?? byMembers;

    if (!mine) {
      cautions.push("학생 학년이 비어 있어 학년으로는 판단하지 못했습니다");
    } else if (!classGrade) {
      cautions.push("이 반의 학년을 알 수 없습니다 (반 이름에도, 재원생 학년에도 단서가 없음)");
    } else if (classGrade.level !== mine.level) {
      rank += W.levelMismatch;
      levelMismatch = true;
      cautions.push(
        `학교급이 다릅니다 (학생 ${mine.level}${mine.year} · 반 ${classGrade.level}${classGrade.year})`
      );
    } else if (classGrade.year === mine.year) {
      rank += byName ? W.gradeExact : W.gradeByMembers;
      reasons.push(
        byName
          ? `반 이름의 학년이 맞습니다 (${classGrade.level}${classGrade.year})`
          : `이 반 학생 대부분이 ${classGrade.level}${classGrade.year} 입니다`
      );
    } else {
      rank += W.sameLevel;
      reasons.push(
        `같은 ${mine.level}학교 과정입니다 (반은 ${classGrade.level}${classGrade.year})`
      );
    }

    // ── 2) 정원 ──
    if (left == null) {
      cautions.push("정원을 정하지 않은 반입니다");
    } else if (left > 0) {
      rank += W.hasSeat;
      reasons.push(`자리 ${left}개 남음 (${taken}/${cls.maxStudents}명)`);
    } else if (left === 0) {
      cautions.push(`정원이 찼습니다 (${taken}/${cls.maxStudents}명)`);
    } else {
      // 정원을 이미 넘긴 반. 지금까지 아무도 비교하지 않아 생긴 상태다.
      cautions.push(`정원을 ${-left}명 넘었습니다 (${taken}/${cls.maxStudents}명)`);
    }

    // ── 3) 난이도 (반 이름에 표시가 있고 총점이 있을 때만) ──
    const diff = difficultyOf(cls.name);
    const total = student.totalScore;
    if (diff && typeof total === "number") {
      if (diff === "심화" && total >= LEVEL_CUT.advanced) {
        rank += W.difficulty;
        reasons.push(`총점 ${total}점 — 심화반 기준(${LEVEL_CUT.advanced}점 이상)에 듭니다`);
      } else if (diff === "기본" && total < LEVEL_CUT.basic) {
        rank += W.difficulty;
        reasons.push(`총점 ${total}점 — 기본반 기준(${LEVEL_CUT.basic}점 미만)에 듭니다`);
      } else if (diff === "심화" && total < LEVEL_CUT.basic) {
        rank += W.difficultyOff;
        cautions.push(`심화반인데 총점이 ${total}점입니다 (기준 ${LEVEL_CUT.advanced}점)`);
      } else if (diff === "기본" && total >= LEVEL_CUT.advanced) {
        rank += W.difficultyOff;
        cautions.push(`기본반인데 총점이 ${total}점입니다 — 심화반도 같이 보세요`);
      }
    }

    // ── 4) 약한 영역은 근거가 아니라 참고 사항이다 ──
    if (weak && !levelMismatch) {
      cautions.push(`${weak.name}이(가) 가장 약합니다 (${weak.score}점)`);
    }

    // ── 판정 ──
    let fit: Fit;
    if (levelMismatch) fit = "학년이 다름";
    else if (left != null && left <= 0) fit = "정원초과";
    else if (rank >= W.gradeByMembers) fit = "추천";
    else fit = "가능";

    out.push({
      classId: cls.id,
      name: cls.name,
      schedule: cls.schedule ?? null,
      seats: { max: cls.maxStudents, taken, left },
      fit,
      rank,
      reasons,
      cautions,
    });
  }

  // 점수 높은 순 → 자리 많은 순 → 이름 순. 마지막 이름 순은 순서를 고정해
  // 화면을 열 때마다 목록이 흔들리지 않게 하려는 것이다.
  out.sort(
    (a, b) =>
      b.rank - a.rank ||
      (b.seats.left ?? -1) - (a.seats.left ?? -1) ||
      a.name.localeCompare(b.name)
  );
  return out;
}

/** 화면이 바로 쓰기 좋은 모양: 추천 가능한 것 위 n개. */
export function topCandidates(all: readonly ClassCandidate[], n = 3): ClassCandidate[] {
  // 학년이 다른 반은 추천 목록에 끼우지 않는다. 자리가 없는 반은 남긴다 —
  // "자리만 나면 이 반" 이라는 정보가 대기 등록을 결정하는 근거가 된다.
  return all.filter((c) => c.fit !== "학년이 다름").slice(0, n);
}
