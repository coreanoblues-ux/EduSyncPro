/**
 * 자연어 입력 정규화 유틸리티
 *
 * 이 파일은 OpenAI 응답을 "믿지 않기 위해" 존재한다.
 * 전화번호 / 금액 / 월(月) 처럼 틀리면 회계가 망가지는 값은
 * 여기 있는 순수 함수로 원문에서 직접 다시 뽑아내 AI 결과와 대조한다.
 *
 * 외부 의존성이 없으므로 API 키 없이 단독 테스트할 수 있다.
 */

// ─── 전화번호 ──────────────────────────────────────────────────────────────

// 휴대폰(010-1234-5678, 01012345678) 및 지역번호(02-123-4567, 031-123-4567)
//
// 앞뒤의 (?<!\d) / (?!\d) 가 핵심이다. 이게 없으면 자릿수를 틀리게 친 번호
// (예: "0101234567890" — 한 자리 더 침) 에서 정규식이 문자열 중간부터 매칭돼
// "012-3456-7890" 이라는 존재하지도 않는 번호를 조용히 만들어낸다.
// 자릿수가 안 맞으면 아예 못 찾은 것으로 처리해 사용자가 다시 입력하게 하는 편이 안전하다.
const PHONE_RE = /(?<!\d)(0\d{1,2})[-.\s]?(\d{3,4})[-.\s]?(\d{4})(?!\d)/g;

/**
 * 원문에서 전화번호를 모두 찾아 하이픈 형식으로 정규화한다.
 * 분류 규칙 1번("전화번호가 하나라도 있으면 무조건 CONTACT")을
 * AI가 아니라 코드가 최종 판단하도록 하기 위한 함수.
 */
export function extractPhones(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(PHONE_RE.source, "g"); // 호출 간 lastIndex 공유를 피하려고 새로 만든다
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const normalized = `${m[1]}-${m[2]}-${m[3]}`;
    if (out.indexOf(normalized) === -1) out.push(normalized);
  }
  return out;
}

/** 전화번호를 010-1234-5678 형태로 통일. 형식을 못 맞추면 원본을 그대로 반환. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const found = extractPhones(raw);
  return found[0] ?? raw.trim() ?? null;
}

// ─── 금액 ─────────────────────────────────────────────────────────────────

// "천만", "백만" 처럼 두 글자로 된 복합 단위를 먼저 매칭해야 하므로 순서가 중요하다.
// (이걸 놓치면 "2천만원"이 2,000원으로 읽힌다)
const UNIT_VALUE: Record<string, number> = {
  억: 100_000_000,
  천만: 10_000_000,
  백만: 1_000_000,
  십만: 100_000,
  만: 10_000,
  천: 1_000,
  백: 100,
  십: 10,
};
const UNIT_PATTERN = "억|천만|백만|십만|만|천|백|십";

/**
 * "35만원", "350,000원", "35만 5천", "1억 2천만원" 같은 표현을 숫자로 환산한다.
 * 규칙 4번("만원은 10000을 곱한다")을 코드로 구현한 것.
 *
 * 반환값은 원문에 등장한 순서대로의 금액 후보 목록.
 */
