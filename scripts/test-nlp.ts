/**
 * 자연어 파서 검증 스크립트 — API 키 없이 실행된다.
 *
 *   npx tsx scripts/test-nlp.ts
 *
 * OpenAI를 호출하는 대신 "AI가 이렇게 답했다고 치자"는 가짜 응답을 넣고,
 * 코드 검증 레이어(arbitrate)가 제대로 걸러내는지 확인한다.
 * 일부러 AI가 규칙을 어긴 케이스를 넣어 코드가 이를 바로잡는지 본다.
 */

import { arbitrate } from "../server/lib/nlpParser";
import {
  extractPhones,
  extractAmounts,
  extractDueDay,
  extractStartDate,
  extractConsultationStatus,
  extractPaymentType,
  extractPaymentMethod,
  matchClassName,
} from "../server/lib/nlpNormalize";

const NOW = new Date(2026, 7, 14); // 2026-08-14 고정

type Ai = Parameters<typeof arbitrate>[0];

const blank: Ai = {
  category: "unclear",
  student_name: null,
  amount: null,
  type: null,
  month: null,
  payment_method: null,
  phone: null,
  guardian_name: null,
  student_grade: null,
  status: null,
  subject: null,
  follow_up: null,
  memo: null,
};

interface Case {
  label: string;
  text: string;
  ai: Partial<Ai>;
  expect: (r: ReturnType<typeof arbitrate>) => boolean;
  why: string;
}

