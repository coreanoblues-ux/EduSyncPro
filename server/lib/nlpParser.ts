/**
 * 자연어 한 줄 입력 → 구조화된 초안(draft) 변환
 *
 * 설계 원칙
 *  1. OpenAI 결과는 "초안"일 뿐이다. 저장은 원장이 확인 버튼을 누른 뒤에만 일어난다.
 *  2. 틀리면 회계가 망가지는 값(전화번호·금액·월)은 nlpNormalize.ts의 순수 함수가
 *     원문에서 직접 다시 뽑아 AI 결과를 덮어쓴다. AI가 규칙을 어겨도 코드가 막는다.
 *  3. 확신이 없으면 추측하지 않고 category="unclear"로 되돌려 원장에게 되묻는다.
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

export interface AccountingDraft {
  category: "accounting";
  studentName: string | null;
  amount: number; // 원비=양수, 환불·지출=음수
  type: PaymentType;
  paymentMonth: string; // YYYY-MM
  method: PaymentMethod | null;
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

export type ParseResult = {
  draft: AccountingDraft | ContactDraft | UnclearDraft;
  sourceText: string;
  /** 코드 검증 단계에서 AI 결과를 고친 내역 — UI에 "이렇게 해석했습니다"로 보여준다 */
  corrections: string[];
};

// ─── OpenAI 호출 ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 한국 영어학원 관리 시스템의 자연어 입력 분석기입니다.
원장이 한 줄로 입력한 문장에서 정보를 추출해 JSON으로만 응답하세요.

[분류 규칙 — 우선순위 순]
1. 전화번호가 하나라도 언급되면 category="contact"
2. 전화번호가 없고 금액이 언급되면 category="accounting"
3. 둘 다 없거나 판단이 어려우면 category="unclear" (억지로 추측하지 말 것)

[중요]
- "만원"은 10000을 곱해 숫자로 환산 (35만원 → 350000)
- amount는 항상 양수로 추출하세요. 환불/지출 여부는 type 필드로만 표현합니다.
- 확실하지 않은 필드는 절대 추측하지 말고 null을 넣으세요.
- 이름이 명시되지 않았으면 student_name은 null입니다. 흔한 이름을 지어내지 마세요.
- month는 원문 표현을 그대로 넣으세요 ("이번달", "8월", "2026-08" 등). 계산하지 마세요.

[type — 돈이 들어오는 방향]
- "결제", "수납", "납부", "입금", "원비", "수강료" → "원비" (학원으로 돈이 들어옴)
- "환불", "환급", "돌려줌" → "환불"
- "지출", "구입", "수리비", "월세", "급여" → "지출"
- 결제 관련 낱말을 환불로 뒤집지 마세요. 환불은 "환불"이라고 명시된 경우에만입니다.

[status — 상담 진행 단계]
- "등록", "신규등록", "최종등록", "등록생", "등록했어", "반에 넣어줘" → "최종등록"
- "대기", "자리 나면" → "대기등록"
- "문의", "상담", "알아봄" → "상담문의"
- "보류", "취소", "안 하기로" → "보류"

