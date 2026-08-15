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
  matchClass,
  extractClassAction,
  extractClassTime,
  extractMaxStudents,
  extractPersonAction,
  narrowByHint,
  type ClassHintInput,
} from "../server/lib/nlpNormalize";

const NOW = new Date(2026, 7, 14); // 2026-08-14 고정

type Ai = Parameters<typeof arbitrate>[0];

const blank: Ai = {
  number_readings: [],
  enroll: false,
  payment: false,
  consultation: false,
  student_name: null,
  school: null,
  grade: null,
  parent_phone: null,
  guardian_name: null,
  schedule_days: null,
  teacher_name: null,
  class_level: null,
  amount: null,
  payment_type: null,
  payment_method: null,
  payment_month: null,
  due_day: null,
  start_date: null,
  status: null,
  subject: null,
  follow_up: null,
  memo: null,
  needs_clarification: false,
  question: null,
  class_action: null,
  class_name: null,
  class_time: null,
  max_students: null,
  person_action: null,
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
    ai: { payment: true, student_name: "김민준", amount: 350000, payment_type: "원비", payment_month: "이번달", payment_method: "계좌이체" },
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
    ai: { payment: true, student_name: "박서연", amount: 35, payment_type: "원비", payment_month: "8월" },
    expect: (r) =>
      r.draft.category === "accounting" &&
      r.draft.amount === 350000 &&
      r.corrections.some((c) => c.includes("정정")),
    why: "AI가 35라고 해도 원문 기준 350000으로 코드가 바로잡아야 한다",
  },
  {
    label: "문의 전화는 금액이 있어도 상담",
    text: "010-1234-5678 어머니 30만원 문의",
    ai: { consultation: true, amount: 300000, payment_type: "원비", student_name: "김철수" },
    expect: (r) =>
      r.draft.category === "contact" &&
      r.draft.phone === "010-1234-5678" &&
      r.draft.status === "상담문의",
    why: "'얼마냐'는 문의를 수납으로 저장하면 받지도 않은 돈이 매출에 잡힌다",
  },
  {
    label: "금액도 학생도 없는 원비 문장",
    text: "이번달 원비",
    ai: {},
    expect: (r) => r.draft.category === "unclear" && r.draft.question.includes("금액"),
    why: "누구 것인지도 모르면 채워 넣을 수강료가 없다 — 되물어야 한다",
  },
  {
    label: "금액 없는 원비 — 학생을 알면 금액을 비운 채 초안까지",
    text: "김민준 이번달 원비",
    ai: { student_name: "김민준" },
    expect: (r) =>
      r.draft.category === "accounting" &&
      r.draft.studentName === "김민준" &&
      r.draft.amount === null &&
      r.corrections.some((c) => c.includes("수강료")),
    why: "'김민 수납'처럼 급히 칠 때 반을 고르면 수강료가 채워진다. 금액을 지어내지 않고 비운다",
  },
  {
    label: "환불은 음수",
    text: "이지우 20만원 환불 지난달",
    ai: { payment: true, student_name: "이지우", amount: 200000, payment_type: "환불", payment_month: "지난달" },
    expect: (r) =>
      r.draft.category === "accounting" &&
      r.draft.amount === -200000 &&
      r.draft.paymentMonth === "2026-07",
    why: "Payments 화면이 SUM(amount)를 쓰므로 환불은 음수여야 순액이 맞는다",
  },
  {
    label: "자릿수 오타 방어",
    text: "최유나 3500000000원 원비 이번달",
    ai: { payment: true, student_name: "최유나", amount: 3500000000, payment_type: "원비", payment_month: "이번달" },
    expect: (r) => r.draft.category === "unclear" && r.draft.reason.includes("범위"),
    why: "35억원 수강료는 오타 — 저장하지 말고 되물어야 한다",
  },
  {
    label: "학생 이름 없는 수납",
    text: "35만원 이번달 원비 입금",
    ai: { payment: true, amount: 350000, payment_type: "원비", payment_month: "이번달", student_name: null },
    expect: (r) => r.draft.category === "unclear" && r.draft.question.includes("학생"),
    why: "enrollmentId를 찾을 수 없으므로 저장 불가 — 되물어야 한다",
  },
  {
    label: "지출은 학생 이름 없어도 통과",
    text: "에어컨 수리비 15만원 지출 이번달",
    ai: { payment: true, amount: 150000, payment_type: "지출", payment_month: "이번달", student_name: null },
    expect: (r) => r.draft.category === "accounting" && r.draft.amount === -150000,
    why: "학원 운영 지출은 수강 등록과 무관하다",
  },
  {
    label: "AI가 이름을 지어냄",
    text: "35만원 이번달 원비",
    ai: { payment: true, amount: 350000, payment_type: "원비", payment_month: "이번달", student_name: "홍길동" },
    expect: (r) => r.draft.category === "accounting" && r.draft.studentName === "홍길동",
    why: "여기서는 코드가 막을 수 없다 — 그래서 저장 전 확인 UI가 반드시 필요하다",
  },
  {
    label: "상담 문의 전체 필드",
    text: "010-9876-5432 박지민 어머니 중2 영어 문의, 다음주 화요일 재통화",
    ai: {
      consultation: true,
      parent_phone: "01098765432",
      guardian_name: "박지민 어머니",
      grade: "중2",
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
    ai: {},
    expect: (r) => r.draft.category === "unclear",
    why: "추측해서 저장하느니 되묻는 편이 낫다",
  },
  {
    label: "금액이 두 개",
    text: "김민준 35만원 중 10만원만 입금 이번달 원비",
    ai: { payment: true, student_name: "김민준", amount: 100000, payment_type: "원비", payment_month: "이번달" },
    expect: (r) =>
      r.draft.category === "accounting" && r.corrections.some((c) => c.includes("여러 개")),
    why: "부분 납부는 사람이 확인해야 하므로 경고를 띄운다",
  },
  {
    label: "최종등록 — 기준일·등록일 추출",
    text: "010-9612-4295 홍효서 등록생 기준일 13일, 8월 13일 최초 등록",
    ai: { enroll: true, parent_phone: "010-9612-4295", student_name: "홍효서", status: "최종등록" },
    expect: (r) =>
      r.draft.category === "registration" &&
      r.draft.parentPhone === "010-9612-4295" &&
      r.draft.dueDay === 13 &&
      r.draft.startDate === "2026-08-13" &&
      r.draft.payment === null,
    why: "수강 등록에 넣을 기준일·등록일을 원문에서 뽑아야 한다",
  },
  {
    label: "상담 — 기준일·등록일이 없으면 지어내지 않는다",
    text: "010-1234-5678 박서연 어머니 중2 영어 문의",
    ai: { consultation: true, parent_phone: "010-1234-5678", student_name: "박서연", grade: "중2", subject: "영어" },
    expect: (r) =>
      r.draft.category === "contact" && r.draft.dueDay === null && r.draft.startDate === null,
    why: "값이 없으면 null로 두고 원장이 직접 채우게 해야 한다",
  },
  {
    label: "AI가 '등록'을 상담문의로 흘림",
    text: "010-1234-5678 김민준 중2 영어 등록",
    ai: { consultation: true, parent_phone: "010-1234-5678", student_name: "김민준", grade: "중2", subject: "영어", status: "상담문의" },
    expect: (r) =>
      r.draft.category === "registration" &&
      r.draft.studentName === "김민준" &&
      r.draft.grade === "중2",
    why: "'등록'이라고 썼는데 상담문의로 남으면 학생이 생성되지 않아 학생 목록에 안 뜬다",
  },
  {
    label: "AI가 '결제'를 환불로 뒤집음",
    text: "김민준 35만원 이번달 카드 결제",
    ai: { payment: true, student_name: "김민준", amount: 350000, payment_type: "환불", payment_month: "이번달" },
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
    ai: { payment: true, student_name: "이지우", amount: 200000, payment_type: "원비", payment_month: "지난달" },
    expect: (r) => r.draft.category === "accounting" && r.draft.amount === -200000,
    why: "코드가 결제 쪽으로 과보정해서 환불을 놓치면 안 된다",
  },

  // ─── 등록(registration) ─────────────────────────────────────────────────
  // 예전에는 "전화번호가 있으면 상담, 없으면 되묻기"였다. 그 탓에 원장이 학생을
  // 앞에 두고 급히 적은 등록 문장이 통째로 막혔다.
  {
    label: "등록+결제 동시 (지정 예시)",
    text: "정재현 숭의중1 등록 결제 28만 정우석 선생님 화 목 심화",
    ai: {
      enroll: true,
      payment: true,
      student_name: "정재현",
      school: "숭의중",
      grade: "1학년",
      schedule_days: ["화", "목"],
      teacher_name: "정우석 선생님",
      class_level: "심화",
      amount: 280000,
      payment_type: "원비",
      status: "최종등록",
    },
    expect: (r) =>
      r.draft.category === "registration" &&
      r.draft.studentName === "정재현" &&
      r.draft.school === "숭의중" &&
      r.draft.grade === "1학년" &&
      r.draft.parentPhone === null &&
      r.draft.payment?.amount === 280000 &&
      r.draft.payment?.type === "원비" &&
      r.draft.payment?.paymentMonth === "2026-08" &&
      JSON.stringify(r.draft.classHint.scheduleDays) === JSON.stringify(["화", "목"]) &&
      r.draft.classHint.teacherName === "정우석" &&
      r.draft.classHint.level === "심화",
    why: "'숭의중1'의 1을 금액으로 읽으면 28만원이 버려지고 전체가 되물어진다",
  },
  {
    label: "어순이 달라도 같게 읽는다",
    text: "28만원 결제하고 정재현 신규등록",
    ai: { enroll: true, payment: true, student_name: "정재현", amount: 280000, payment_type: "원비" },
    expect: (r) =>
      r.draft.category === "registration" &&
      r.draft.studentName === "정재현" &&
      r.draft.payment?.amount === 280000,
    why: "'28만원 결제' = '결제 28만원' — 순서가 아니라 뜻으로 읽어야 한다",
  },
  {
    label: "AI가 등록을 놓쳐도 낱말이 살린다",
    text: "정재현 숭의중1 등록 결제 28만",
    ai: { payment: true, student_name: "정재현", school: "숭의중", grade: "1학년", amount: 280000 },
    expect: (r) =>
      r.draft.category === "registration" && r.draft.payment?.amount === 280000,
    why: "'등록'이라고 명시했으면 AI가 놓쳐도 수강등록을 만들어야 한다",
  },
  {
    label: "등록만 — 돈 얘기가 없으면 수납을 만들지 않는다",
    text: "김도윤 다음주부터 다니기로 함",
    ai: { enroll: true, student_name: "김도윤" },
    expect: (r) =>
      r.draft.category === "registration" &&
      r.draft.payment === null &&
      r.draft.parentPhone === null,
    why: "받지도 않은 돈을 수납으로 만들면 미납 집계가 어긋난다",
  },
  {
    label: "연락처 없어도 등록은 등록",
    text: "김민준 초등A반에 넣어줘",
    ai: { enroll: true, student_name: "김민준" },
    expect: (r) =>
      r.draft.category === "registration" &&
      r.draft.parentPhone === null &&
      r.corrections.some((c) => c.includes("전화번호")),
    why: "전화번호는 원장이 확인 화면에서 채운다 — 없다고 등록을 막으면 안 된다",
  },
  {
    label: "환불은 등록으로 흘리지 않는다",
    text: "정재현 등록 취소, 이번달 28만원 환불",
    ai: { enroll: true, payment: true, student_name: "정재현", amount: 280000, payment_type: "환불", payment_month: "이번달" },
    expect: (r) => r.draft.category === "accounting" && r.draft.amount === -280000,
    why: "'등록'이라는 글자에 끌려 환불을 신규 등록으로 만들면 학생이 중복 생성된다",
  },
  // ─── 반 생성·수정 ───
  {
    label: "반 신설",
    text: "중등심화반 신설 정우석 선생님 화목 19:00-21:00 수강료 35만 정원 15명",
    ai: {
      class_action: "생성", class_name: "중등심화반", subject: "영어",
      schedule_days: ["화", "목"], class_time: "19:00-21:00",
      teacher_name: "정우석", amount: 350000, max_students: 15,
    },
    expect: (r) =>
      r.draft.category === "class" &&
      r.draft.action === "create" &&
      r.draft.name === "중등심화반" &&
      r.draft.schedule === "화목 19:00-21:00" &&
      r.draft.defaultTuition === 350000 &&
      r.draft.maxStudents === 15 &&
      r.draft.teacherName === "정우석",
    why: "반 개설 문장은 학생을 만들지 않고 시간표만 만든다",
  },
  {
    label: "반 수정",
    text: "초등A반 수강료 30만으로 변경",
    ai: { class_action: "수정", class_name: "초등A반", amount: 300000 },
    expect: (r) =>
      r.draft.category === "class" &&
      r.draft.action === "update" &&
      r.draft.defaultTuition === 300000,
    why: "수정은 대상 반을 찾을 재료만 담고 나머지는 서버가 대조한다",
  },
  {
    label: "'반 추가'는 학생 등록이지 반 생성이 아니다",
    text: "강단우 국어반 추가 등록",
    ai: { enroll: true, student_name: "강단우", subject: "국어" },
    expect: (r) => r.draft.category !== "class",
    why: "학생을 반에 넣는 말을 반 생성으로 읽으면 엉뚱한 반이 하나 더 생긴다",
  },
  {
    label: "AI가 반 작업이라 해도 원문에 근거가 없으면 무시",
    text: "김민준 35만원 이번달 원비 계좌이체",
    ai: {
      class_action: "생성", class_name: "유령반",
      payment: true, student_name: "김민준", amount: 350000,
      payment_type: "원비", payment_month: "이번달", payment_method: "계좌이체",
    },
    expect: (r) => r.draft.category === "accounting" && r.draft.amount === 350000,
    why: "AI 단독 판단으로 반을 만들면 사람이 시키지 않은 반이 생긴다",
  },
  {
    label: "시간 숫자가 수강료로 새면 안 된다",
    text: "고등반 개설 김하늘 선생님 월수금 19:00-21:00",
    ai: {
      class_action: "생성", class_name: "고등반",
      schedule_days: ["월", "수", "금"], teacher_name: "김하늘", amount: 19,
    },
    expect: (r) => r.draft.category === "class" && r.draft.defaultTuition === null,
    why: "19:00에서 뽑힌 19가 수강료 19원으로 저장되면 미납 계산이 망가진다",
  },
  {
    label: "학생 수정",
    text: "학생 수정 김민준 학교 숭의중으로 바꿔줘",
    ai: { person_action: "학생수정", student_name: "김민준", school: "숭의중" },
    expect: (r) =>
      r.draft.category === "person" &&
      r.draft.target === "student" &&
      r.draft.action === "update" &&
      r.draft.name === "김민준" &&
      r.draft.school === "숭의중",
    why: "명시적 수정 명령이 등록이나 상담으로 새면 엉뚱한 레코드가 하나 더 생긴다",
  },
  {
    label: "학생 수정 — 말 안 한 항목은 null로 남는다",
    text: "학생 수정 김민준 학교 숭의중으로 바꿔줘",
    ai: { person_action: "학생수정", student_name: "김민준", school: "숭의중" },
    expect: (r) =>
      r.draft.category === "person" && r.draft.grade === null && r.draft.phone === null,
    why: "빈 값을 그대로 저장하면 기존 학년·연락처가 지워진다",
  },
  {
    label: "교사 추가",
    text: "교사 추가 박지훈 수학 010-1111-2222",
    ai: { person_action: "교사추가", teacher_name: "박지훈", subject: "수학", parent_phone: "010-1111-2222" },
    expect: (r) =>
      r.draft.category === "person" &&
      r.draft.target === "teacher" &&
      r.draft.action === "create" &&
      r.draft.name === "박지훈" &&
      r.draft.subject === "수학" &&
      r.draft.phone === "010-1111-2222",
    why: "전화번호가 섞여 있어도 상담 문의로 가로채이면 안 된다",
  },
  {
    label: "교사 수정 — AI가 과목을 놓쳐도 원문에서 살린다",
    text: "교사 수정 김하늘 영어 담당으로 변경",
    ai: { person_action: "교사수정", teacher_name: "김하늘" },
    expect: (r) =>
      r.draft.category === "person" &&
      r.draft.target === "teacher" &&
      r.draft.action === "update" &&
      r.draft.subject === "영어",
    why: "과목이 비면 수정 화면에서 다시 타이핑해야 한다",
  },
  {
    label: "AI가 빈손이어도 반 신설은 통과한다",
    text: "중등심화반 신설 화목 19:00-21:00 김하늘 선생님 수학 35만원",
    ai: {}, // 모델이 class_action을 통째로 빠뜨린 상황
    expect: (r) =>
      r.draft.category === "class" &&
      r.draft.action === "create" &&
      r.draft.name === "중등심화반" &&
      r.draft.teacherName === "김하늘" &&
      r.draft.subject === "수학" &&
      r.draft.defaultTuition === 350000,
    why: "원장이 직접 친 지시가 그날 모델 컨디션에 좌우되면 안 된다",
  },
  {
    label: "AI가 빈손이어도 반 수정은 통과한다",
    text: "초등A반 수강료 30만으로 변경",
    ai: {},
    expect: (r) =>
      r.draft.category === "class" && r.draft.action === "update" && r.draft.name === "초등A반",
    why: "반 관리가 AI 응답 없이도 동작해야 한다",
  },
  {
    label: "'고은채 선생님 반 추가'는 그 선생님 반을 새로 만드는 말이다",
    text: "고은채 선생님 반 추가",
    ai: {},
    expect: (r) =>
      r.draft.category === "class" &&
      r.draft.action === "create" &&
      r.draft.teacherName === "고은채",
    why: "교사 이름을 앞세운 반 만들기는 원장이 가장 자주 쓰는 말이다",
  },
  {
    label: "'고은채 선생님 반 관리'는 반 수정으로 들어간다",
    text: "고은채 선생님 반 관리",
    ai: {},
    expect: (r) =>
      r.draft.category === "class" &&
      r.draft.action === "update" &&
      r.draft.teacherName === "고은채",
    why: "관리·설정도 결국 기존 반을 고치는 화면이어야 한다",
  },
  {
    label: "문의를 옮긴 문장은 반을 바꾸지 않는다",
    text: "수강료 변경 문의 왔어요",
    ai: {},
    expect: (r) => r.draft.category !== "class",
    why: "문의 전화 한 통에 실제 반 수강료가 바뀌면 매출이 어긋난다",
  },
  {
    label: "AI가 이름을 비워도 명령어 뒤 낱말로 채운다",
    text: "학생 수정 김민준 학교 숭의중으로",
    ai: { person_action: "학생수정" }, // 이름 칸이 빈 응답
    expect: (r) => r.draft.category === "person" && r.draft.name === "김민준",
    why: "이름이 비면 대상을 못 골라 저장 버튼이 끝까지 막힌다",
  },
  {
    label: "AI가 빈손이어도 교사 추가는 이름·과목이 찬다",
    text: "교사 추가 박지훈 수학 010-1111-2222",
    ai: {},
    expect: (r) =>
      r.draft.category === "person" &&
      r.draft.target === "teacher" &&
      r.draft.action === "create" &&
      r.draft.name === "박지훈" &&
      r.draft.subject === "수학" &&
      r.draft.phone === "010-1111-2222",
    why: "빈 폼이 뜨면 결국 손으로 다시 치게 되어 AI 입력의 의미가 없다",
  },
  {
    label: "'학생 추가'는 수정 분기로 가지 않는다",
    text: "강단우 3학년 국어반 등록 010-1234-5678",
    ai: { enroll: true, student_name: "강단우", grade: "3학년", class_level: "국어반", parent_phone: "010-1234-5678" },
    expect: (r) => r.draft.category === "registration",
    why: "신규 학생은 반 배정·납부일까지 정하는 등록 흐름을 거쳐야 한다",
  },
  {
    label: "이름만 치면 학생 조회",
    text: "정재현",
    ai: { consultation: true },
    expect: (r) => r.draft.category === "lookup" && r.draft.name === "정재현",
    why: "AI가 상담으로 넘겨도 이름 한 낱말은 '쟤 지금 어떤 상태지?'라는 질문이다",
  },
  {
    label: "이름 뒤 조사는 떼고 조회",
    text: "재현이",
    ai: {},
    expect: (r) => r.draft.category === "lookup" && r.draft.name === "재현",
    why: "부분 일치로 찾으므로 '재현'이면 정재현까지 걸린다",
  },
  {
    label: "흔한 낱말은 조회로 보지 않는다",
    text: "오늘",
    ai: {},
    expect: (r) => r.draft.category === "unclear",
    why: "'오늘'을 학생 이름으로 검색하면 아무것도 안 나오고 되묻지도 못한다",
  },
  {
    label: "금액 없는 '납입'도 수납으로 읽는다",
    text: "수찬이 7월 납입",
    ai: {},
    expect: (r) =>
      r.draft.category === "accounting" &&
      r.draft.studentName === "수찬" &&
      r.draft.amount === null &&
      r.draft.paymentMonth === "2026-07",
    why: "AI가 이름 칸을 비워도 문장 맨 앞 낱말로 채운다. 금액은 화면에서 고른다",
  },
  {
    label: "금액 없는 '결제'도 수납으로 읽는다",
    text: "수찬이 7월 결제",
    ai: {},
    expect: (r) => r.draft.category === "accounting" && r.draft.studentName === "수찬",
    why: "납부·결제·납입은 원장이 섞어 쓰는 같은 말이다",
  },
  {
    label: "번호 없는 신규상담도 폼까지는 연다",
    text: "신규상담 중학교1학년 김찬우",
    ai: { consultation: true, student_name: "김찬우", grade: "중1" },
    expect: (r) =>
      r.draft.category === "contact" &&
      r.draft.phone === null &&
      r.draft.status === "상담문의",
    why: "통화 중에 번호는 나중에 친다. 저장은 화면에서 번호가 찰 때까지 막힌다",
  },
  {
    label: "번호 없는 대기 등록도 폼까지는 연다",
    text: "박서연 중2 대기",
    ai: { consultation: true, student_name: "박서연", grade: "중2" },
    expect: (r) => r.draft.category === "contact" && r.draft.status === "대기등록",
    why: "대기도 상담과 같은 흐름이다",
  },
  {
    label: "퇴근전 할 일은 오늘 날짜로 잡힌다",
    text: "퇴근전 김민준 어머니 전화드리기",
    ai: { consultation: true, student_name: "김민준" },
    expect: (r) =>
      r.draft.category === "task" &&
      r.draft.dueDate === "2026-08-14" &&
      r.draft.slot === "퇴근전" &&
      r.draft.title === "김민준 어머니 전화드리기",
    why: "당일 기능이라 날짜를 물어보지 않는다. AI가 상담으로 봐도 '퇴근전'이 이긴다",
  },
  {
    label: "출근전 할 일은 다음날로 넘어간다",
    text: "내일 출근전 교재 주문",
    ai: {},
    expect: (r) =>
      r.draft.category === "task" && r.draft.dueDate === "2026-08-15" && r.draft.slot === "출근전",
    why: "출근 전에 할 일은 지금 적어도 내일 아침 몫이다",
  },
  {
    label: "할 일 문장 속 '미납'은 수납으로 새지 않는다",
    text: "퇴근전 미납자 문자 돌리기",
    ai: { payment: true },
    expect: (r) => r.draft.category === "task" && r.draft.title === "미납자 문자 돌리기",
    why: "할 일 문장에는 원비·전화 같은 낱말이 섞인다. 표지가 있으면 할 일이 먼저다",
  },
  {
    label: "'퇴근전'만 치면 무엇을 할지 되묻는다",
    text: "퇴근전",
    ai: {},
    expect: (r) => r.draft.category === "unclear" && r.draft.question.includes("무엇"),
    why: "제목 없는 할 일은 목록에서 아무 뜻이 없다",
  },
  {
    label: "표지 없는 문장은 할 일이 아니다",
    text: "김민준 어머니께 전화 010-1234-5678",
    ai: { consultation: true, student_name: "김민준", parent_phone: "010-1234-5678" },
    expect: (r) => r.draft.category !== "task",
    why: "'전화'만으로 할 일이 되면 상담 기록이 전부 투두로 빨려 들어간다",
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
  // ── 단위 오인식 방어 ──
  // "월"은 날짜다. 7이 금액 후보 첫 자리를 차지하면 28만원이 통째로 버려진다.
  ["김민준 7월 원비 28만원 결제", [280000]],
  // 학교명에 붙은 학년 숫자를 금액으로 읽으면 안 된다
  ["정재현 숭의중1 등록 결제 28만", [280000]],
  ["박서연 중2 영어 35만원", [350000]],
  // 기준일·등록일도 금액이 아니다
  ["기준일 13일 35만원 납부", [350000]],
  ["8월 13일부터 28만원", [280000]],
  ["3개월 선납 90만원", [900000]],
  // 전화번호 자릿수가 금액으로 새면 안 된다
  ["010-1234-5678 김민준 28만원 입금", [280000]],
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

// 반 자체를 건드리는 말인지 판정. "반 추가"처럼 학생 등록과 겹치는 표현이 가장 위험하다.
const classActionCases: Array<[string, string | null]> = [
  ["중등심화반 신설", "create"],
  ["국어반 하나 더 개설", "create"],
  ["새로운 반 만들어줘", "create"],
  ["초등A반 수강료 30만으로 변경", "update"],
  ["심화반 시간표 바꿔줘", "update"],
  ["고등반 폐강", "update"],
  ["수강료 35만으로 올려줘", "update"],
  // 원장이 실제로 가장 많이 치는 말
  ["고은채 선생님 반 추가", "create"],
  ["고은채 선생님 반 수정", "update"],
  ["고은채 선생님 반 관리", "update"],
  ["반 추가", "create"],
  ["반 설정", "update"],
  // 학생을 반에 넣는 말은 반 작업이 아니다
  ["강단우 국어반 추가", null],
  ["김민준 초등A반 등록", null],
  ["김민준 35만원 이번달 원비", null],
];

const classTimeCases: Array<[string, string | null]> = [
  ["화목 19:00-21:00", "19:00-21:00"],
  // 오전·오후를 짐작하지 않는다. 19시를 7시로 저장하는 것보다 그대로 두고 사람이 고치는 편이 낫다.
  ["7시~9시 수업", "07:00-09:00"],
  ["오늘 상담함", null],
];

const maxStudentsCases: Array<[string, number | null]> = [
  ["정원 20명", 20],
  ["최대 15명", 15],
  ["35만원 납부", null],
];

// 사람 정보를 고치라는 명시적 명령. 학생 "추가"는 일부러 빠져 있다 —
// 신규 학생은 반 배정·납부일까지 정하는 등록 흐름을 거쳐야 하기 때문.
const personActionCases: Array<[string, string | null]> = [
  ["학생 수정 김민준 학교 숭의중으로", "student/update"],
  ["학생정보 변경 박서연 학년 2학년", "student/update"],
  ["교사 추가 박지훈 수학", "teacher/create"],
  ["강사 등록 김하늘 영어", "teacher/create"],
  ["교사 수정 김하늘 연락처 바꿔줘", "teacher/update"],
  ["선생님 정보 변경", "teacher/update"],
  ["쌤 수정 정우석", "teacher/update"],
  // 등록·수납 문장을 수정 명령으로 오해하면 안 된다
  ["강단우 3학년 국어반 등록", null],
  ["김민준 35만원 이번달 원비", null],
  ["중등심화반 신설", null],
];

// 동명이인을 힌트로 좁히는 규칙. 잘못 좁히는 것이 안 좁히는 것보다 위험하므로
// 걸리는 힌트가 하나도 없으면 후보를 전부 남긴다.
const hintRows = [
  { id: "s1", hints: ["3학년", "숭의중", "초등A반"] },
  { id: "s2", hints: ["1학년", "인천중", "중등심화"] },
  { id: "s3", hints: [null, null, "초등A반"] },
];
const narrowCases: Array<[string, string, string[]]> = [
  ["학교로 좁힌다", "김민 숭의중 수납", ["s1"]],
  ["반 이름으로 좁힌다", "김민 중등심화 수납", ["s2"]],
  ["힌트가 하나도 없으면 전부 남긴다", "김민 수납", ["s1", "s2", "s3"]],
  ["여러 명이 같은 힌트를 가지면 둘 다 남긴다", "김민 초등A반 수납", ["s1", "s3"]],
  ["힌트가 어긋나도 지어내지 않는다", "김민 없는학교 수납", ["s1", "s2", "s3"]],
];

// 요일·강사·레벨로 반을 좁히는 경우. 반 이름은 학원마다 제각각이라
// "화목 심화"만으로는 이름을 알 수 없고, 반 목록과 대조해야만 확정된다.
const classRows = [
  { id: "k1", name: "심화반", schedule: "화목", teacherName: "정우석" },
  { id: "k2", name: "기초반", schedule: "화목", teacherName: "정우석" },
  { id: "k3", name: "고등심화", schedule: "월수금", teacherName: "김하늘" },
];
const hintCases: Array<[string, ClassHintInput, string | null, number]> = [
  ["요일+강사+레벨 모두 일치", { scheduleDays: ["화", "목"], teacherName: "정우석", level: "심화" }, "k1", 1],
  // "화요일"의 "일"이 일요일로 잡히면 후보가 0이 된다
  ["'화요일' 표기도 같게 읽는다", { scheduleDays: ["화요일", "목요일"], teacherName: "정우석", level: "심화" }, "k1", 1],
  ["레벨이 없으면 확정 못 함", { scheduleDays: ["화", "목"], teacherName: "정우석", level: null }, null, 2],
  ["레벨만으론 확정 못 함", { scheduleDays: null, teacherName: null, level: "심화" }, null, 2],
  // "화목"과 "화목토"는 다른 반이다 — 비슷하다고 붙이면 엉뚱한 반에 등록된다
  ["요일이 하나라도 다르면 후보 아님", { scheduleDays: ["화", "목", "토"], teacherName: "정우석", level: "심화" }, null, 0],
  ["강사만으로 확정", { scheduleDays: null, teacherName: "김하늘", level: null }, "k3", 1],
  ["재료가 없으면 추측하지 않는다", { scheduleDays: null, teacherName: null, level: null }, null, 0],
];

for (const [label, hint, expectedId, expectedCount] of hintCases) {
  const got = matchClass(hint, classRows);
  const ok = (got.match?.id ?? null) === expectedId && got.candidates.length === expectedCount;
  if (ok) { pass++; console.log(`✅ [반매칭] ${label}`); }
  else {
    fail++;
    console.log(`❌ [반매칭] ${label} → match=${got.match?.id ?? null}, 후보 ${got.candidates.length}건 (기대 ${expectedId}, ${expectedCount}건)`);
  }
}

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

for (const [input, expected] of classActionCases) {
  const got = extractClassAction(input);
  if (got === expected) { pass++; console.log(`✅ [반작업] ${JSON.stringify(input)}`); }
  else { fail++; console.log(`❌ [반작업] ${JSON.stringify(input)} → ${got} (기대 ${expected})`); }
}

for (const [input, expected] of classTimeCases) {
  const got = extractClassTime(input);
  if (got === expected) { pass++; console.log(`✅ [수업시간] ${JSON.stringify(input)}`); }
  else { fail++; console.log(`❌ [수업시간] ${JSON.stringify(input)} → ${got} (기대 ${expected})`); }
}

for (const [input, expected] of maxStudentsCases) {
  const got = extractMaxStudents(input);
  if (got === expected) { pass++; console.log(`✅ [정원] ${JSON.stringify(input)}`); }
  else { fail++; console.log(`❌ [정원] ${JSON.stringify(input)} → ${got} (기대 ${expected})`); }
}

for (const [input, expected] of personActionCases) {
  const r = extractPersonAction(input);
  const got = r ? `${r.target}/${r.action}` : null;
  if (got === expected) { pass++; console.log(`✅ [사람작업] ${JSON.stringify(input)}`); }
  else { fail++; console.log(`❌ [사람작업] ${JSON.stringify(input)} → ${got} (기대 ${expected})`); }
}

for (const [label, text, expectedIds] of narrowCases) {
  const got = narrowByHint(hintRows, text).map((r) => r.id);
  if (JSON.stringify(got) === JSON.stringify(expectedIds)) {
    pass++; console.log(`✅ [동명이인] ${label}`);
  } else {
    fail++;
    console.log(`❌ [동명이인] ${label} → ${JSON.stringify(got)} (기대 ${JSON.stringify(expectedIds)})`);
  }
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