const cases: Case[] = [
  {
    label: "기본 수납",
    text: "김민준 35만원 이번달 원비 계좌이체",
    ai: { category: "accounting", student_name: "김민준", amount: 350000, type: "원비", month: "이번달", payment_method: "계좌이체" },
    expect: (r) =>
      r.draft.category === "accounting" &&
      r.draft.amount === 350000 &&
      r.draft.paymentMonth === "2026-08" &&
      r.draft.method === "계좌이체" &&
      r.draft.studentName === "김민준",
    why: "정상 케이스는 그대로 통과해야 한다",
  },
  {
    label: "AI가 만원 환산을 틀림",
    text: "박서연 35만원 8월 원비",
    ai: { category: "accounting", student_name: "박서연", amount: 35, type: "원비", month: "8월" },
    expect: (r) =>
      r.draft.category === "accounting" &&
      r.draft.amount === 350000 &&
      r.corrections.some((c) => c.includes("정정")),
    why: "AI가 35라고 해도 원문 기준 350000으로 코드가 바로잡아야 한다",
  },
  {
    label: "전화번호 있는데 AI가 accounting이라 함",
    text: "010-1234-5678 어머니 30만원 문의",
    ai: { category: "accounting", amount: 300000, type: "원비", month: "이번달", student_name: "김철수" },
    expect: (r) =>
      r.draft.category === "contact" &&
      r.draft.phone === "010-1234-5678" &&
      r.corrections.some((c) => c.includes("상담")),
    why: "규칙 1 — 전화번호가 있으면 AI 판단을 무시하고 contact로 강제",
  },
  {
    label: "금액 없는 원비 문장",
    text: "김민준 이번달 원비",
    ai: { category: "contact", student_name: "김민준" },
    expect: (r) => r.draft.category === "unclear" && r.draft.question.includes("금액"),
    why: "원안대로 contact로 흘리면 회계 누락 — 되물어야 한다",
  },
  {
    label: "환불은 음수",
    text: "이지우 20만원 환불 지난달",
    ai: { category: "accounting", student_name: "이지우", amount: 200000, type: "환불", month: "지난달" },
    expect: (r) =>
      r.draft.category === "accounting" &&
      r.draft.amount === -200000 &&
      r.draft.paymentMonth === "2026-07",
    why: "Payments 화면이 SUM(amount)를 쓰므로 환불은 음수여야 순액이 맞는다",
  },
  {
    label: "자릿수 오타 방어",
    text: "최유나 3500000000원 원비 이번달",
    ai: { category: "accounting", student_name: "최유나", amount: 3500000000, type: "원비", month: "이번달" },
    expect: (r) => r.draft.category === "unclear" && r.draft.reason.includes("범위"),
    why: "35억원 수강료는 오타 — 저장하지 말고 되물어야 한다",
  },
  {
    label: "학생 이름 없는 수납",
    text: "35만원 이번달 원비 입금",
    ai: { category: "accounting", amount: 350000, type: "원비", month: "이번달", student_name: null },
    expect: (r) => r.draft.category === "unclear" && r.draft.question.includes("학생"),
    why: "enrollmentId를 찾을 수 없으므로 저장 불가 — 되물어야 한다",
  },
  {
    label: "지출은 학생 이름 없어도 통과",
    text: "에어컨 수리비 15만원 지출 이번달",
    ai: { category: "accounting", amount: 150000, type: "지출", month: "이번달", student_name: null },
    expect: (r) => r.draft.category === "accounting" && r.draft.amount === -150000,
    why: "학원 운영 지출은 수강 등록과 무관하다",
  },
  {
    label: "AI가 이름을 지어냄",
    text: "35만원 이번달 원비",
    ai: { category: "accounting", amount: 350000, type: "원비", month: "이번달", student_name: "홍길동" },
    expect: (r) => r.draft.category === "accounting" && r.draft.studentName === "홍길동",
    why: "여기서는 코드가 막을 수 없다 — 그래서 저장 전 확인 UI가 반드시 필요하다",
  },
  {
    label: "상담 문의 전체 필드",
    text: "010-9876-5432 박지민 어머니 중2 영어 문의, 다음주 화요일 재통화",
    ai: {
      category: "contact",
      phone: "01098765432",
      guardian_name: "박지민 어머니",
      student_grade: "중2",
      subject: "영어",
      status: "상담문의",
      follow_up: "다음주 화요일 재통화",
    },
    expect: (r) =>
      r.draft.category === "contact" &&
      r.draft.phone === "010-9876-5432" &&
      r.draft.studentGrade === "중2" &&
      r.draft.followUp === "다음주 화요일 재통화",
    why: "전화번호는 하이픈 형식으로 정규화되어야 한다",
  },
  {
    label: "전화번호도 금액도 없음",
    text: "오늘 날씨 좋네",
    ai: { category: "contact" },
    expect: (r) => r.draft.category === "unclear",
    why: "추측해서 저장하느니 되묻는 편이 낫다",
  },
  {
    label: "금액이 두 개",
    text: "김민준 35만원 중 10만원만 입금 이번달 원비",
    ai: { category: "accounting", student_name: "김민준", amount: 100000, type: "원비", month: "이번달" },
    expect: (r) =>
      r.draft.category === "accounting" && r.corrections.some((c) => c.includes("여러 개")),
    why: "부분 납부는 사람이 확인해야 하므로 경고를 띄운다",
  },
  {
    label: "최종등록 — 기준일·등록일 추출",
    text: "010-9612-4295 홍효서 등록생 기준일 13일, 8월 13일 최초 등록",
    ai: { category: "contact", phone: "010-9612-4295", student_name: "홍효서", status: "최종등록" },
    expect: (r) =>
      r.draft.category === "contact" &&
      r.draft.status === "최종등록" &&
      r.draft.dueDay === 13 &&
      r.draft.startDate === "2026-08-13",
    why: "수강 등록에 넣을 기준일·등록일을 원문에서 뽑아야 한다",
  },
  {
    label: "상담 — 기준일·등록일이 없으면 지어내지 않는다",
    text: "010-1234-5678 박서연 어머니 중2 영어 문의",
    ai: { category: "contact", phone: "010-1234-5678", student_name: "박서연", student_grade: "중2", subject: "영어" },
    expect: (r) =>
      r.draft.category === "contact" && r.draft.dueDay === null && r.draft.startDate === null,
    why: "값이 없으면 null로 두고 원장이 직접 채우게 해야 한다",
  },
  {
    label: "AI가 '등록'을 상담문의로 흘림",
    text: "010-1234-5678 김민준 중2 영어 등록",
    ai: { category: "contact", phone: "010-1234-5678", student_name: "김민준", student_grade: "중2", subject: "영어", status: "상담문의" },
    expect: (r) =>
      r.draft.category === "contact" &&
      r.draft.status === "최종등록" &&
      r.corrections.some((c) => c.includes("최종등록")),
    why: "'등록'이라고 썼는데 상담문의로 남으면 학생이 생성되지 않아 학생 목록에 안 뜬다",
  },
  {
    label: "AI가 '결제'를 환불로 뒤집음",
    text: "김민준 35만원 이번달 카드 결제",
    ai: { category: "accounting", student_name: "김민준", amount: 350000, type: "환불", month: "이번달" },
    expect: (r) =>
      r.draft.category === "accounting" &&
      r.draft.type === "원비" &&
      r.draft.amount === 350000 &&
      r.draft.method === "카드",
    why: "환불로 저장되면 금액이 음수라 매출이 70만원만큼 어긋난다",
  },
  {
    label: "환불이라고 쓰면 AI가 뭐라 하든 환불",
    text: "이지우 20만원 환불 지난달",
    ai: { category: "accounting", student_name: "이지우", amount: 200000, type: "원비", month: "지난달" },
    expect: (r) => r.draft.category === "accounting" && r.draft.amount === -200000,
    why: "코드가 결제 쪽으로 과보정해서 환불을 놓치면 안 된다",
  },
  {
    label: "연락처 없는 등록 요청",
    text: "김민준 초등A반에 넣어줘",
    ai: { category: "unclear" },
    expect: (r) => r.draft.category === "unclear" && r.draft.question.includes("연락처"),
    why: "무엇이 빠졌는지 알려줘야 원장이 다시 칠 수 있다",
  },
];

