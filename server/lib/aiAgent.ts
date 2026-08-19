/**
 * AI Agent Orchestrator
 *
 * 원장의 자연어 요청을 OpenAI function calling(tool use)으로 처리한다.
 *
 * 흐름:
 *   1. 프론트엔드가 대화 이력(ChatMessage[])을 보낸다.
 *   2. 시스템 프롬프트 + 대화 이력 + 사용 가능한 도구를 OpenAI에 전송한다.
 *   3. OpenAI가 tool_calls를 반환하면 executeTool()로 실행하고 결과를 피드백한다.
 *   4. tool_calls 없이 텍스트 응답이 올 때까지 반복한다(최대 8회).
 *   5. 감사 로그를 기록한다.
 *
 * 의존성: openai SDK 없음 — Node 18+ 내장 fetch 사용.
 */

import { TOOL_DEFINITIONS, executeTool, type ToolContext } from "./aiTools";
import { storage } from "../storage";
import { NlpConfigError } from "./nlpParser";

// ─── Constants ─────────────────────────────────────────────────────────

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const MAX_ITERATIONS = 8;

// ─── System prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 PAGEONE 학원관리시스템의 **AI 상담실장**입니다.
학원 원장님을 도와 원생·수업·수납·상담·할 일 등 학원 운영 전반을 처리합니다.

## 역할
- 학원 원장님의 자연어 질문·지시를 이해하고, 제공된 도구를 사용해 실제 데이터를 조회·수정합니다.
- **설명보다 실행을 우선**합니다. "이렇게 하시면 됩니다"라고 안내하지 말고, 도구를 호출해서 직접 처리하세요.
- 데이터를 **절대 지어내지 마세요**. 반드시 도구로 확인한 실제 DB 데이터만 답변에 사용합니다.

## 다루는 데이터
원생(student), 수업/반(class), 수강등록(enrollment), 수납/결제(payment),
수업일지(lesson_log), 상담기록(consultation), 할 일(task), 대기자(waiter),
출결(attendance), 교사(teacher), 대시보드 요약(dashboard)

## 행동 규칙

### 조회(읽기) 작업
- 확인 없이 바로 실행합니다.

### 명확한 쓰기 작업 (수납 등록, 상담 기록, 할 일 추가, 학생 등록 등)
- 지시가 분명하면 확인 없이 바로 실행합니다.
- 예: "민준이 8월 수학 28만 원 결제" → 즉시 처리
- 예: "새 학생 등록: 이서연 중2 숭의중" → 즉시 등록
- 예: "이서연 수학A반에 등록" → 즉시 수강 등록

### 사람 이름의 "역할" 이해 — 매우 중요 ⚠
문장에서 사람 이름이 나오면 반드시 **역할(role)** 을 먼저 판단합니다. 위치가 아니라 문맥으로 판단합니다.

- **학생(STUDENT)**: '신규', '신규학생', '새 학생', '등록', '입학', '얘', '이 아이' 뒤의 이름. 학년(중1, 고2, 초6)이나 학교명이 함께 나오는 경우도 학생.
- **강사(TEACHER)**: 이름 뒤에 '선생님', '쌤', '샘', '강사', '담당', '담임', '선생'이 붙는 경우. 예: '고은채 선생님', '정쌤', '김강사'.
- **보호자(GUARDIAN)**: 이름 뒤에 '엄마', '아빠', '어머니', '아버지', '보호자', '학부모'가 붙는 경우. 예: '민준이 엄마'.

**한 문장에 학생·강사·보호자가 모두 나올 수 있습니다.** 이때 절대 강사 이름을 student_name에 넣지 마세요.

예:
- "신규학생 정동현 삼육중1 엄마번호 010-4444-3333 고은채 선생님 화목A반"
  → student_name="정동현", school="삼육중", grade="중1", parent_phone="010-4444-3333", teacher_name="고은채", class_hint="화목A반"
- "정동현 신규 삼육1 고은채쌤 화목A 엄마 010-4444-3333"
  → 동일하게 해석
- "삼육중1 정동현 엄마 010-... 화목A 고은채선생님"
  → 위치가 달라도 역할이 같으므로 동일하게 해석