[예시]
- "010-1234-5678 김민준 중2 영어 등록, 기준일 13일" → contact / status="최종등록"
- "김민준 35만원 이번달 원비 카드 결제" → accounting / type="원비" / payment_method="카드"
- "이지우 20만원 환불" → accounting / type="환불"`;

/** OpenAI Structured Outputs 스키마. 두 카테고리를 한 객체로 평탄화해 strict 모드를 쓴다. */
const JSON_SCHEMA = {
  name: "hagwon_input",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "category",
      "student_name",
      "amount",
      "type",
      "month",
      "payment_method",
      "phone",
      "guardian_name",
      "student_grade",
      "status",
      "subject",
      "follow_up",
      "memo",
    ],
    properties: {
      category: { type: "string", enum: ["accounting", "contact", "unclear"] },
      student_name: { type: ["string", "null"] },
      amount: { type: ["number", "null"] },
      type: { type: ["string", "null"], enum: ["원비", "환불", "지출", "기타", null] },
      month: { type: ["string", "null"] },
      payment_method: { type: ["string", "null"], enum: ["계좌이체", "카드", "현금", null] },
      phone: { type: ["string", "null"] },
      guardian_name: { type: ["string", "null"] },
      student_grade: { type: ["string", "null"] },
      status: {
        type: ["string", "null"],
        enum: ["상담문의", "대기등록", "최종등록", "보류", null],
      },
      subject: { type: ["string", "null"] },
      follow_up: { type: ["string", "null"] },
      memo: { type: ["string", "null"] },
    },
  },
} as const;

interface RawAiResult {
  category: string;
  student_name: string | null;
  amount: number | null;
  type: string | null;
  month: string | null;
  payment_method: string | null;
  phone: string | null;
  guardian_name: string | null;
  student_grade: string | null;
  status: string | null;
  subject: string | null;
  follow_up: string | null;
  memo: string | null;
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
      max_tokens: 400,
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
  const amounts = extractAmounts(sourceText);

  // ── 규칙 1: 전화번호가 있으면 무조건 contact (AI가 뭐라 했든 코드가 우선) ──
  if (phones.length > 0) {
    if (ai.category !== "contact") {
      corrections.push(`전화번호(${phones[0]})가 있어 상담/문의로 분류했습니다.`);
    }

    // "등록"이라고 썼으면 등록으로 걸려야 한다. AI가 이를 상담문의로 흘려보내면
    // 학생·수강 등록이 만들어지지 않아 학생 목록에 뜨지 않는다.
    const aiStatus = (["상담문의", "대기등록", "최종등록", "보류"] as const).includes(
      ai.status as ConsultationStatus
    )
      ? (ai.status as ConsultationStatus)
      : null;
    const statusFromText = extractConsultationStatus(sourceText);
    const status: ConsultationStatus = statusFromText ?? aiStatus ?? "상담문의";

    if (statusFromText && aiStatus && statusFromText !== aiStatus) {
      corrections.push(`상태를 원문 기준 "${statusFromText}"로 정정했습니다. (AI 판단: "${aiStatus}")`);
    } else if (!statusFromText && !aiStatus) {
      corrections.push(`상태를 기본값 "상담문의"로 설정했습니다.`);
    }

    // 청구가 어긋나면 안 되는 값이라 AI를 거치지 않고 원문에서 직접 뽑는다.
    const dueDay = extractDueDay(sourceText);
    const startDate = extractStartDate(sourceText, now);
    if (dueDay !== null) corrections.push(`납부 기준일을 매월 ${dueDay}일로 읽었습니다.`);
    if (startDate !== null) corrections.push(`등록일을 ${startDate}로 읽었습니다.`);

    return {
      sourceText,
      corrections,
      draft: {
        category: "contact",
        phone: normalizePhone(phones[0])!,
        guardianName: ai.guardian_name?.trim() || null,
        studentName: cleanStudentName(ai.student_name),
        studentGrade: ai.student_grade?.trim() || null,
        status,
        subject: ai.subject?.trim() || null,
        followUp: ai.follow_up?.trim() || null,
        memo: ai.memo?.trim() || null,
        dueDay,
        startDate,
      },
    };
  }

  // ── 규칙 2: 전화번호 없고 금액이 있으면 accounting ──
  if (amounts.length > 0) {
    // 원문에서 뽑은 금액을 우선한다. AI가 "만원" 환산을 틀리는 경우가 있기 때문.
    const fromText = amounts[0];
    const fromAi = ai.amount != null ? Math.abs(ai.amount) : null;

    if (fromAi != null && fromAi !== fromText) {
      corrections.push(
        `금액을 원문 기준 ${fromText.toLocaleString()}원으로 정정했습니다. (AI 추출값: ${fromAi.toLocaleString()}원)`
      );
    }

    if (!isPlausibleAmount(fromText)) {
      return {
        sourceText,
        corrections,
        draft: {
          category: "unclear",
          reason: `금액 ${fromText.toLocaleString()}원이 정상 범위(${AMOUNT_MIN.toLocaleString()}~${AMOUNT_MAX.toLocaleString()}원)를 벗어납니다.`,
          question: "금액을 다시 확인해 주세요. 자릿수가 맞나요?",
        },
      };
    }

    if (amounts.length > 1) {
      corrections.push(
        `금액이 여러 개(${amounts.map((a) => a.toLocaleString()).join(", ")}) 발견되어 첫 번째를 사용했습니다. 확인해 주세요.`
      );
    }

    // "결제"·"수납"을 AI가 환불로 뒤집는 일이 있었다. 환불은 음수로 저장되므로
    // 한 번 틀리면 매출이 금액의 두 배만큼 어긋난다 — 낱말이 분명하면 코드가 이긴다.
    const aiType = (["원비", "환불", "지출", "기타"] as const).includes(ai.type as PaymentType)
      ? (ai.type as PaymentType)
      : null;
    const typeFromText = extractPaymentType(sourceText);
    const type: PaymentType = typeFromText ?? aiType ?? "원비";

    if (typeFromText && aiType && typeFromText !== aiType) {
      corrections.push(`유형을 원문 기준 "${typeFromText}"로 정정했습니다. (AI 판단: "${aiType}")`);
    }

    // 환불·지출은 음수로 저장한다 (Payments 화면이 amount를 단순 SUM 하므로)
    const signed = type === "환불" || type === "지출" ? -fromText : fromText;
    if (signed < 0) {
      corrections.push(`${type}이므로 금액을 음수(${signed.toLocaleString()}원)로 기록합니다.`);
    }

    const paymentMonth = normalizeMonth(ai.month, sourceText, now);
    if (!paymentMonth) {
      return {
        sourceText,
        corrections,
        draft: {
          category: "unclear",
          reason: "몇 월분 수납인지 문장에서 찾지 못했습니다.",
          question: "몇 월분인가요? (예: 이번달, 8월)",
        },
      };
    }
    if (!ai.month) {
      corrections.push(`월 정보가 없어 원문에서 ${paymentMonth}로 해석했습니다.`);
    }

    const studentName = cleanStudentName(ai.student_name);
    // 원비/환불은 어느 학생인지 모르면 저장할 수 없다 (enrollmentId를 못 찾음)
    if (!studentName && (type === "원비" || type === "환불")) {
      return {
        sourceText,
        corrections,
        draft: {
          category: "unclear",
          reason: "학생 이름을 찾지 못했습니다.",
          question: "어느 학생의 수납인가요?",
        },
      };
    }

    const method: PaymentMethod | null = (["계좌이체", "카드", "현금"] as const).includes(
      ai.payment_method as PaymentMethod
    )
      ? (ai.payment_method as PaymentMethod)
      : extractPaymentMethod(sourceText);

    return {
      sourceText,
      corrections,
      draft: {
        category: "accounting",
        studentName,
        amount: signed,
        type,
        paymentMonth,
        method,
        memo: ai.memo?.trim() || null,
      },
    };
  }

  // ── 규칙 3: 둘 다 없으면 추측하지 않고 되묻는다 ──
  // 원장님 원안은 "애매하면 CONTACT"였지만, 그러면 "김민준 이번달 원비"처럼
  // 금액만 빠진 수납 문장이 상담 목록으로 새어 들어가 회계가 누락된다.
  // 그래서 저장하지 않고 명시적으로 되묻는 쪽을 택했다.
  const looksLikePayment = /원비|수강료|납부|입금|결제|환불|지출|수납/.test(sourceText);
  if (looksLikePayment) {
    return {
      sourceText,
      corrections,
      draft: {
        category: "unclear",
        reason: "수납 관련 문장 같은데 금액이 없습니다.",
        question: "금액이 얼마인가요? (예: 김민준 35만원 이번달 원비 카드)",
      },
    };
  }

  // 등록 의사는 읽었지만 연락처가 없는 경우. 그냥 "판단 불가"라고만 하면
  // 원장은 무엇을 더 써야 하는지 알 수 없다.
  if (extractConsultationStatus(sourceText) !== null) {
    return {
      sourceText,
      corrections,
      draft: {
        category: "unclear",
        reason: "등록/상담 건으로 보이는데 연락처가 없습니다.",
        question:
          "학부모 연락처를 함께 적어주세요. (예: 010-1234-5678 김민준 중2 영어 등록, 기준일 13일, 8월 13일부터)",
      },
    };
  }

  return {
    sourceText,
    corrections,
    draft: {
      category: "unclear",
      reason: "전화번호도 금액도 없어 어느 쪽인지 판단할 수 없습니다.",
      question: "수납 건이면 금액을, 상담·등록 건이면 연락처를 함께 적어주세요.",
    },
  };
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