let pass = 0;
let fail = 0;

// ─── 정규화 함수 단위 테스트 ────────────────────────────────────────────────
// "그럴듯하지만 틀린 값"을 만들어내는 입력이 가장 위험하다.
// 명백히 틀린 결과는 사람이 잡아내지만, 그럴듯한 값은 그냥 저장되기 때문.

const phoneCases: Array<[string, string[]]> = [
  ["010-1234-5678", ["010-1234-5678"]],
  ["01012345678", ["010-1234-5678"]],
  ["어머니 01098765432 상담", ["010-9876-5432"]],
  ["02-123-4567", ["02-123-4567"]],
  // 자릿수 오타 — 절대 그럴듯한 번호를 지어내면 안 된다
  ["0101234567890", []],
  ["010123456789", []],
  ["35만원 납부", []],
];

const amountCases: Array<[string, number[]]> = [
  ["35만원", [350000]],
  ["1억 2천만원", [120000000]],
  ["12만3천원", [123000]],
  ["35만 5천원", [355000]],
  // 부분 납부 — 합쳐지면 안 된다
  ["10만원 20만원", [100000, 200000]],
  ["1만 2만 3만", [10000, 20000, 30000]],
];

const dueDayCases: Array<[string, number | null]> = [
  ["기준일 13일", 13],
  ["납부 기준일은 27일", 27],
  ["매월 5일 납부", 5],
  ["10일 기준", 10],
  // 키워드 없이 떠 있는 날짜를 청구 기준일로 오해하면 안 된다
  ["13일에 상담함", null],
  ["010-9612-4295 홍효서 등록생", null],
  ["기준일 45일", null],
];

const startDateCases: Array<[string, string | null]> = [
  ["2026-08-13 등록", "2026-08-13"],
  ["8월 13일 등록", "2026-08-13"],
  ["8/13 등록", "2026-08-13"],
  // 연도가 없으면 가까운 쪽으로 — 2026-08 기준 "1월"은 내년
  ["1월 5일 등록", "2027-01-05"],
  // 일(日)이 없으면 날짜를 지어내지 않는다
  ["8월 최초 등록", null],
  // 존재하지 않는 날짜
  ["2월 30일 등록", null],
  ["010-9612-4295 홍효서", null],
];

const statusCases: Array<[string, string | null]> = [
  ["010-1234-5678 김민준 등록", "최종등록"],
  ["010-1234-5678 김민준 신규등록", "최종등록"],
  ["010-1234-5678 김민준 최종등록", "최종등록"],
  ["010-1234-5678 김민준 등록생", "최종등록"],
  ["김민준 초등A반에 넣어줘", "최종등록"],
  ["김민준 다음주부터 다니기로 함", "최종등록"],
  // "등록"이 들어 있어도 문의는 문의다
  ["010-1234-5678 등록 문의", "상담문의"],
  ["중2 영어 상담", "상담문의"],
  ["자리 나면 연락 달라고 함", "대기등록"],
  ["대기 걸어둠", "대기등록"],
  // 등록이 끝났다는 표현은 문의보다 세다
  ["상담 후 등록 완료", "최종등록"],
  ["등록 보류", "보류"],
  ["등록 취소함", "보류"],
  ["오늘 날씨 좋네", null],
];

const paymentTypeCases: Array<[string, string | null]> = [
  ["김민준 35만원 결제", "원비"],
  ["김민준 35만원 카드 결제", "원비"],
  ["김민준 35만원 수납", "원비"],
  ["김민준 35만원 이번달 원비 입금", "원비"],
  ["이지우 20만원 환불", "환불"],
  ["이지우 20만원 결제 취소", "환불"],
  ["에어컨 수리비 15만원 지출", "지출"],
  ["프린터 토너 5만원 구입", "지출"],
  ["김민준 35만원", null],
];