### 신규 학생 등록 — Two-Phase 필수
1. **UNDERSTAND(파싱)**: 문장에서 학생/강사/보호자/학교/학년/반 힌트를 역할별로 분리합니다.
2. **VALIDATE + EXECUTE**:
   - create_student를 student_name·teacher_name·class_hint를 모두 넘겨 호출합니다.
   - 응답에 classCandidates가 있으면 그 중 하나(또는 정확히 매칭되는 것)로 곧바로 enroll_student를 호출합니다.
   - 응답이 error를 반환하면(예: student_name이 강사와 동일) 원문을 다시 파싱해 재시도합니다. 사용자에게 되묻지 말고 스스로 고쳐서 재실행하세요.

### 학생 정보 수정
- 이름으로 먼저 search_students를 호출하여 학생을 찾고, 결과의 id로 update_student를 호출합니다.
- 예: "김민준 전화번호 010-1234-5678로 변경" → 학생 검색 → update_student

### 수강 등록
- 학생과 반을 각각 검색하여 ID를 찾은 뒤 enroll_student를 호출합니다.
- 반 이름이 애매하면 search_classes로 후보를 보여주고 선택을 요청합니다.
- 강사 이름만 주어졌으면 search_classes(teacher_name=...)로 해당 강사의 반 목록을 좁혀 검색합니다.

### 상담 카드 중복 방지 — 매우 중요 ⚠
같은 학생이 이미 상담 카드에 있는 상태에서 원장이 "○○ 대기등록", "○○ 최종등록" 같이
**상태 전환만** 지시하면, 절대 create_consultation을 호출하지 마세요.
반드시 **update_consultation**으로 기존 카드의 status만 바꿉니다.

판단 기준:
- 같은 이름 + 같은 부모 전화번호 → 무조건 동일인. update_consultation.
- 같은 전화번호만 있어도 동일 가족일 가능성이 매우 높음. update_consultation.
- 원장이 "새로 등록", "신규 상담" 같은 신규 의사를 명시했을 때만 create_consultation.

create_consultation 자체도 내부에서 중복을 확인해 merged=true로 응답할 수 있는데,
그 응답이 오면 "새로 만들지 않고 기존 카드를 갱신했다"고 원장에게 알려 주세요.

### 상담 메모 수정
원장이 "○○ 상담에 XX 라고 메모 추가해줘" / "○○ 후속조치 다음주 화요일 재통화로 바꿔줘"
같이 말하면 update_consultation을 씁니다.
- 기본은 memo append (기존 메모 아래에 날짜와 함께 이어붙임).
- "메모 통째로 바꿔줘", "메모 새로 써줘" 처럼 명시적이면 memo_mode="replace".

### 상담 → 레벨테스트 → 등록의 흐름
학원 상담은 다음 7단계로 진행됩니다. 각 단계에서 학생이 새면 학원 매출이 즉시 빠지므로,
현재 어느 단계에 몇 명이 있는지 원장이 항상 파악할 수 있어야 합니다.

  상담문의 → 레벨테스트예정 → 레벨테스트완료 → 반배정상담 → (대기등록 또는 최종등록) → 보류

관련 도구:
- create_consultation: 새 상담을 만들 때. status를 명시하지 않으면 '상담문의'.
- schedule_level_test: "○○ 학생 레벨테스트 내일 오후 3시에 잡아줘" → 상태 '레벨테스트예정'으로 이동.
- record_level_test_result: "○○ 레벨테스트 결과 85점, 문법 약함, 수학B반 추천" → 상태 '레벨테스트완료'로 이동.
- list_level_tests: 예정/완료 목록 확인.
- 최종등록은 학생 계정과 수강등록이 필요하므로 create_student + enroll_student를 사용합니다.

원장이 "이번주 레벨테스트 누구야?" 같이 물으면 list_level_tests(filter="예정")로 답합니다.
"○○ 레벨테스트 결과 나왔어"라고 하면 record_level_test_result를 바로 호출하세요.

### 위험한 작업 (삭제, 환불, 비활성화, 대량 변경)
- 반드시 먼저 확인을 구합니다.
- 예: "민준이 수학반 등록 취소할까요?"

### 모호한 이름
- 동명이인이 있으면 번호 목록을 보여주고 선택을 요청합니다.
  예: "김민준 학생이 2명입니다:\n1. 김민준 (숭의중 1학년, 수학A반)\n2. 김민준 (영동초 6학년, 수학B반)\n어느 학생인가요?"

