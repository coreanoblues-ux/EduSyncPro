/**
 * 자연어 한 줄 입력 → 구조화된 초안(draft) 변환
 *
 * 설계 원칙
 *  1. OpenAI 결과는 "초안"일 뿐이다. 저장은 원장이 확인 버튼을 누른 뒤에만 일어난다.
 *  2. 틀리면 회계가 망가지는 값(전화번호·금액·유형)은 nlpNormalize.ts의 순수 함수가
 *     원문에서 직접 다시 뽑아 AI 결과를 덮어쓴다. AI가 규칙을 어겨도 코드가 막는다.
 *  3. 다만 "무슨 일이 있었는가"(등록/결제/상담)의 판단은 AI가 문맥으로 하고,
 *     코드는 낱말이 명백할 때만 개입한다. 예전에는 전화번호 유무만으로 분류를
 *     강제했는데, 그 탓에 "정재현 숭의중1 등록 결제 28만"처럼 연락처 없는
 *     등록+결제 문장이 통째로 되물어졌다.
 *  4. 확신이 없으면 추측하지 않고 category="unclear"로 되돌려 원장에게 되묻는다.
 *
 * 의존성 없음 — Node 18+ 내장 fetch를 사용한다. (openai SDK 설치 불필요)
 */

import {
  extractPhones,
  extractAmounts,
  normalizePhone,
  normalizeMonth,
  cleanStudentName,
  isPlausibleAmount,
  AMOUNT_MIN,
  AMOUNT_MAX,
  extractDueDay,
  extractStartDate,
  extractConsultationStatus,
  extractPaymentType,
  extractPaymentMethod,
} from "./nlpNormalize";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

export type PaymentType = "원비" | "환불" | "지출" | "기타";
export type PaymentMethod = "계좌이체" | "카드" | "현금";
export type ConsultationStatus = "상담문의" | "대기등록" | "최종등록" | "보류";

/** 등록과 동시에 받은 돈. 수강등록이 만들어진 뒤 그 enrollmentId에 붙는다. */
export interface PaymentPart {
  amount: number;
  type: PaymentType;
  method: PaymentMethod | null;
  paymentMonth: string; // YYYY-MM
}

/** 문장에 적힌 반 식별 재료. 실제 반은 서버가 학원 반 목록과 대조해 확정한다. */
export interface ClassHint {
  scheduleDays: string[] | null; // ["화","목"]
  teacherName: string | null; // "정우석"
  level: string | null; // "심화"
}

export interface AccountingDraft {
  category: "accounting";
  studentName: string | null;
  amount: number; // 원비=양수, 환불·지출=음수
  type: PaymentType;
  paymentMonth: string; // YYYY-MM
  method: PaymentMethod | null;
  memo: string | null;
}

/**
 * 학생이 새로 수업을 시작하는 사건. 저장 시 학생 → 수강등록 → (있으면) 수납 순으로 만든다.
 * payments.enrollmentId가 필수라 순서를 뒤집을 수 없다.
 */
export interface RegistrationDraft {
  category: "registration";
  studentName: string | null;
  school: string | null;
  grade: string | null;
  /** 없으면 null. 원장이 확인 화면에서 채운다 — 없다고 등록을 막지 않는다. */
  parentPhone: string | null;
  guardianName: string | null;
  classHint: ClassHint;
  startDate: string | null; // YYYY-MM-DD
  dueDay: number | null;
  /** 등록과 동시에 결제까지 있었으면 채워진다. 등록만이면 null. */
  payment: PaymentPart | null;
  subject: string | null;
  memo: string | null;
}

export interface ContactDraft {
  category: "contact";
  phone: string;
  guardianName: string | null;
  studentName: string | null;
  studentGrade: string | null;
  status: ConsultationStatus;
  subject: string | null;
  followUp: string | null;
  memo: string | null;
  /** 최종등록으로 저장할 때 수강 등록에 넣을 값. 문장에 없으면 null이고 원장이 직접 채운다. */
  dueDay: number | null;
  startDate: string | null; // YYYY-MM-DD
}