const methodCases: Array<[string, string | null]> = [
  ["김민준 35만원 카드 결제", "카드"],
  ["김민준 35만원 계좌이체", "계좌이체"],
  ["김민준 35만원 현금", "현금"],
  ["김민준 35만원 결제", null],
];

const classList = [
  { id: "c1", name: "초등A반" },
  { id: "c2", name: "A반" },
  { id: "c3", name: "중등심화" },
];
const classCases: Array<[string, string | null]> = [
  ["김민준 초등A반 등록", "c1"], // 더 구체적인 이름이 이긴다
  ["김민준 중등심화 등록", "c3"],
  ["김민준 A반 등록", "c2"],
  ["김민준 등록", null],
  ["김민준 고등B반 등록", null], // 없는 반을 지어내지 않는다
];

for (const [input, expected] of statusCases) {
  const got = extractConsultationStatus(input);
  if (got === expected) { pass++; console.log(`✅ [상태] ${JSON.stringify(input)}`); }
  else { fail++; console.log(`❌ [상태] ${JSON.stringify(input)} → ${got} (기대 ${expected})`); }
}

for (const [input, expected] of paymentTypeCases) {
  const got = extractPaymentType(input);
  if (got === expected) { pass++; console.log(`✅ [유형] ${JSON.stringify(input)}`); }
  else { fail++; console.log(`❌ [유형] ${JSON.stringify(input)} → ${got} (기대 ${expected})`); }
}

for (const [input, expected] of methodCases) {
  const got = extractPaymentMethod(input);
  if (got === expected) { pass++; console.log(`✅ [수단] ${JSON.stringify(input)}`); }
  else { fail++; console.log(`❌ [수단] ${JSON.stringify(input)} → ${got} (기대 ${expected})`); }
}

for (const [input, expected] of classCases) {
  const got = matchClassName(input, classList);
  if ((got?.id ?? null) === expected) { pass++; console.log(`✅ [반] ${JSON.stringify(input)}`); }
  else { fail++; console.log(`❌ [반] ${JSON.stringify(input)} → ${got?.id ?? null} (기대 ${expected})`); }
}

for (const [input, expected] of dueDayCases) {
  const got = extractDueDay(input);
  if (got === expected) { pass++; console.log(`✅ [기준일] ${JSON.stringify(input)}`); }
  else {
    fail++;
    console.log(`❌ [기준일] ${JSON.stringify(input)} → ${got} (기대 ${expected})`);
  }
}

for (const [input, expected] of startDateCases) {
  const got = extractStartDate(input, NOW);
  if (got === expected) { pass++; console.log(`✅ [등록일] ${JSON.stringify(input)}`); }
  else {
    fail++;
    console.log(`❌ [등록일] ${JSON.stringify(input)} → ${got} (기대 ${expected})`);
  }
}

for (const [input, expected] of phoneCases) {
  const got = extractPhones(input);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`✅ [전화] ${JSON.stringify(input)}`); }
  else {
    fail++;
    console.log(`❌ [전화] ${JSON.stringify(input)} → ${JSON.stringify(got)} (기대 ${JSON.stringify(expected)})`);
  }
}

for (const [input, expected] of amountCases) {
  const got = extractAmounts(input);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`✅ [금액] ${JSON.stringify(input)}`); }
  else {
    fail++;
    console.log(`❌ [금액] ${JSON.stringify(input)} → ${JSON.stringify(got)} (기대 ${JSON.stringify(expected)})`);
  }
}

for (const c of cases) {
  const result = arbitrate({ ...blank, ...c.ai } as Ai, c.text, NOW);
  let ok = false;
  try {
    ok = c.expect(result as any);
  } catch {
    ok = false;
  }
  if (ok) {
    pass++;
    console.log(`✅ ${c.label}`);
  } else {
    fail++;
    console.log(`❌ ${c.label}`);
    console.log(`   이유: ${c.why}`);
    console.log(`   입력: ${c.text}`);
    console.log(`   결과: ${JSON.stringify(result.draft)}`);
    console.log(`   보정: ${JSON.stringify(result.corrections)}`);
  }
}

console.log(`\n${pass}건 통과 / ${fail}건 실패`);
process.exit(fail === 0 ? 0 : 1);
