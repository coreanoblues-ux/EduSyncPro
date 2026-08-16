/**
 * 학년 자동 진급.
 *
 * 한국 학교는 3월에 새 학년이 시작된다. 그래서 "지금 몇 학년인가"는 달력 연도가
 * 아니라 3월을 경계로 하는 **학년도**로 센다. 2027-02-28은 아직 2026학년도이고
 * 2027-03-01부터 2027학년도다.
 *
 * 이 파일에는 DB도 시계도 들어오지 않는다. 전부 순수 함수라 scripts/test-grade-
 * promotion.ts에서 날짜를 고정해 놓고 검증할 수 있다. 실제로 학생 데이터를 고치는
 * 쪽은 server/lib/gradePromotion.ts다.
 */

export type SchoolLevel = "초" | "중" | "고";

/** 각 학교급의 마지막 학년. 초6 다음은 중1, 중3 다음은 고1이다. */
const MAX_YEAR: Record<SchoolLevel, number> = { 초: 6, 중: 3, 고: 3 };

export interface ParsedGrade {
  /**
   * 학년 표기 앞에 붙어 있던 학교 이름 조각. "삼육중2" → "삼육".
   * 같은 학교급 안에서 진급할 때는 이걸 그대로 붙여 되돌린다.
   */
  prefix: string;
  level: SchoolLevel;
  year: number;
}

/** "중2", "삼육중 중3", "문성고1" 처럼 급과 학년이 붙어 있는 형태를 찾는다. */
const LEVEL_WITH_YEAR = /([초중고])\s*([1-6])/g;

/**
 * 학교 이름에서 학교급을 읽는다. "6학년"처럼 숫자만 적혀 있을 때의 보조 수단이다.
 *
 * 마지막에 나온 글자를 택한다. "고려중학교"는 고와 중이 다 들어 있지만 중학교이고,
 * "중앙고등학교"는 반대다. 한국 학교 이름은 급을 뒤에 붙이므로 이 규칙이 맞다.
 */
function levelFromSchool(school?: string | null): SchoolLevel | null {
  const s = (school ?? "").trim();
  if (!s) return null;
  let found: SchoolLevel | null = null;
  for (const ch of s) {
    if (ch === "초" || ch === "중" || ch === "고") found = ch;
  }
  return found;
}

/**
 * 자유 입력으로 쌓인 학년 문자열을 해석한다. 못 읽으면 null이다.
 *
 * **못 읽는 건 실패가 아니라 정상 동작이다.** "중학생"(학년 없음), "설월 1학년"
 * (학교급을 알 수 없음), 빈 값은 추측하지 않고 그대로 둔다. 학년을 잘못 올리면
 * 반 배정과 수업 안내가 어긋나므로, 애매하면 건드리지 않는 쪽이 옳다.
 */
export function parseGrade(
  grade?: string | null,
  school?: string | null
): ParsedGrade | null {
  const g = (grade ?? "").trim();
  if (!g) return null;

  // 1) 학년 문자열 자체에 급-숫자가 있으면 그게 가장 확실하다.
  //    "삼육중 중3"처럼 급 글자가 두 번 나오면 뒤엣것이 실제 학년이다.
  const re = new RegExp(LEVEL_WITH_YEAR.source, "g");
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(g); m !== null; m = re.exec(g)) last = m;
  if (last && last.index !== undefined) {
    const level = last[1] as SchoolLevel;
    const year = Number(last[2]);
    if (year > MAX_YEAR[level]) return null; // "중5" 같은 값은 해석을 포기한다
    // 앞쪽 공백만 떼고 뒤쪽은 남긴다. "삼육중 중1"의 띄어쓰기를 살려
    // "삼육중 중2"로 되돌리기 위해서다. trim()을 쓰면 "삼육중중2"가 된다.
    const raw = g.slice(0, last.index);
    return { prefix: raw.trim() === "" ? "" : raw.trimStart(), level, year };
  }

  // 2) "6학년"처럼 숫자만 있으면 학교 이름에서 급을 빌려온다.
  const digit = g.match(/[1-6]/);
  if (!digit) return null;
  const level = levelFromSchool(school);
  if (!level) return null;
  const year = Number(digit[0]);
  if (year > MAX_YEAR[level]) return null;
  return { prefix: "", level, year };
}