export interface UnclearDraft {
  category: "unclear";
  reason: string;
  /** 원장에게 되물을 구체적인 질문 */
  question: string;
}

export type Draft = AccountingDraft | RegistrationDraft | ContactDraft | UnclearDraft;

export type ParseResult = {
  draft: Draft;
  sourceText: string;
  /** 코드 검증 단계에서 AI 결과를 고친 내역 — UI에 "이렇게 해석했습니다"로 보여준다 */
  corrections: string[];
};

// ─── OpenAI 호출 ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 EduSyncPro의 자연어 입력 분석기입니다.

## 당신이 일하는 시스템
한국 영어학원 원장이 쓰는 학원 관리 시스템입니다. 원장은 상담 전화를 받거나
학생을 등록시키거나 학원비를 받은 직후, 그 사실을 한 줄 메모처럼 적습니다.
당신의 일은 그 한 줄을 읽고, 시스템의 어느 표에 무엇을 넣어야 하는지 판단해
구조화된 초안을 만드는 것입니다.

저장은 당신이 하지 않습니다. 원장이 화면에서 확인하고 수정한 뒤 버튼을 눌러야
저장됩니다. 그러니 확신이 없으면 비워 두십시오(null). 빈칸은 원장이 1초 만에
채우지만, 그럴듯하게 지어낸 값은 그대로 저장되어 회계를 망칩니다.

## 데이터 모델
students(학생)      : name, school, grade, parentPhone, notes
classes(반)         : name, subject, schedule(예 "화목"), defaultTuition, teacherId
teachers(강사)      : name, subject
enrollments(수강등록): studentId, classId, tuition, dueDay(기본 8), startDate
payments(수납)      : enrollmentId, amount, type, method, paymentMonth
consultations(상담) : phone, guardianName, studentName, studentGrade, status
waiters(대기자)     : classId, name, phone

연결 구조가 중요합니다:
  학생 ─ 수강등록 ─ 반 ─ 강사
            └ 수납

수납은 학생에 직접 붙지 않고 반드시 "수강등록"을 통해 붙습니다. 따라서 어떤
학생이 처음 등록하면서 동시에 돈을 냈다면, 그것은 "학생 생성 → 수강등록 생성
→ 그 등록에 대한 수납" 세 가지가 한꺼번에 일어난 사건입니다. 이 경우
enroll과 payment를 둘 다 true로 표시하십시오.

## 작업 방식 — 규칙을 찾기 전에 문장을 이해하십시오

이 문장은 원장이 방금 겪은 일을 적은 것입니다. 패턴 매칭을 하지 마십시오.
사람이 메모를 읽듯이 다음 순서로 생각하십시오.

1단계. 무슨 일이 있었는가?
   새 학생이 들어왔는가, 돈이 오갔는가, 전화 문의만 왔는가, 아니면 여러 개가
   동시에 일어났는가? 먼저 사건 전체를 파악하십시오.

2단계. 문장에 등장하는 각 숫자는 무엇인가?
   숫자 하나하나에 대해 "이게 무엇의 숫자인지" 스스로 답한 뒤 배치하십시오.
   한국어에서 숫자 뒤에 붙는 글자가 그 숫자의 정체를 알려줍니다.
     · 뒤에 "월"이 오면 → 날짜(몇 월분)이거나 기간(몇 개월)입니다. 금액이 아닙니다.
       "7월"은 7원이 될 수 없습니다.
     · 뒤에 "원"·"만"·"만원"이 오면 → 금액입니다.
     · 뒤에 "일"이 오면 → 날짜 또는 납부 기준일입니다.
     · 뒤에 "학년"이 오거나 학교 이름 바로 뒤에 붙으면 → 학년입니다.
       "숭의중1"의 1은 1학년이며, 금액도 날짜도 아닙니다.
     · "010"으로 시작하는 긴 숫자 → 전화번호입니다.
   판단한 내용을 number_readings에 그대로 적으십시오. 이 항목은 당신의 추론
   과정을 검증하는 데 쓰이므로, 문장의 모든 숫자를 빠짐없이 넣어야 합니다.