### 대화 맥락 유지
- 이전 대화에서 언급된 학생·수업이 있으면, "얘", "그 학생", "그 수업"은 해당 항목을 가리킵니다.
- "민준이 엄마" = 김민준의 보호자, "돈 안 낸 애" = 미납 원생, "정쌤" = 성이 정인 교사

### 실행 전 자기검증(Semantic Sanity Check)
쓰기 도구를 호출하기 직전, 내부적으로 스스로에게 물어보세요:
- 학생이라고 판단한 사람이 사실은 강사 이름이 아닌가?
- 강사라고 판단한 사람이 이름 뒤에 '선생님/쌤/강사' 표현이 실제로 붙어 있었나?
- 학생·강사·보호자 역할 배치가 원문 표현과 일치하는가?
- 이 해석을 실제 학원 상담실장이 들었을 때 자연스러운가?
모순이 발견되면 도구 호출 전에 스스로 수정합니다.

## 응답 스타일
- **한국어**로 답변합니다.
- 간결하게 1~4줄로 답합니다. 불필요하게 길게 쓰지 마세요.
- 표나 목록이 필요한 경우만 길게 작성합니다.
- 금액은 "150,000원" 형식으로, 날짜는 "2026-08-17 (월)" 형식으로 표시합니다.
- 전문적이되 친근한 어투를 사용합니다.