export function formatGrade(p: ParsedGrade): string {
  return `${p.prefix}${p.level}${p.year}`;
}

/** 한 해 진급시킨다. 고3 다음은 졸업이므로 null이다. */
export function nextGrade(p: ParsedGrade): ParsedGrade | null {
  if (p.year < MAX_YEAR[p.level]) {
    // 같은 학교에 계속 다니므로 앞에 붙은 학교 이름을 살린다.
    return { ...p, year: p.year + 1 };
  }
  // 학교급이 바뀌면 다니는 학교도 바뀐다. 앞에 붙어 있던 학교 이름은 이제 틀린
  // 정보라 버리고 "중1"/"고1"만 남긴다. 새 학교 이름은 원장이 직접 채워야 한다.
  if (p.level === "초") return { prefix: "", level: "중", year: 1 };
  if (p.level === "중") return { prefix: "", level: "고", year: 1 };
  return null; // 고4는 만들지 않는다
}

/**
 * 학년 문자열을 steps해 만큼 올린 결과. 바뀔 게 없거나 해석 불가면 null.
 *
 * steps가 2 이상인 건 서버가 3월을 넘긴 채로 한 해 이상 꺼져 있던 경우다.
 */
export function promoteGrade(
  grade: string | null | undefined,
  school: string | null | undefined,
  steps = 1
): string | null {
  let p = parseGrade(grade, school);
  if (!p) return null;
  for (let i = 0; i < steps; i++) {
    const nxt = nextGrade(p);
    if (!nxt) break; // 고3에 도달하면 더 올리지 않고 멈춘다
    p = nxt;
  }
  const out = formatGrade(p);
  return out === (grade ?? "").trim() ? null : out;
}

/** 학교급이 바뀌는 진급인가. 이런 학생은 학교 정보도 새로 받아야 한다. */
export function changesSchoolLevel(p: ParsedGrade): boolean {
  return p.year >= MAX_YEAR[p.level] && p.level !== "고";
}

/**
 * 자유 입력 학년을 "중1" 꼴로 통일한다. 못 읽으면 null이라 원문을 그대로 둔다.
 *
 * AI는 "숭의중1"을 school="숭의중", grade="1학년"으로 쪼개 준다. 그런데 "1학년"만
 * 저장해 두면 나중에 학교 정보가 바뀌었을 때 초1인지 중1인지 알 수 없어 자동 진급이
 * 이 학생을 건너뛴다. 들어올 때 "중1"로 굳혀 두면 그 문제가 생기지 않는다.
 */
export function canonicalGrade(
  grade?: string | null,
  school?: string | null
): string | null {
  const p = parseGrade(grade, school);
  if (!p) return null;
  return formatGrade(p);
}

/**
 * 줄여 쓴 학교 이름을 정식 명칭으로 편다. "숭의중" → "숭의중학교".
 *
 * 같은 학교가 "숭의중"과 "숭의중학교"로 따로 쌓이면 학교별로 묶어 보기가 안 된다.
 * 이미 "학교"로 끝나거나 초·중·고로 끝나지 않으면 손대지 않는다.
 */
export function expandSchoolName(school?: string | null): string | null {
  const s = (school ?? "").trim();
  if (!s) return null;
  if (s.endsWith("학교")) return s;
  if (s.endsWith("초")) return s + "등학교";
  if (s.endsWith("중")) return s + "학교";
  if (s.endsWith("고")) return s + "등학교";
  return s;
}

/**
 * "YYYY-MM-DD"가 속한 학년도. 3월 1일부터 새 학년도다.
 * 2027-02-28 → 2026, 2027-03-01 → 2027.
 */
export function schoolYearOf(ymd: string): number {
  const [y, m] = ymd.split("-").map(Number);
  return m >= 3 ? y : y - 1;
}