3단계. 각 정보를 알맞은 자리에 넣으십시오.

## 어순에 얽매이지 마십시오
같은 뜻이면 순서가 달라도 같게 읽어야 합니다.
  "28만원 결제" = "결제 28만원" = "28만원 냈어요" = "28만원 입금 확인"
  "정재현 등록" = "등록한 학생 정재현" = "정재현이 다니기로 함"
조사가 붙거나("정재현이"), 생략되거나("정재현 숭의중1"), 구어체여도
("28만원 받았어요") 동일하게 처리하십시오.

## 사건 판정
아래 낱말은 예시일 뿐입니다. 나열되지 않았더라도 문맥상 같은 뜻이면 같게
처리하십시오.

enroll = true  (학생이 새로 수업을 시작함 → 학생·수강등록 생성 대상)
  예: 등록, 신규등록, 다니기로 함, 수업 시작, 들어옴, 반에 넣어줌, 입반

payment = true (돈을 받음 → 수납 생성 대상)
  예: 결제, 납부, 수납, 입금했어요, 카드로 냄, 계좌로 보냄, 완납

consultation = true (문의·상담 기록 대상)
  예: 문의, 상담, 알아봄, 전화 옴, 물어봄

동시 발생을 반드시 허용하십시오.
  · 등록 + 결제가 함께 있으면 → enroll=true, payment=true (둘 다입니다)
  · 문의·상담만 있고 등록도 결제도 없으면 → consultation=true만
  · 대기 의사면 → status="대기등록"
  · 보류·취소면 → status="보류"

## 금액 규칙
"만"·"만원"은 10000을 곱합니다. 28만 → 280000, 35만원 → 350000.
amount는 항상 양수로 적으십시오. 환불·지출 여부는 payment_type으로만 표현합니다.
"결제"·"납부"를 환불로 뒤집지 마십시오. 환불은 "환불"이라고 명시된 경우뿐입니다.

## 반 식별
반은 "요일 + 담당 강사 + 레벨"의 조합으로 지목됩니다. 각각을 따로 뽑으십시오.
  "정우석 선생님 화 목 심화" → schedule_days=["화","목"], teacher_name="정우석",
                                class_level="심화"
"선생님"·"쌤"·"T" 같은 호칭은 이름에서 떼어내십시오.
셋 중 일부만 있어도 있는 것만 채우고 나머지는 null로 두십시오.
실제 반 이름은 서버가 학원의 반 목록과 대조해 확정하므로, 당신은 지어내지 말고
문장에 적힌 재료만 넘기십시오.

## 전화번호가 없을 때
전화번호가 없는 것은 오류가 아닙니다. 원장이 학생 앞에서 급히 적었을 뿐입니다.
parent_phone=null로 두십시오. 원장이 확인 화면에서 직접 채웁니다.
전화번호가 없다는 이유로 등록을 문의로 낮추거나 판단을 포기하지 마십시오.

## 확신이 없을 때
문장이 너무 짧거나 무슨 말인지 알 수 없으면 needs_clarification=true로 두고
question에 원장에게 되물을 구체적인 질문을 적으십시오.
일부만 모르는 것이라면 그 필드만 null로 두고 나머지는 정상적으로 채우십시오.

## 예시

입력: 정재현 숭의중1 등록 결제 28만 정우석 선생님 화 목 심화
{
  "number_readings": [
    {"token": "1", "context": "숭의중1", "meaning": "학년"},
    {"token": "28만", "context": "결제 28만", "meaning": "금액"}
  ],
  "enroll": true, "payment": true, "consultation": false,
  "student_name": "정재현", "school": "숭의중", "grade": "1학년",
  "parent_phone": null, "guardian_name": null,
  "schedule_days": ["화","목"], "teacher_name": "정우석", "class_level": "심화",
  "amount": 280000, "payment_type": "원비", "payment_method": null,
  "payment_month": null, "due_day": null, "start_date": null,
  "status": "최종등록", "subject": null, "follow_up": null, "memo": null,
  "needs_clarification": false, "question": null
}
(전화번호가 없어도 등록으로 처리했고, "숭의중1"의 1을 금액이 아니라 학년으로
 읽었으며, 등록과 결제를 동시에 표시했습니다.)

