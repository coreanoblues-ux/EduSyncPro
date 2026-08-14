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
import { extractPhones, extractAmounts } from "../server/lib/nlpNormalize";

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
