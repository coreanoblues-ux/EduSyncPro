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
 * 숫자 뒤에 붙으면 그 숫자가 돈이 아님을 알려주는 단위들.
 *
 * 이게 없으면 "7월 원비 28만원"에서 7이 7원으로, "숭의중1"에서 1이 1원으로
 * 잡혀 금액 후보 첫 자리를 차지한다. arbitrate()가 amounts[0]을 쓰기 때문에
 * 그 순간 정상 금액 28만원은 버려지고 "금액이 범위를 벗어남"으로 되물어진다.
 *
 * 긴 단위를 먼저 둬야 한다. "학년"이 "년"보다, "개월"이 "월"보다 앞이다.
 */
const NON_MONEY_SUFFIX_RE = /^\s*(개월|학년|교시|월|일|년|시|분|명|주|번|호|층|살|차|급|반)/;

/**
 * "35만원", "350,000원", "35만 5천", "1억 2천만원" 같은 표현을 숫자로 환산한다.
 * 규칙 4번("만원은 10000을 곱한다")을 코드로 구현한 것.
 *
 * 돈이 아닌 숫자(날짜·학년·전화번호)는 후보에서 제외한다.
 * 반환값은 원문에 등장한 순서대로의 금액 후보 목록.
 */
export function extractAmounts(text: string): number[] {
  const amounts: number[] = [];

  // 전화번호 자릿수가 금액으로 새어 들어가지 않도록 먼저 지운다.
  // ("010-1234-5678 28만원"에서 010·1234·5678이 금액 후보가 되는 것을 막는다)
  const src = text.replace(new RegExp(PHONE_RE.source, "g"), " ");

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
  while ((m = TOKEN_RE.exec(src)) !== null) {
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
    const contiguous = lastEnd >= 0 && /^[\s]*$/.test(src.slice(lastEnd, start));
    if (!contiguous) flush();

    const value = parseFloat(numRaw.replace(/,/g, ""));
    if (!Number.isFinite(value)) {
      lastEnd = start + full.length;
      continue;
    }

    // ── 돈이 아닌 숫자 걸러내기 ──
    // "만"·"천" 같은 단위나 "원"이 붙어 있으면 금액이 분명하므로 검사하지 않는다.
    const numEnd = start + numRaw.length;
    if (!unit && !won) {
      // "7월", "13일", "1학년", "3개월" — 뒤에 오는 단위가 돈이 아님을 말해준다
      if (NON_MONEY_SUFFIX_RE.test(src.slice(numEnd))) {
        flush();
        lastEnd = numEnd;
        continue;
      }
      // "숭의중1", "중2" — 한글에 띄어쓰기 없이 붙은 숫자는 학년·식별자이지 금액이 아니다.
      // 단, "35만 5천"처럼 이미 시작된 금액 표현을 이어가는 중이면 적용하지 않는다.
      const prev = start > 0 ? src[start - 1] : "";
      if (!sawUnit && /[가-힣]/.test(prev)) {
        flush();
        lastEnd = numEnd;
        continue;
      }
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

// ─── 납부 기준일 / 등록일 ─────────────────────────────────────────────────

/**
 * "기준일 13일", "매월 13일" 같은 표현에서 납부 기준일(1~31)을 뽑는다.
 *
 * 키워드가 붙은 경우에만 인정한다. 문장에 떠 있는 아무 "13일"이나 집으면
 * "13일에 상담함" 같은 문장에서 엉뚱한 청구 기준일이 만들어지기 때문이다.
 */
export function extractDueDay(text: string): number | null {
  const patterns = [
    /(?:납부|납입|수납)?\s*기준일\s*(?:은|는|:)?\s*(?:매\s*월\s*)?(\d{1,2})\s*일?/,
    /매\s*월\s*(\d{1,2})\s*일/,
    /(\d{1,2})\s*일\s*기준/,
    /(?:납부|납입|수납)일\s*(?:은|는|:)?\s*(\d{1,2})\s*일?/,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const day = Number(m[1]);
    if (Number.isInteger(day) && day >= 1 && day <= 31) return day;
  }
  return null;
}

/** 연도가 생략된 "8월 13일"을 해석한다. 12월에 "1월"이라고 하면 다음 해로 본다. */
function inferYear(month: number, now: Date): number {
  const diff = month - (now.getMonth() + 1);
  if (diff <= -6) return now.getFullYear() + 1;
  if (diff >= 7) return now.getFullYear() - 1;
  return now.getFullYear();
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // 2월 30일 같은 값을 걸러낸다 (Date가 조용히 다음 달로 넘겨버리므로 되돌려 확인)
  const d = new Date(year, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * "2026-08-13", "8월 13일", "8/13" 같은 표현을 등록일(YYYY-MM-DD)로 변환한다.
 *
 * 월만 있고 일이 없는 "8월 등록"은 날짜를 지어내지 않고 null을 반환한다.
 * 등록일은 몇 달치 미납을 계산하는 기준이라, 추측해서 틀리면 청구가 어긋난다.
 */
export function extractStartDate(text: string, now: Date = new Date()): string | null {
  const iso = text.match(/(20\d{2})[-./](0?[1-9]|1[0-2])[-./](0?[1-9]|[12]\d|3[01])(?!\d)/);
  if (iso) {
    const hit = toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (hit) return hit;
  }

  const korean = text.match(/(1[0-2]|[1-9])\s*월\s*(0?[1-9]|[12]\d|3[01])\s*일/);
  if (korean) {
    const month = Number(korean[1]);
    const hit = toIsoDate(inferYear(month, now), month, Number(korean[2]));
    if (hit) return hit;
  }

  // "8/13" — 앞뒤에 숫자가 붙어 있으면(전화번호·금액 조각) 날짜로 보지 않는다
  const slash = text.match(/(?<![\d/])(1[0-2]|[1-9])\/(0?[1-9]|[12]\d|3[01])(?![\d/])/);
  if (slash) {
    const month = Number(slash[1]);
    const hit = toIsoDate(inferYear(month, now), month, Number(slash[2]));
    if (hit) return hit;
  }

  return null;
}

// ─── 상담 상태 / 결제 유형 / 결제 수단 ───────────────────────────────────

/**
 * "등록", "신규등록", "대기" 같은 표현에서 상담 상태를 결정한다.
 *
 * AI에게 맡기면 "홍효서 등록"을 상담문의로 흘려보내는 일이 잦았다.
 * 최종등록은 학생·수강 등록을 실제로 만드는 분기라 원장이 기대한 대로
 * 걸려야 해서, 명시적인 낱말은 코드가 직접 판단한다.
 *
 * 우선순위가 곧 규칙이다. "등록 보류"는 보류이고, "등록 문의"는 문의다.
 * 다만 "최종등록"·"등록생"처럼 이미 등록이 끝났음을 뜻하는 말은 문의보다 세다.
 */
export function extractConsultationStatus(
  text: string
): "상담문의" | "대기등록" | "최종등록" | "보류" | null {
  if (/보류|철회|거절|등록\s*취소|안\s*하기로|그만/.test(text)) return "보류";

  // 등록이 완료됐음을 명시하는 표현 — "등록 문의"보다 우선한다
  if (
    /최종\s*등록|신규\s*등록|정식\s*등록|등록\s*생|등록\s*완료|등록\s*했|등록\s*함|등록\s*시켜|등록\s*시켰|등록\s*처리|등록\s*확정/.test(
      text
    )
  ) {
    return "최종등록";
  }

  if (/대기(?!\s*중이지)|웨이팅|웨이트|자리\s*나면/.test(text)) return "대기등록";
  if (/문의|상담|알아보|물어/.test(text)) return "상담문의";

  // 위 어느 것도 아닌 채로 "등록"만 있으면 등록으로 본다 ("홍효서 등록")
  if (
    /등록|입반|반\s*(?:에|으로)?\s*(?:넣|배정|편성|올려)|들어오기로|다니기로|시작하기로/.test(text)
  ) {
    return "최종등록";
  }

  return null;
}

/**
 * "결제", "수납", "환불", "지출" 같은 낱말에서 결제 유형을 결정한다.
 *
 * AI가 "결제"를 환불로 뒤집는 일이 있었는데, 환불은 금액이 음수로 저장되므로
 * 한 번 틀리면 매출이 두 배로 어긋난다. 그래서 낱말이 분명하면 코드가 이긴다.
 */
export function extractPaymentType(text: string): "원비" | "환불" | "지출" | "기타" | null {
  if (/환불|환급|반환|돌려\s*(주|줌|드림|드렸)|결제\s*취소|취소\s*환/.test(text)) return "환불";
  if (/지출|매입|구입|구매|수리|임대료|월세|공과금|급여|인건비|비품|운영비/.test(text)) return "지출";
  if (/원비|수강료|학원비|교습비|수납|결제|납부|입금|완납|선납/.test(text)) return "원비";
  return null;
}

/** "카드로 결제", "계좌이체", "현금" 에서 결제 수단을 뽑는다. */
export function extractPaymentMethod(text: string): "계좌이체" | "카드" | "현금" | null {
  if (/계좌\s*이체|이체|무통장|송금|입금\s*받/.test(text)) return "계좌이체";
  if (/카드|신용\s*카드|체크\s*카드/.test(text)) return "카드";
  if (/현금/.test(text)) return "현금";
  return null;
}

// ─── 반 관리(생성·수정) ────────────────────────────────────────────────────

/**
 * 이 문장이 "반 자체를 만들거나 고치는" 말인지 판정한다.
 *
 * AI 판단만 믿으면 "강단우 국어반 추가"(학생을 반에 넣는 말)를 반 생성으로
 * 오해해 엉뚱한 반이 하나 더 생긴다. 그래서 AI가 반 작업이라고 해도 원문에
 * 아래 표현이 실제로 들어 있을 때만 반 초안으로 넘긴다.
 *
 * "반 추가"를 생성 표현에서 뺀 것도 같은 이유다. 학생을 반에 추가하는 말과
 * 구분되지 않는다. 반을 새로 만들 때는 "신설·개설·만들"이라고 쓰게 한다.
 */
export function extractClassAction(text: string): "create" | "update" | null {
  const t = text.replace(/\s+/g, "");
  // 수정을 먼저 본다. "반 만들 때 수강료 변경"처럼 둘 다 나오면 이미 있는 반을
  // 고치는 말일 가능성이 높고, 잘못 만드는 쪽이 잘못 고치는 쪽보다 되돌리기 어렵다.
  if (/(반|클래스)[^.]{0,12}?(수정|변경|바꿔|바꾸|고쳐|고치|올려|내려|없애|폐강)/.test(t)) {
    return "update";
  }
  if (/(수강료|원비|정원|시간표|일정|담당|강사|선생님)[^.]{0,8}?(수정|변경|바꿔|바꾸|고쳐|고치|올려|내려)/.test(t)) {
    return "update";
  }
  if (/(반|클래스)[^.]{0,8}?(신설|개설|생성|만들|만듦|개강)/.test(t)) return "create";
  if (/(신설|개설|새로운|새)(반|클래스)/.test(t)) return "create";
  return null;
}

/** "19:00-21:00", "7시~9시" 같은 수업 시간대를 원문에서 뽑는다. */
export function extractClassTime(text: string): string | null {
  const range = text.match(/(\d{1,2}:\d{2})\s*[-~–]\s*(\d{1,2}:\d{2})/);
  if (range) return `${range[1]}-${range[2]}`;
  const korean = text.match(/(\d{1,2})\s*시\s*[-~–]\s*(\d{1,2})\s*시/);
  if (korean) return `${korean[1].padStart(2, "0")}:00-${korean[2].padStart(2, "0")}:00`;
  return null;
}

/** "정원 20명", "최대 15명" 에서 정원을 뽑는다. */
export function extractMaxStudents(text: string): number | null {
  const m = text.match(/(?:정원|최대|최대\s*인원|인원)\s*(\d{1,3})\s*명|(\d{1,3})\s*명\s*(?:정원|까지)/);
  if (!m) return null;
  const n = parseInt(m[1] ?? m[2], 10);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : null;
}

// ─── 반 이름 ──────────────────────────────────────────────────────────────

/**
 * 원문에 학원의 반 이름이 들어 있으면 그 반을 찾아준다. ("김민준 초등부A반 등록")
 *
 * 지어내지 않는 것이 요점이다. 후보가 둘 이상 걸리면 어느 쪽인지 알 수 없으므로
 * null을 돌려 원장이 직접 고르게 한다.
 */
export function matchClassName<T extends { id: string; name: string }>(
  text: string,
  classes: T[]
): T | null {
  const normalized = text.replace(/\s+/g, "");
  // 긴 이름부터 본다 — "A반"과 "초등A반"이 함께 있으면 더 구체적인 쪽이 맞다
  const sorted = [...classes].sort((a, b) => b.name.length - a.name.length);
  const hits = sorted.filter((c) => {
    const name = c.name.replace(/\s+/g, "");
    return name.length >= 2 && normalized.includes(name);
  });
  if (hits.length === 0) return null;
  // 가장 긴 이름이 다른 후보를 모두 포함하면 그것이 정답이다 ("초등A반" ⊃ "A반")
  const best = hits[0].name.replace(/\s+/g, "");
  const ambiguous = hits.some((c) => !best.includes(c.name.replace(/\s+/g, "")));
  return ambiguous ? null : hits[0];
}

/**
 * "화요일"·"화" 를 모두 "화"로 통일하고 중복을 없앤다.
 *
 * "요일"을 먼저 떼는 것이 중요하다. 안 그러면 "화요일"의 마지막 글자 "일"이
 * 일요일로 잡혀 화·목 반이 화·목·일 반으로 둔갑한다.
 */
function normalizeDays(days: string[] | string): string[] {
  const raw = (Array.isArray(days) ? days.join(" ") : days).replace(/요일/g, "");
  const found = raw.match(/[월화수목금토일]/g) ?? [];
  return Array.from(new Set(found)).sort();
}

export interface ClassHintInput {
  scheduleDays: string[] | null;
  teacherName: string | null;
  level: string | null;
}

export interface ClassRow {
  id: string;
  name: string;
  schedule: string;
  teacherName: string | null;
}

/**
 * "정우석 선생님 화 목 심화"처럼 요일·강사·레벨로 지목된 반을 실제 반 목록에서 찾는다.
 *
 * 반 이름은 학원마다 제각각이라 AI에게 맡길 수 없다. 문장에서 뽑은 재료 3가지로
 * 후보를 좁히되, 하나로 확정되지 않으면 match=null로 두고 후보만 돌려준다.
 * 원장이 화면에서 고르는 편이 잘못된 반에 등록하는 것보다 낫다.
 */
export function matchClass(
  hint: ClassHintInput,
  classes: ClassRow[]
): { match: ClassRow | null; candidates: ClassRow[] } {
  const wantDays = hint.scheduleDays?.length ? normalizeDays(hint.scheduleDays) : null;
  const wantTeacher = hint.teacherName?.replace(/\s+/g, "") || null;
  const wantLevel = hint.level?.replace(/\s+/g, "") || null;

  // 재료가 하나도 없으면 추측하지 않는다
  if (!wantDays && !wantTeacher && !wantLevel) return { match: null, candidates: [] };

  const candidates = classes.filter((c) => {
    if (wantDays) {
      const has = normalizeDays(c.schedule);
      // 요일이 정확히 같아야 한다. "화목"과 "화목토"는 다른 반이다.
      if (has.join("") !== wantDays.join("")) return false;
    }
    if (wantTeacher) {
      const t = c.teacherName?.replace(/\s+/g, "") ?? "";
      if (t !== wantTeacher) return false;
    }
    if (wantLevel) {
      if (!c.name.replace(/\s+/g, "").includes(wantLevel)) return false;
    }
    return true;
  });

  return { match: candidates.length === 1 ? candidates[0] : null, candidates };
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

/**
 * 이름이 같거나 부분 일치하는 후보가 여러 명일 때, 원문에 딸려온 힌트로 좁힌다.
 *
 * 원장이 급할 때 "김민 중2 수납"처럼 이름 뒤에 구별되는 낱말 하나를 붙이는 것을
 * 노린 함수다. 학년·학교·반 이름·강사 이름 중 원문에 등장하는 것이 가장 많은
 * 후보만 남긴다.
 *
 * 힌트가 하나도 안 맞으면 아무도 떨어뜨리지 않고 전원을 돌려준다. 잘못 좁혀서
 * 엉뚱한 학생에게 수납이 꽂히는 것보다, 원장에게 전부 보여주고 고르게 하는 편이 낫다.
 */
export function narrowByHint<T extends { hints: Array<string | null | undefined> }>(
  candidates: T[],
  text: string
): T[] {
  if (candidates.length <= 1) return candidates;
  const haystack = text.replace(/\s+/g, "");

  const scored = candidates.map((c) => {
    const hits = c.hints.filter((h) => {
      const needle = h?.replace(/\s+/g, "");
      // 한 글자 힌트는 우연히 걸리기 쉬워 세지 않는다
      return needle && needle.length >= 2 && haystack.includes(needle);
    }).length;
    return { candidate: c, hits };
  });

  const best = Math.max(...scored.map((s) => s.hits));
  if (best === 0) return candidates;
  return scored.filter((s) => s.hits === best).map((s) => s.candidate);
}

// ─── 학생·교사 정보 수정 ──────────────────────────────────────────────────

export type PersonTarget = "student" | "teacher";
export type PersonAction = "create" | "update";

/**
 * "학생 수정", "교사 추가", "교사 수정" 같은 명시적 지시인지 판정한다.
 *
 * 여기는 AI 동의를 요구하지 않는다. 반 생성과 달리 원장이 외워서 치는 고정 명령어라
 * 원문에 그대로 들어 있고, AI가 못 알아들었다는 이유로 명령이 씹히면 오히려 답답하다.
 *
 * 학생 "추가"는 일부러 뺐다. 신규 학생은 기존 등록 흐름(학생+수강등록+수납)으로
 * 만들어야 반 배정과 납부 기준일이 함께 잡힌다. 여기서 만들면 반 없는 학생이 생긴다.
 */
export function extractPersonAction(
  text: string
): { target: PersonTarget; action: PersonAction } | null {
  const t = text.replace(/\s+/g, "");
  const TEACHER = "(교사|강사|선생님|쌤)";
  const UPDATE = "(수정|변경|바꿔|바꾸|고쳐|고침)";

  // "정보"는 끼어들 수 있다 — "교사 정보 수정"과 "교사 수정"은 같은 말이다.
  // 그 외 낱말까지 허용하면 "교사가 학부모 연락처 변경 요청"처럼
  // 사람 수정이 아닌 문장까지 걸린다.
  const OF = "(정보)?";

  if (new RegExp(`${TEACHER}${OF}${UPDATE}`).test(t)) return { target: "teacher", action: "update" };
  if (new RegExp(`${TEACHER}${OF}(추가|등록|신규|생성)`).test(t))
    return { target: "teacher", action: "create" };
  if (new RegExp(`학생${OF}${UPDATE}`).test(t)) return { target: "student", action: "update" };
  return null;
}

/**
 * "학생 수정 김민준 …", "교사 추가 박지훈 …"에서 명령어 바로 뒤 이름을 뽑는다.
 *
 * AI가 이름 칸을 안 채워도 수정 화면에 이름이 들어가게 하려는 보루다. 원장이
 * 명령어 다음에 이름부터 치는 것은 거의 확실하므로 그 자리만 본다. 뒤쪽 아무
 * 낱말이나 이름으로 집으면 "학교"·"연락처" 같은 항목명이 이름으로 들어간다.
 */
export function extractCommandName(text: string): string | null {
  const m = text
    .trim()
    .match(
      /(?:학생|교사|강사|선생님|쌤)\s*(?:정보)?\s*(?:수정|변경|추가|등록|신규|생성)\s+([가-힣a-zA-Z]{2,5})/
    );
  if (!m) return null;
  // 이름 자리에 항목명이 오면(= "학생 수정 학교 …") 이름이 생략된 것이다
  if (/^(학교|학년|이름|과목|연락처|전화|번호|메모|정보)$/.test(m[1])) return null;
  return cleanStudentName(m[1]);
}

/** "김하늘 선생님", "담당 정우석T"처럼 적힌 강사 이름을 뽑는다. */
export function extractTeacherName(text: string): string | null {
  const m = text.match(/([가-힣]{2,4})\s*(?:선생님|샘|쌤|T\b|강사|교사)/);
  return m ? cleanStudentName(m[1]) : null;
}

/**
 * "중등심화반 신설", "국어반 수강료 변경"에서 반 이름을 뽑는다.
 *
 * 반 이름은 학원마다 제각각이라 최종 확정은 실제 반 목록과 대조해서 한다.
 * 여기서는 "…반" 꼴만 집어 화면 입력칸을 미리 채우는 용도다.
 */
export function extractClassNameFromText(text: string): string | null {
  const m = text.match(/([가-힣a-zA-Z0-9]{1,10}반)/);
  return m ? m[1] : null;
}

/**
 * "문의 왔어요", "상담 전화" 처럼 남의 말을 옮긴 문장인지 본다.
 *
 * "수강료 변경 문의 왔어요"는 반을 고치라는 지시가 아니라 상담 기록이다.
 * 이 구분이 없으면 문의 전화 한 통에 반 수강료가 실제로 바뀐다.
 */
export function looksLikeInquiry(text: string): boolean {
  return /(문의|여쭤|물어|상담\s*(전화|요청|옴|왔)|전화\s*(왔|옴)|왔어요|왔습니다)/.test(text);
}

/** "담당 과목은 수학", "수학 담당" 처럼 적힌 과목을 뽑는다. */
export function extractSubject(text: string): string | null {
  const m = text.match(
    /(국어|영어|수학|과학|사회|역사|물리|화학|생물|지구과학|논술|한문|중국어|일본어)/
  );
  return m ? m[1] : null;
}
