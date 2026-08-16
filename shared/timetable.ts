/**
 * 자유 입력으로 쌓인 수업 일정을 시간표 격자에 올릴 수 있는 형태로 읽는다.
 *
 * schedule 칸은 형식이 정해져 있지 않아 실제로 이런 값들이 들어 있다:
 *
 *   "월 수 [5:30~7:30], 금 [7:00~8:30]"   요일-시간 묶음이 여러 개
 *   "화 목 8:00~10:00, 토 11:30~13:00"
 *   "월 수 금 7시 ~ 8시 30분"              한국식 시각
 *   "토일 3시30분"                         끝 시각이 없음
 *   "오전 9:00~오전 11:00"                 요일이 없음
 *   "월~금"                                시각이 없음
 *
 * **못 읽는 건 실패가 아니다.** 시간을 못 읽으면 격자에 올리지 않고 따로 모아
 * 보여준다. 아무 데나 그려 넣으면 원장이 시간표를 믿을 수 없게 된다.
 */

export const DAYS = ["월", "화", "수", "목", "금", "토", "일"] as const;
export type Day = (typeof DAYS)[number];

export interface Slot {
  day: Day;
  /** 자정 기준 분. 18:30 → 1110 */
  startMin: number;
  endMin: number;
  /** 오전/오후가 안 적혀 있어 코드가 정한 시각인가. 화면에서 표시해 준다. */
  guessedMeridiem: boolean;
}

const DAY_SET = new Set<string>(DAYS);

/**
 * 요일을 읽는다. "월 수 금", "월수", "월~금", "토-일", "주말" 을 모두 받는다.
 *
 * "요일"을 먼저 떼는 게 중요하다. 안 그러면 "화요일"의 "일"이 일요일로 잡혀
 * 화·목 반이 화·목·일 반이 된다. (nlpNormalize의 normalizeDays와 같은 이유)
 */
export function parseDays(text: string): Day[] {
  const t = text.replace(/요일/g, "");

  const found = new Set<Day>();

  // "월~금", "토-일" 같은 범위를 먼저 편다. 편 뒤에는 낱글자로도 잡히므로
  // 범위 표기 자체를 지워서 두 번 세지 않게 한다.
  let rest = t.replace(/([월화수목금토일])\s*[~\-–]\s*([월화수목금토일])/g, (_m, a, b) => {
    const i = DAYS.indexOf(a);
    const j = DAYS.indexOf(b);
    if (i === -1 || j === -1) return " ";
    // 월~금은 i<j, 토~월처럼 주를 넘는 표기는 없다고 본다.
    for (let k = i; k <= j; k++) found.add(DAYS[k]);
    return " ";
  });

  if (/주말/.test(rest)) {
    found.add("토");
    found.add("일");
    rest = rest.replace(/주말/g, " ");
  }
  if (/평일/.test(rest)) {
    for (const d of ["월", "화", "수", "목", "금"] as Day[]) found.add(d);
    rest = rest.replace(/평일/g, " ");
  }

  for (const ch of rest) {
    if (DAY_SET.has(ch)) found.add(ch as Day);
  }

  return DAYS.filter((d) => found.has(d));
}

interface RawTime {
  hour: number;
  minute: number;
  /** 원문에 오전/오후가 적혀 있었는가 */
  meridiem: "am" | "pm" | null;
  /** 24시간 표기(13시 이상)라 해석이 필요 없는가 */
  explicit: boolean;
}

/** "5:30", "8시 30분", "3시30분", "19:00" 하나를 읽는다. */
function readTime(s: string): RawTime | null {
  const meridiem: "am" | "pm" | null = /오전/.test(s)
    ? "am"
    : /오후|저녁|밤/.test(s)
      ? "pm"
      : null;

  let m = s.match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (!m) {
    // "8시 30분", "3시30분", "7시"
    m = s.match(/(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분)?/);
    if (!m) return null;
  }
  const hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (!Number.isFinite(hour) || hour > 24 || minute > 59) return null;
  return { hour, minute, meridiem, explicit: hour >= 13 };
}