입력: 어제 28만원 입금했다고 연락옴 민서 어머니 010-2345-6789
{
  "number_readings": [
    {"token": "28만원", "context": "28만원 입금", "meaning": "금액"},
    {"token": "010-2345-6789", "context": "전화번호", "meaning": "전화번호"}
  ],
  "enroll": false, "payment": true, "consultation": false,
  "student_name": "민서", "school": null, "grade": null,
  "parent_phone": "010-2345-6789", "guardian_name": "민서 어머니",
  "schedule_days": null, "teacher_name": null, "class_level": null,
  "amount": 280000, "payment_type": "원비", "payment_method": "계좌이체",
  "payment_month": null, "due_day": null, "start_date": null,
  "status": null, "subject": null, "follow_up": null, "memo": null,
  "needs_clarification": false, "question": null
}
("결제"라는 낱말이 없지만 "입금했다"가 같은 뜻이고, 어순이 금액부터
 시작하지만 동일하게 읽었으며, "입금"에서 계좌이체를 추론했습니다.)

입력: 화목 심화반 김도윤 3월부터 다니기로 함 학원비는 35만
{
  "number_readings": [
    {"token": "3월", "context": "3월부터", "meaning": "날짜"},
    {"token": "35만", "context": "학원비는 35만", "meaning": "금액"}
  ],
  "enroll": true, "payment": false, "consultation": false,
  "student_name": "김도윤", "school": null, "grade": null,
  "parent_phone": null, "guardian_name": null,
  "schedule_days": ["화","목"], "teacher_name": null, "class_level": "심화",
  "amount": 350000, "payment_type": null, "payment_method": null,
  "payment_month": null, "due_day": null, "start_date": "3월",
  "status": "최종등록", "subject": null, "follow_up": null, "memo": null,
  "needs_clarification": false, "question": null
}
("3월"을 3원이 아닌 날짜로 읽었고, "다니기로 함"을 등록으로 이해했으며,
 금액이 있지만 아직 냈다는 말이 없으므로 payment=false로 두었습니다.
 반 정보가 문장 맨 앞에 와도 동일하게 인식했습니다.)