## 오늘 날짜
${new Date().toISOString().slice(0, 10)}
`;

// ─── Public interface ──────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatResult {
  reply: string;
  toolsUsed: string[];
  /** Entity context hints for frontend to maintain */
  context?: {
    studentId?: string;
    studentName?: string;
    classId?: string;
    className?: string;
    teacherId?: string;
    teacherName?: string;
  };
}

// ─── OpenAI message types (internal) ───────────────────────────────────

interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

interface OaiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OaiChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OaiToolCall[];
  };
  finish_reason: string;
}

interface OaiResponse {
  choices: OaiChoice[];
  error?: { message: string };
}

// ─── Main agent function ───────────────────────────────────────────────

export async function runAgent(
  messages: ChatMessage[],
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new NlpConfigError(
      "OPENAI_API_KEY가 설정되지 않았습니다. Railway 대시보드 → Variables에서 등록해주세요.",
    );
  }

  // Build OpenAI messages: system prompt + conversation history
  const oaiMessages: OaiMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  const toolsUsed: string[] = [];
  // Accumulate tool call results for context extraction
  const toolResults: Array<{ name: string; args: Record<string, any>; result: any }> = [];

  // Extract original user message for audit log
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const sourceText = lastUserMsg?.content ?? "";

  let finalReply = "";
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const body = {
      model: MODEL,
      messages: oaiMessages,
      tools: TOOL_DEFINITIONS,
      temperature: 0.3,
      max_tokens: 3000,
    };

    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(
        `OpenAI API 오류 (${res.status}): ${errBody || res.statusText}`,
      );
    }

    const data: OaiResponse = await res.json();

    if (data.error) {
      throw new Error(`OpenAI API 오류: ${data.error.message}`);
    }

    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("OpenAI 응답에 choices가 없습니다.");
    }

    const assistantMsg = choice.message;

    // If there are no tool calls, this is the final response
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      finalReply = assistantMsg.content ?? "";
      break;
    }

    // Add assistant message with tool_calls to history
    oaiMessages.push({
      role: "assistant",
      content: assistantMsg.content,
      tool_calls: assistantMsg.tool_calls,
    });

    // Execute each tool call and add results
    for (const toolCall of assistantMsg.tool_calls) {
      const fnName = toolCall.function.name;
      let args: Record<string, any> = {};

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        // If argument parsing fails, pass empty object
      }

      if (!toolsUsed.includes(fnName)) {
        toolsUsed.push(fnName);
      }

      let result: any;
      try {
        result = await executeTool(fnName, args, ctx);
      } catch (err: any) {
        result = { error: err.message || "도구 실행 중 오류가 발생했습니다." };
      }

      toolResults.push({ name: fnName, args, result });

      oaiMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }

  // If we exhausted iterations without a final reply, use the last content we got
  if (!finalReply && iterations >= MAX_ITERATIONS) {
    finalReply = "처리 과정이 너무 길어졌습니다. 질문을 더 구체적으로 해주시겠어요?";
  }

  // Extract entity context from tool results
  const context = extractContext(toolResults);

  // Write audit log (fire-and-forget, don't block response)
  writeAuditLog(ctx, sourceText, toolsUsed, toolResults, finalReply).catch(
    () => {
      // Silently ignore audit log failures
    },
  );

  return {
    reply: finalReply,
    toolsUsed,
    ...(context ? { context } : {}),
  };
}

// ─── Context extraction ────────────────────────────────────────────────

function extractContext(
  toolResults: Array<{ name: string; args: Record<string, any>; result: any }>,
): ChatResult["context"] | undefined {
  const ctx: NonNullable<ChatResult["context"]> = {};
  let hasAny = false;

  for (const { name, args, result } of toolResults) {
    if (!result || result.error) continue;

    // Student context
    if (
      name.includes("student") ||
      name === "search_students" ||
      name === "get_student_detail"
    ) {
      const student = extractSingle(result, "id", "name");
      if (student) {
        ctx.studentId = String(student.id);
        ctx.studentName = String(student.name);
        hasAny = true;
      }
    }

    // Class context
    if (name.includes("class") || name === "get_class_detail") {
      const cls = extractSingle(result, "id", "name");
      if (cls) {
        ctx.classId = String(cls.id);
        ctx.className = String(cls.name);
        hasAny = true;
      }
    }

    // Teacher context
    if (name.includes("teacher") || name === "get_teacher_info") {
      const teacher = extractSingle(result, "id", "name");
      if (teacher) {
        ctx.teacherId = String(teacher.id);
        ctx.teacherName = String(teacher.name);
        hasAny = true;
      }
    }

    // Also check args for explicit IDs
    if (args.studentId && !ctx.studentId) {
      ctx.studentId = String(args.studentId);
      hasAny = true;
    }
    if (args.classId && !ctx.classId) {
      ctx.classId = String(args.classId);
      hasAny = true;
    }
  }

  return hasAny ? ctx : undefined;
}

/**
 * If result is an object with the given fields, return it.
 * If result is an array with exactly one element, return that element.
 */
function extractSingle(
  result: any,
  idField: string,
  nameField: string,
): { id: any; name: any } | null {
  if (Array.isArray(result)) {
    if (result.length === 1 && result[0]?.[idField]) {
      return { id: result[0][idField], name: result[0][nameField] };
    }
    return null;
  }
  if (result && typeof result === "object" && result[idField]) {
    return { id: result[idField], name: result[nameField] };
  }
  return null;
}

// ─── Audit logging ─────────────────────────────────────────────────────

async function writeAuditLog(
  ctx: ToolContext,
  sourceText: string,
  toolsUsed: string[],
  toolResults: Array<{ name: string; args: Record<string, any>; result: any }>,
  reply: string,
): Promise<void> {
  // Infer intent from first tool called, or "chat" if no tools
  const intent = toolsUsed.length > 0 ? toolsUsed[0] : "chat";

  // Find entity type/id from the first meaningful tool result
  let entityType: string | undefined;
  let entityId: string | undefined;
  for (const { name, result } of toolResults) {
    if (!result || result.error) continue;
    if (name.includes("student")) {
      entityType = "student";
    } else if (name.includes("class")) {
      entityType = "class";
    } else if (name.includes("payment")) {
      entityType = "payment";
    } else if (name.includes("consultation")) {
      entityType = "consultation";
    } else if (name.includes("task")) {
      entityType = "task";
    } else if (name.includes("teacher")) {
      entityType = "teacher";
    }
    if (entityType) {
      const single = extractSingle(result, "id", "name");
      if (single) entityId = String(single.id);
      break;
    }
  }

  // Truncate reply for storage
  const resultSummary =
    reply.length > 500 ? reply.slice(0, 497) + "..." : reply;

  await storage.createAiAuditLog({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    sourceText,
    intent,
    toolsCalled: toolsUsed.length > 0 ? toolsUsed.join(", ") : null,
    entityType: entityType ?? null,
    entityId: entityId ?? null,
    result: resultSummary,
  });
}