/**
 * 오전·오후가 안 적힌 시각을 학원 시간표에 맞게 푼다.
 *
 * 학원 수업은 낮과 저녁에 있다. "5:30~7:30"을 곧이곧대로 새벽 5시 반으로 그리면
 * 시간표가 통째로 쓸모없어진다. 그래서 1~8시는 오후로 본다. 9~12시는 주말 오전
 * 수업이 실제로 있어서(`주말 11:00~13:00`) 그대로 오전으로 둔다.
 *
 * 이건 **추측이다.** 그래서 guessedMeridiem으로 표시해 화면에서 밝힌다. 원장이
 * schedule에 "오전"이나 24시간 표기를 적어 두면 추측하지 않는다.
 */
function toMinutes(t: RawTime): number {
  let h = t.hour;
  if (t.meridiem === "am") h = h === 12 ? 0 : h;
  else if (t.meridiem === "pm") h = h < 12 ? h + 12 : h;
  else if (!t.explicit && h >= 1 && h <= 8) h += 12;
  return h * 60 + t.minute;
}

function isGuess(t: RawTime): boolean {
  return t.meridiem === null && !t.explicit && t.hour >= 1 && t.hour <= 8;
}

/** "오전 9:00", "8시 30분", "3시30분", "19:00" 한 개를 가리키는 조각. */
const TIME_TOKEN = "(?:오전|오후|저녁|밤)?\\s*\\d{1,2}\\s*(?::\\s*\\d{2}|시(?:\\s*\\d{1,2}\\s*분?)?)";
const TIME_RANGE = new RegExp(`(${TIME_TOKEN})\\s*[~\\-–]\\s*(${TIME_TOKEN})`);

/** 한 덩어리("화 목 8:00~10:00")에서 시작·끝 시각을 읽는다. */
function parseTimeRange(
  segment: string
): { startMin: number; endMin: number; guessed: boolean } | null {
  // 문자열을 붙임표로 쪼개면 안 된다. "토-일 14:30-16:30"의 첫 붙임표는 요일
  // 구분자라 쪼갠 조각이 ["토", "일 14:30", "16:30"]이 되어 시각을 놓친다.
  // 시각처럼 생긴 두 조각을 정규식으로 직접 찾는다.
  const m = segment.match(TIME_RANGE);
  if (!m) {
    // "토일 3시30분" — 끝 시각이 없다. 학원 수업은 대개 한 시간 반이지만
    // 지어내면 옆 수업과 겹쳐 보이므로 격자에 올리지 않는다.
    return null;
  }

  const a = readTime(m[1]);
  const b = readTime(m[2]);
  if (!a || !b) return null;

  const startMin = toMinutes(a);
  let endMin = toMinutes(b);

  // "8:00~10:00" → 시작 20:00, 끝 10:00이 되어 거꾸로 뒤집힌다. 끝이 시작보다
  // 앞이면 오후로 넘긴다. 밤 12시를 넘겨 이어지는 학원 수업은 없다.
  let guessed = isGuess(a) || isGuess(b);
  if (endMin <= startMin && b.meridiem === null && !b.explicit) {
    endMin += 12 * 60;
    guessed = true;
  }
  if (endMin <= startMin) return null;

  return { startMin, endMin, guessed };
}

/**
 * 일정 문자열을 격자에 올릴 칸들로 바꾼다.
 *
 * fallbackDayText는 요일이 일정에 없을 때 들여다볼 곳이다. 보통 반 이름을 준다 —
 * "[정]주말 고1 오후"는 일정이 "13:00~15:00"뿐이라 이름에서 "주말"을 읽어야
 * 토·일에 놓을 수 있다.
 */
export function parseSchedule(schedule: string, fallbackDayText = ""): Slot[] {
  const out: Slot[] = [];
  const segments = (schedule ?? "").split(/[,，]/);

  // 뒤 덩어리에 요일이 없으면 앞 덩어리의 요일을 잇는다. "월 수 5:30~7:30, 7:00~8:30"
  let lastDays: Day[] = [];

  for (const seg of segments) {
    if (!seg.trim()) continue;
    let days = parseDays(seg);
    if (days.length === 0) days = lastDays;
    if (days.length === 0) days = parseDays(fallbackDayText);
    if (days.length === 0) continue;
    lastDays = days;

    const range = parseTimeRange(seg);
    if (!range) continue;

    for (const day of days) {
      out.push({
        day,
        startMin: range.startMin,
        endMin: range.endMin,
        guessedMeridiem: range.guessed,
      });
    }
  }

  return out;
}

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