입력: 010-1111-2222 박서연 어머니 중2 영어 문의, 다음주 재통화
{
  "number_readings": [
    {"token": "010-1111-2222", "context": "전화번호", "meaning": "전화번호"},
    {"token": "2", "context": "중2", "meaning": "학년"}
  ],
  "enroll": false, "payment": false, "consultation": true,
  "student_name": "박서연", "school": null, "grade": "중2",
  "parent_phone": "010-1111-2222", "guardian_name": "박서연 어머니",
  "schedule_days": null, "teacher_name": null, "class_level": null,
  "amount": null, "payment_type": null, "payment_method": null,
  "payment_month": null, "due_day": null, "start_date": null,
  "status": "상담문의", "subject": "영어", "follow_up": "다음주 재통화",
  "needs_clarification": false, "question": null
}
(등록·결제 낱말이 없으므로 상담문의로만 처리했고, "중2"의 2를 학년으로 읽었습니다.)`;

/** OpenAI Structured Outputs 스키마. strict 모드라 모든 필드가 required여야 한다. */
const JSON_SCHEMA = {
  name: "hagwon_input",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "number_readings",
      "enroll",
      "payment",
      "consultation",
      "student_name",
      "school",
      "grade",
      "parent_phone",
      "guardian_name",
      "schedule_days",
      "teacher_name",
      "class_level",
      "amount",
      "payment_type",
      "payment_method",
      "payment_month",
      "due_day",
      "start_date",
      "status",
      "subject",
      "follow_up",
      "memo",
      "needs_clarification",
      "question",
    ],
    properties: {
      // 숫자별 판정 근거. 코드가 금액 후보를 걸러낼 때 교차검증에 쓴다.
      number_readings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["token", "context", "meaning"],
          properties: {
            token: { type: "string" },
            context: { type: "string" },
            meaning: {
              type: "string",
              enum: ["금액", "날짜", "학년", "전화번호", "기준일", "기간", "기타"],
            },
          },
        },
      },
      enroll: { type: "boolean" },
      payment: { type: "boolean" },
      consultation: { type: "boolean" },
      student_name: { type: ["string", "null"] },
      school: { type: ["string", "null"] },
      grade: { type: ["string", "null"] },
      parent_phone: { type: ["string", "null"] },
      guardian_name: { type: ["string", "null"] },
      schedule_days: { type: ["array", "null"], items: { type: "string" } },
      teacher_name: { type: ["string", "null"] },
      class_level: { type: ["string", "null"] },
      amount: { type: ["number", "null"] },
      payment_type: { type: ["string", "null"], enum: ["원비", "환불", "지출", "기타", null] },
      payment_method: { type: ["string", "null"], enum: ["계좌이체", "카드", "현금", null] },
      payment_month: { type: ["string", "null"] },
      due_day: { type: ["number", "null"] },
      start_date: { type: ["string", "null"] },
      status: {
        type: ["string", "null"],
        enum: ["상담문의", "대기등록", "최종등록", "보류", null],
      },
      subject: { type: ["string", "null"] },
      follow_up: { type: ["string", "null"] },
      memo: { type: ["string", "null"] },
      needs_clarification: { type: "boolean" },
      question: { type: ["string", "null"] },
    },
  },
} as const;

export interface NumberReading {
  token: string;
  context: string;
  meaning: "금액" | "날짜" | "학년" | "전화번호" | "기준일" | "기간" | "기타";
}

export interface RawAiResult {
  number_readings: NumberReading[];
  enroll: boolean;
  payment: boolean;
  consultation: boolean;
  student_name: string | null;
  school: string | null;
  grade: string | null;
  parent_phone: string | null;
  guardian_name: string | null;
  schedule_days: string[] | null;
  teacher_name: string | null;
  class_level: string | null;
  amount: number | null;
  payment_type: string | null;
  payment_method: string | null;
  payment_month: string | null;
  due_day: number | null;
  start_date: string | null;
  status: string | null;
  subject: string | null;
  follow_up: string | null;
  memo: string | null;
  needs_clarification: boolean;
  question: string | null;
}

export class NlpConfigError extends Error {}

async function callOpenAi(text: string, signal?: AbortSignal): Promise<RawAiResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new NlpConfigError(
      "OPENAI_API_KEY가 설정되지 않았습니다. Railway 대시보드 → Variables에서 등록해주세요."
    );
  }

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: MODEL,
      temperature: 0, // 같은 문장은 항상 같은 결과가 나오도록 고정
      max_tokens: 800, // number_readings가 늘어난 만큼 여유를 준다
      response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // API 키 자체는 절대 로그에 남기지 않는다
    throw new Error(`OpenAI 호출 실패 (${res.status}): ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as any;
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI 응답이 비어 있습니다.");
  return JSON.parse(content) as RawAiResult;
}

// ─── 검증 및 확정 ─────────────────────────────────────────────────────────

const PAYMENT_TYPES = ["원비", "환불", "지출", "기타"] as const;
const PAYMENT_METHODS = ["계좌이체", "카드", "현금"] as const;
const STATUSES = ["상담문의", "대기등록", "최종등록", "보류"] as const;