export function extractAmounts(text: string): number[] {
  const amounts: number[] = [];

  // 숫자 + (선택)단위 토큰을 순서대로 훑는다.
  const TOKEN_RE = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})?\\s*(원)?`, "g");

  let running = 0; // 단위가 붙은 항들의 누적 합 (예: 1억 2천만 → 100000000 + 20000000)
  let sawUnit = false;
  let lastUnitValue = Infinity; // 직전 단위의 크기 — 한국어 수 표기는 큰 단위부터 내려간다
  let lastEnd = -1;

  const flush = () => {
    if (running > 0) amounts.push(Math.round(running));
    running = 0;
    sawUnit = false;
    lastUnitValue = Infinity;
  };

  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const full = m[0];
    const numRaw = m[1];
    const unit = m[2];
    const won = m[3];
    const start = m.index;

    // 빈 문자열 매칭이면 무한 루프에 빠지므로 강제로 전진시킨다
    if (full === "") {
      TOKEN_RE.lastIndex++;
      continue;
    }

    // 앞 토큰과 떨어져 있으면(사이에 다른 글자가 끼어 있으면) 별개의 금액으로 본다.
    const contiguous = lastEnd >= 0 && /^[\s]*$/.test(text.slice(lastEnd, start));
    if (!contiguous) flush();

    const value = parseFloat(numRaw.replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      lastEnd = start + full.length;
      continue;
    }

    if (unit) {
      const unitValue = UNIT_VALUE[unit];
      // "1억 2천만"처럼 단위가 점점 작아질 때만 하나의 금액으로 이어붙인다.
      // "10만 20만"처럼 같거나 큰 단위가 다시 나오면 별개의 금액이므로 끊는다.
      // (이걸 안 하면 부분 납부 "10만원 20만원"이 30만원 하나로 합쳐져 버린다)
      if (sawUnit && unitValue >= lastUnitValue) flush();
      running += value * unitValue;
      sawUnit = true;
      lastUnitValue = unitValue;
    } else if (sawUnit) {
      // "35만 5000" 처럼 단위 뒤에 붙는 잔액
      running += value;
    } else {
      running += value;
    }

    lastEnd = start + full.length;

    // "원"으로 끝나면 하나의 금액 표현이 종료된 것
    if (won) flush();
  }
  flush();

  return amounts.filter((a) => a > 0);
}

/** 금액이 학원 수납으로 납득 가능한 범위인지. 오타(3500000원 등) 방어용. */
export const AMOUNT_MIN = 1_000;
export const AMOUNT_MAX = 10_000_000;

export function isPlausibleAmount(amount: number): boolean {
  return Number.isInteger(amount) && Math.abs(amount) >= AMOUNT_MIN && Math.abs(amount) <= AMOUNT_MAX;
}

// ─── 월(月) ───────────────────────────────────────────────────────────────

function ym(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(base: Date, delta: number): Date {
  return new Date(base.getFullYear(), base.getMonth() + delta, 1);
}

/**
 * "이번달", "지난달", "8월", "2026-08" 같은 표현을 payments.paymentMonth 형식(YYYY-MM)으로 변환.
 *
 * @param raw AI가 뽑아낸 month 문자열 (없으면 null)
 * @param text 원문 (AI가 놓쳤을 때 직접 다시 찾기 위함)
 * @param now  기준 시각 — 테스트에서 고정할 수 있도록 주입받는다
 */
export function normalizeMonth(
  raw: string | null | undefined,
  text: string,
  now: Date = new Date()
): string | null {
  const candidates = [raw ?? "", text];

  for (const src of candidates) {
    if (!src) continue;

    // 이미 YYYY-MM 형식
    const iso = src.match(/(20\d{2})[-./](0?[1-9]|1[0-2])(?!\d)/);
    if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}`;

    // 상대 표현
    if (/이번\s*달|이달|당월|금월/.test(src)) return ym(now);
    if (/지난\s*달|저번\s*달|전월|지난달/.test(src)) return ym(shiftMonth(now, -1));
    if (/다음\s*달|담달|익월|내달/.test(src)) return ym(shiftMonth(now, 1));

    // "8월" — 연도가 없으므로 현재 연도로 해석하되,
    // 12월에 "1월"이라고 하면 다음 해로 넘기는 것이 자연스럽다.
    const monthOnly = src.match(/(1[0-2]|[1-9])\s*월/);
    if (monthOnly) {
      const mm = Number(monthOnly[1]);
      let year = now.getFullYear();
      const diff = mm - (now.getMonth() + 1);
      if (diff <= -6) year += 1; // 예: 12월에 "1월" → 내년 1월
      if (diff >= 7) year -= 1; // 예: 1월에 "12월" → 작년 12월
      return `${year}-${String(mm).padStart(2, "0")}`;
    }
  }

  return null;
}

// ─── 학생 이름 ────────────────────────────────────────────────────────────

/**
 * AI가 뽑은 이름에서 조사·직함을 털어낸다. ("김민준이" → "김민준")
 * 한국어 이름은 2~4자가 대부분이라 그 범위를 벗어나면 신뢰하지 않는다.
 */
export function cleanStudentName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let name = raw.trim().replace(/\s+/g, "");
  name = name.replace(/(학생|어머니|아버지|님|씨)$/, "");
  name = name.replace(/(이가|이는|이랑|이|가|은|는|의|도)$/, "");
  if (!/^[가-힣a-zA-Z]{2,5}$/.test(name)) return null;
  return name;
}