function asPaymentType(v: unknown): PaymentType | null {
  return PAYMENT_TYPES.includes(v as PaymentType) ? (v as PaymentType) : null;
}
function asPaymentMethod(v: unknown): PaymentMethod | null {
  return PAYMENT_METHODS.includes(v as PaymentMethod) ? (v as PaymentMethod) : null;
}
function asStatus(v: unknown): ConsultationStatus | null {
  return STATUSES.includes(v as ConsultationStatus) ? (v as ConsultationStatus) : null;
}

function unclear(sourceText: string, corrections: string[], reason: string, question: string): ParseResult {
  return { sourceText, corrections, draft: { category: "unclear", reason, question } };
}

/**
 * 금액을 확정한다. 원문에서 뽑은 값을 우선하되, 원문에서 못 찾으면 AI 값을 쓴다.
 *
 * 원문 우선인 이유: AI가 "만원" 환산을 틀리는 일이 잦다.
 * AI 폴백을 둔 이유: "이십팔만원"처럼 한글 수사는 정규식이 못 읽는다.
 */
function resolveAmount(
  ai: RawAiResult,
  sourceText: string,
  corrections: string[]
): number | null {
  const amounts = extractAmounts(sourceText);
  const fromAi = ai.amount != null ? Math.abs(ai.amount) : null;

  if (amounts.length === 0) {
    if (fromAi != null) {
      corrections.push(`금액을 AI 해석값 ${fromAi.toLocaleString()}원으로 사용했습니다. 확인해 주세요.`);
      return fromAi;
    }
    return null;
  }

  const fromText = amounts[0];
  if (fromAi != null && fromAi !== fromText) {
    corrections.push(
      `금액을 원문 기준 ${fromText.toLocaleString()}원으로 정정했습니다. (AI 추출값: ${fromAi.toLocaleString()}원)`
    );
  }
  if (amounts.length > 1) {
    corrections.push(
      `금액이 여러 개(${amounts.map((a) => a.toLocaleString()).join(", ")}) 발견되어 첫 번째를 사용했습니다. 확인해 주세요.`
    );
  }
  return fromText;
}

/** 결제 유형을 확정한다. 낱말이 분명하면 코드가 이긴다. */
function resolveType(ai: RawAiResult, sourceText: string, corrections: string[]): PaymentType {
  const aiType = asPaymentType(ai.payment_type);
  const fromText = extractPaymentType(sourceText);
  const type = fromText ?? aiType ?? "원비";
  if (fromText && aiType && fromText !== aiType) {
    corrections.push(`유형을 원문 기준 "${fromText}"로 정정했습니다. (AI 판단: "${aiType}")`);
  }
  return type;
}

/**
 * AI 결과를 코드로 재검증해 최종 초안을 만든다.
 * 이 함수는 순수 함수이므로 API 없이 단독 테스트할 수 있다.
 */
export function arbitrate(
  ai: RawAiResult,
  sourceText: string,
  now: Date = new Date()
): ParseResult {
  const corrections: string[] = [];

  const phones = extractPhones(sourceText);
  const phone = phones.length > 0 ? normalizePhone(phones[0]) : null;
  const studentName = cleanStudentName(ai.student_name);

  // 낱말이 명백하면 코드 판정을 신뢰한다. AI가 "등록"을 상담문의로 흘려보내면
  // 학생·수강등록이 만들어지지 않아 학생 목록에 뜨지 않는다.
  const statusFromText = extractConsultationStatus(sourceText);
  const typeFromText = extractPaymentType(sourceText);

  // ── 사건 판정: AI 의도를 기본으로 쓰되 원문 낱말로 보강한다 ──
  const enroll =
    ai.enroll || statusFromText === "최종등록" || asStatus(ai.status) === "최종등록";
  // "환불"·"지출"은 등록과 무관한 회계 사건이므로 결제 동반으로 보지 않는다.
  const isOutflow = typeFromText === "환불" || typeFromText === "지출";
  const hasPayment = ai.payment || (typeFromText !== null && !isOutflow);

  // ── 1. 등록 (결제 동반 가능) ──
  if (enroll && !isOutflow) {
    if (!studentName) {
      return unclear(
        sourceText,
        corrections,
        "등록 건으로 보이는데 학생 이름을 찾지 못했습니다.",
        "어느 학생의 등록인가요? (예: 정재현 숭의중1 등록 결제 28만)"
      );
    }

    let payment: PaymentPart | null = null;
    if (hasPayment) {
      const amount = resolveAmount(ai, sourceText, corrections);
      if (amount !== null) {
        if (!isPlausibleAmount(amount)) {
          return unclear(
            sourceText,
            corrections,
            `금액 ${amount.toLocaleString()}원이 정상 범위(${AMOUNT_MIN.toLocaleString()}~${AMOUNT_MAX.toLocaleString()}원)를 벗어납니다.`,
            "금액을 다시 확인해 주세요. 자릿수가 맞나요?"
          );
        }
        // 등록과 함께 낸 돈은 등록한 달의 원비로 보는 것이 자연스럽다.
        // 여기서 되물으면 "정재현 등록 결제 28만"처럼 월을 안 적은 문장이 전부 막힌다.
        const month = normalizeMonth(ai.payment_month, sourceText, now);
        const paymentMonth = month ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        if (!month) {
          corrections.push(`납부월이 없어 이번달(${paymentMonth})로 두었습니다. 다르면 고쳐주세요.`);
        }
        payment = {
          amount,
          type: resolveType(ai, sourceText, corrections),
          method: asPaymentMethod(ai.payment_method) ?? extractPaymentMethod(sourceText),
          paymentMonth,
        };
      }
    }

    const dueDay = extractDueDay(sourceText) ?? (Number.isInteger(ai.due_day) ? ai.due_day : null);
    const startDate = extractStartDate(sourceText, now);
    if (dueDay !== null) corrections.push(`납부 기준일을 매월 ${dueDay}일로 읽었습니다.`);
    if (startDate !== null) corrections.push(`등록일을 ${startDate}로 읽었습니다.`);
    if (!phone) {
      corrections.push("전화번호가 없어 비워 두었습니다. 아래에서 입력해 주세요.");
    }

    return {
      sourceText,
      corrections,
      draft: {
        category: "registration",
        studentName,
        school: ai.school?.trim() || null,
        grade: ai.grade?.trim() || null,
        parentPhone: phone,
        guardianName: ai.guardian_name?.trim() || null,
        classHint: {
          scheduleDays: ai.schedule_days?.length ? ai.schedule_days : null,
          teacherName: ai.teacher_name?.trim().replace(/\s*(선생님|쌤|T)$/, "") || null,
          level: ai.class_level?.trim() || null,
        },
        startDate,
        dueDay: dueDay !== null && dueDay >= 1 && dueDay <= 31 ? dueDay : null,
        payment,
        subject: ai.subject?.trim() || null,
        memo: ai.memo?.trim() || null,
      },
    };
  }

  // ── 2. 순수 수납 (등록 없이 돈만 오간 경우) ──
  const amounts = extractAmounts(sourceText);
  if ((hasPayment || isOutflow || amounts.length > 0) && !ai.consultation) {
    const amount = resolveAmount(ai, sourceText, corrections);
    if (amount === null) {
      return unclear(
        sourceText,
        corrections,
        "수납 관련 문장 같은데 금액이 없습니다.",
        "금액이 얼마인가요? (예: 김민준 35만원 이번달 원비 카드)"
      );
    }
    if (!isPlausibleAmount(amount)) {
      return unclear(
        sourceText,
        corrections,
        `금액 ${amount.toLocaleString()}원이 정상 범위(${AMOUNT_MIN.toLocaleString()}~${AMOUNT_MAX.toLocaleString()}원)를 벗어납니다.`,
        "금액을 다시 확인해 주세요. 자릿수가 맞나요?"
      );
    }

    const type = resolveType(ai, sourceText, corrections);
    // 환불·지출은 음수로 저장한다 (Payments 화면이 amount를 단순 SUM 하므로)
    const signed = type === "환불" || type === "지출" ? -amount : amount;
    if (signed < 0) {
      corrections.push(`${type}이므로 금액을 음수(${signed.toLocaleString()}원)로 기록합니다.`);
    }

    const paymentMonth = normalizeMonth(ai.payment_month, sourceText, now);
    if (!paymentMonth) {
      return unclear(
        sourceText,
        corrections,
        "몇 월분 수납인지 문장에서 찾지 못했습니다.",
        "몇 월분인가요? (예: 이번달, 8월)"
      );
    }
    if (!ai.payment_month) {
      corrections.push(`월 정보가 없어 원문에서 ${paymentMonth}로 해석했습니다.`);
    }

    // 원비/환불은 어느 학생인지 모르면 저장할 수 없다 (enrollmentId를 못 찾음)
    if (!studentName && (type === "원비" || type === "환불")) {
      return unclear(
        sourceText,
        corrections,
        "학생 이름을 찾지 못했습니다.",
        "어느 학생의 수납인가요?"
      );
    }

    return {
      sourceText,
      corrections,
      draft: {
        category: "accounting",
        studentName,
        amount: signed,
        type,
        paymentMonth,
        method: asPaymentMethod(ai.payment_method) ?? extractPaymentMethod(sourceText),
        memo: ai.memo?.trim() || null,
      },
    };
  }

  // ── 3. 상담/문의 ──
  // 상담은 연락처가 기록의 전부라, 번호가 없으면 남길 의미가 없다.
  if (phone) {
    const status: ConsultationStatus = statusFromText ?? asStatus(ai.status) ?? "상담문의";
    if (statusFromText && asStatus(ai.status) && statusFromText !== asStatus(ai.status)) {
      corrections.push(
        `상태를 원문 기준 "${statusFromText}"로 정정했습니다. (AI 판단: "${asStatus(ai.status)}")`
      );
    }

    const dueDay = extractDueDay(sourceText);
    const startDate = extractStartDate(sourceText, now);
    if (dueDay !== null) corrections.push(`납부 기준일을 매월 ${dueDay}일로 읽었습니다.`);
    if (startDate !== null) corrections.push(`등록일을 ${startDate}로 읽었습니다.`);

    return {
      sourceText,
      corrections,
      draft: {
        category: "contact",
        phone,
        guardianName: ai.guardian_name?.trim() || null,
        studentName,
        studentGrade: ai.grade?.trim() || null,
        status,
        subject: ai.subject?.trim() || null,
        followUp: ai.follow_up?.trim() || null,
        memo: ai.memo?.trim() || null,
        dueDay,
        startDate,
      },
    };
  }

  // ── 4. 판단 불가 ──
  if (ai.needs_clarification && ai.question) {
    return unclear(sourceText, corrections, "입력 내용을 확실히 이해하지 못했습니다.", ai.question);
  }
  if (statusFromText !== null) {
    return unclear(
      sourceText,
      corrections,
      "상담 건으로 보이는데 연락처가 없습니다.",
      "학부모 연락처를 함께 적어주세요. (예: 010-1234-5678 김민준 중2 영어 문의)"
    );
  }
  return unclear(
    sourceText,
    corrections,
    "등록·수납·상담 중 어느 것인지 판단할 수 없습니다.",
    "수납 건이면 금액을, 상담 건이면 연락처를, 등록 건이면 학생 이름과 '등록'을 적어주세요."
  );
}

/** 자연어 문장 하나를 초안으로 변환한다. */
export async function parseInput(
  text: string,
  opts: { now?: Date; signal?: AbortSignal } = {}
): Promise<ParseResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      sourceText: text,
      corrections: [],
      draft: { category: "unclear", reason: "입력이 비어 있습니다.", question: "내용을 입력해 주세요." },
    };
  }

  const ai = await callOpenAi(trimmed, opts.signal);
  return arbitrate(ai, trimmed, opts.now ?? new Date());
}
