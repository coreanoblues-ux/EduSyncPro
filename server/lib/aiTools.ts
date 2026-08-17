/**
 * AI 상담실장 Tool Registry
 *
 * OpenAI function calling이 사용할 수 있는 학원 업무 도구들.
 * 각 도구는 기존 storage 메서드를 감싸되, AI가 이해하기 쉬운
 * 형태로 입출력을 정리한다.
 *
 * 도구는 DB SQL을 직접 실행하지 않는다. 모든 데이터 접근은
 * storage 인터페이스를 통해 이루어진다.
 */

import { storage } from "../storage";
import { parseDays, parseSchedule, formatMinutes } from "@shared/timetable";
import { canonicalGrade } from "@shared/gradePromotion";

// ─── Tool execution context ────────────────────────────────────────────

export interface ToolContext {
  tenantId: string;
  userId: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 금액을 "150,000원" 형태로 포맷한다. */
function formatKRW(amount: number): string {
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString("ko-KR");
  return amount < 0 ? `-${formatted}원` : `${formatted}원`;
}

/** 날짜를 "2026-08-17 (월)" 형태로 포맷한다. */
function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "-";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "-";
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const ymd = date.toISOString().slice(0, 10);
  return `${ymd} (${days[date.getUTCDay()]})`;
}

/**
 * "민준이 엄마", "서연이 아빠" 패턴에서 학생 이름을 추출한다.
 * 매칭되면 학생 이름을 반환하고, 아니면 null.
 */
function extractStudentFromParentPattern(query: string): string | null {
  const m = query.match(/^(.+?)(?:이\s*)?(?:엄마|아빠|어머니|아버지|부모|보호자|학부모)$/);
  return m ? m[1].trim() : null;
}

/**
 * 두 문자열의 유사도를 간단히 비교한다.
 * 포함 관계이면 true.
 */
function fuzzyMatch(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase().replace(/\s+/g, "");
  const n = needle.toLowerCase().replace(/\s+/g, "");
  return h.includes(n) || n.includes(h);
}

/**
 * "중학생", "고등학생", "초등학생", "중", "고", "초", "고등부", "중등부" 등을
 * 학교급 접두사("중", "고", "초")로 정규화한다. 정확한 학년("중1")이면 null.
 */
function normalizeGradeLevel(input: string): string | null {
  const s = input.trim();
  // 이미 정확한 학년이면 접두사 매칭이 아닌 정확 매칭 사용
  if (/^[초중고]\d$/.test(s)) return null;

  if (/^중|중학|중학생|중등|중등부/.test(s)) return "중";
  if (/^고|고등|고등학생|고등부/.test(s)) return "고";
  if (/^초|초등|초등학생|초등부/.test(s)) return "초";
  return null;
}

// ─── Tool definitions for OpenAI ────────────────────────────────────────

/** OpenAI function calling schema. name → parameters (JSON Schema). */
export const TOOL_DEFINITIONS: Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}> = [
  // ── Student tools ──
  {
    type: "function",
    function: {
      name: "search_students",
      description:
        "학생을 이름(부분 일치), 학년, 학교로 검색한다. '민준이 엄마' 같은 보호자 표현도 처리한다.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "학생 이름, 부분 이름, 또는 '민준이 엄마' 형태의 검색어",
          },
          grade: {
            type: "string",
            description: "학년 필터. 정확한 학년(중1, 고2) 또는 학교급 전체(중, 고, 초, 중학생, 고등학생, 초등학생)",
          },
          school: {
            type: "string",
            description: "학교 이름 필터 (부분 일치)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_student_profile",
      description:
        "학생의 전체 프로필을 조회한다: 기본 정보, 현재 수강 중인 반(강사·시간표 포함), 이번 달 납부 상태, 최근 상담 수.",
      parameters: {
        type: "object",
        properties: {
          student_id: {
            type: "string",
            description: "학생 ID",
          },
        },
        required: ["student_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_student_payment_status",
      description:
        "학생의 수납 상세 내역: 활성 수강별로 월별 납부/미납 상태를 보여준다.",
      parameters: {
        type: "object",
        properties: {
          student_id: {
            type: "string",
            description: "학생 ID",
          },
          months: {
            type: "number",
            description: "조회할 개월 수 (기본 3개월)",
          },
        },
        required: ["student_id"],
      },
    },
  },
  // ── Class tools ──
  {
    type: "function",
    function: {
      name: "search_classes",
      description:
        "반을 이름, 요일, 시간, 강사명, 과목으로 검색한다. 현재 수강 인원과 정원도 반환한다. 조건 없이 호출하면 전체 반 목록을 반환한다.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "반 이름 키워드 (부분 일치, 예: '고등', '수학A')",
          },
          days: {
            type: "array",
            items: { type: "string" },
            description: "요일 목록 (예: ['월', '수', '금'])",
          },
          teacher_name: {
            type: "string",
            description: "강사 이름 (부분 일치)",
          },
          time_hour: {
            type: "number",
            description: "시작 시간 (시 단위, 예: 15 = 오후 3시)",
          },
          subject: {
            type: "string",
            description: "과목명 (부분 일치)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_class_roster",
      description: "반에 수강 중인 학생 명단을 조회한다. 학년, 보호자 연락처 포함.",
      parameters: {
        type: "object",
        properties: {
          class_id: {
            type: "string",
            description: "반 ID",
          },
        },
        required: ["class_id"],
      },
    },
  },
  // ── Payment tools ──
  {
    type: "function",
    function: {
      name: "get_unpaid_students",
      description: "해당 월에 미납인 학생 목록. 반명, 강사명, 예상 금액 포함.",
      parameters: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description: "조회 월 (YYYY-MM, 기본 이번 달)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "record_payment",
      description:
        "수납 기록을 생성한다. enrollment_id를 안 주면 학생의 활성 수강을 자동으로 찾는다.",
      parameters: {
        type: "object",
        properties: {
          student_id: {
            type: "string",
            description: "학생 ID",
          },
          enrollment_id: {
            type: "string",
            description: "수강 등록 ID (생략 시 자동 검색)",
          },
          amount: {
            type: "number",
            description: "금액 (양수: 원비, 음수: 환불/지출)",
          },
          method: {
            type: "string",
            enum: ["계좌이체", "카드", "현금"],
            description: "결제 수단",
          },
          month: {
            type: "string",
            description: "납부 월 (YYYY-MM, 기본 이번 달)",
          },
          type: {
            type: "string",
            enum: ["원비", "환불", "지출", "기타"],
            description: "거래 종류 (기본 '원비')",
          },
          notes: {
            type: "string",
            description: "비고",
          },
        },
        required: ["student_id", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_monthly_revenue",
      description: "월별 매출 요약: 총액, 종류별/수단별 합계, 건수.",
      parameters: {
        type: "object",
        properties: {
          month: {
            type: "string",
            description: "조회 월 (YYYY-MM, 기본 이번 달)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_monthly_revenue",
      description: "두 달의 매출을 비교한다.",
      parameters: {
        type: "object",
        properties: {
          month1: {
            type: "string",
            description: "비교 월 1 (YYYY-MM, 기본 지난달)",
          },
          month2: {
            type: "string",
            description: "비교 월 2 (YYYY-MM, 기본 이번 달)",
          },
        },
        required: [],
      },
    },
  },
  // ── Consultation tools ──
  {
    type: "function",
    function: {
      name: "get_recent_consultations",
      description:
        "최근 상담 기록 조회. student_id를 주면 해당 학생만, 안 주면 전체.",
      parameters: {
        type: "object",
        properties: {
          student_id: {
            type: "string",
            description: "학생 ID (생략 시 전체)",
          },
          limit: {
            type: "number",
            description: "조회 건수 (기본 10)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_consultation",
      description: "상담/문의 기록을 생성한다.",
      parameters: {
        type: "object",
        properties: {
          phone: { type: "string", description: "연락처" },
          guardianName: { type: "string", description: "보호자명" },
          studentName: { type: "string", description: "학생 이름" },
          studentGrade: { type: "string", description: "학년 (예: '중1')" },
          status: {
            type: "string",
            enum: ["상담문의", "대기등록", "최종등록", "보류"],
            description: "상담 상태 (기본 '상담문의')",
          },
          subject: { type: "string", description: "문의 과목" },
          followUp: { type: "string", description: "후속 조치 메모" },
          memo: { type: "string", description: "상담 메모" },
        },
        required: [],
      },
    },
  },
  // ── Task tools ──
  {
    type: "function",
    function: {
      name: "create_task",
      description: "할 일(퇴근전/출근전)을 생성한다.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "할 일 내용" },
          dueDate: {
            type: "string",
            description: "마감일 (YYYY-MM-DD, 기본 오늘)",
          },
          slot: {
            type: "string",
            enum: ["퇴근전", "출근전"],
            description: "시간대 (기본 '퇴근전')",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_tasks",
      description: "미완료 할 일 목록 조회. 날짜를 주면 해당일, 안 주면 오늘.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "조회 날짜 (YYYY-MM-DD, 기본 오늘)",
          },
        },
        required: [],
      },
    },
  },
  // ── Statistics tools ──
  {
    type: "function",
    function: {
      name: "get_dashboard_summary",
      description:
        "대시보드 요약: 재원생 수, 반 수, 이번 달 매출, 미납자 수, 최근 신규 등록 수.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_attendance_issues",
      description:
        "수업 일지(lesson_logs) 기반으로 최근 수업 기록이 없는 반을 찾는다. (개별 출석 테이블은 없으므로 반 단위 점검)",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "최근 며칠간 확인할지 (기본 7일)",
          },
        },
        required: [],
      },
    },
  },
  // ── Utility tools ──
  {
    type: "function",
    function: {
      name: "get_teacher_info",
      description: "강사 정보 조회. 이름 부분 일치로 검색.",
      parameters: {
        type: "object",
        properties: {
          teacher_name: {
            type: "string",
            description: "강사 이름 (부분 일치, 생략 시 전체 목록)",
          },
        },
        required: [],
      },
    },
  },
  // ── 학생 등록·수정 도구 ──
  {
    type: "function",
    function: {
      name: "create_student",
      description: "새 학생을 등록한다. 이름은 필수, 나머지는 선택.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "학생 이름" },
          school: { type: "string", description: "학교 이름 (예: 숭의중, 불로초)" },
          grade: { type: "string", description: "학년 (예: 중1, 고2, 초6)" },
          gender: { type: "string", enum: ["남", "여"], description: "성별" },
          parent_phone: { type: "string", description: "보호자 연락처" },
          notes: { type: "string", description: "특이사항 메모" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_student",
      description: "기존 학생의 정보를 수정한다. student_id 필수. 바꿀 필드만 넘긴다.",
      parameters: {
        type: "object",
        properties: {
          student_id: { type: "string", description: "학생 ID" },
          name: { type: "string", description: "학생 이름" },
          school: { type: "string", description: "학교" },
          grade: { type: "string", description: "학년" },
          gender: { type: "string", enum: ["남", "여"], description: "성별" },
          parent_phone: { type: "string", description: "보호자 연락처" },
          notes: { type: "string", description: "특이사항 메모" },
          is_active: { type: "boolean", description: "활성 여부 (false=휴원)" },
        },
        required: ["student_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "enroll_student",
      description: "학생을 반에 수강 등록한다.",
      parameters: {
        type: "object",
        properties: {
          student_id: { type: "string", description: "학생 ID" },
          class_id: { type: "string", description: "반 ID" },
          tuition: { type: "number", description: "수강료 (생략 시 반 기본 수강료 적용)" },
          due_day: { type: "integer", description: "납부일 (1~31, 기본 1)" },
          start_date: { type: "string", description: "시작일 (YYYY-MM-DD, 기본 오늘)" },
        },
        required: ["student_id", "class_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_students_by_schedule",
      description: "요일·시간·강사·학년 조건에 맞는 학생 목록 조회. 조건을 생략하면 전체.",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "array",
            items: { type: "string", enum: ["월", "화", "수", "목", "금", "토", "일"] },
            description: "필터 요일 목록",
          },
          teacher_name: { type: "string", description: "강사 이름 (부분 일치)" },
          hour: { type: "integer", description: "수업 시작 시간 (24시간제, 예: 17)" },
          grade: { type: "string", description: "학년 필터 (예: 중1, 고, 초6)" },
        },
        required: [],
      },
    },
  },
];

// ─── Tool implementations ───────────────────────────────────────────────

// ── Student tools ──

async function searchStudents(
  args: { query?: string; grade?: string; school?: string },
  ctx: ToolContext
) {
  const allStudents = await storage.getStudentsByTenant(ctx.tenantId);
  let results = allStudents.filter((s) => s.isActive);

  // 보호자 패턴 처리: "민준이 엄마" → 학생 "민준"의 parentPhone 반환
  const parentQuery = args.query ? extractStudentFromParentPattern(args.query) : null;
  const searchName = parentQuery ?? args.query;

  if (searchName) {
    const term = searchName.trim();
    // 부분 이름 매칭
    results = results.filter((s) => fuzzyMatch(s.name, term));

    // 정확히 일치하는 학생을 앞에 정렬
    results.sort((a, b) => {
      const exact = (s: typeof a) => (s.name === term ? 0 : 1);
      return exact(a) - exact(b) || a.name.localeCompare(b.name, "ko");
    });
  }

  // 학년 필터 — 접두사("중", "고", "초") 또는 정확한 학년("중1") 모두 지원
  if (args.grade) {
    const gradePrefix = normalizeGradeLevel(args.grade);
    if (gradePrefix) {
      // 학교급 전체: "중학생", "고등학생", "고", "중" 등
      results = results.filter((s) => {
        const sg = (canonicalGrade(s.grade, s.school) ?? s.grade ?? "");
        return sg.startsWith(gradePrefix);
      });
    } else {
      // 정확한 학년: "중1", "고2" 등
      const canonical = canonicalGrade(args.grade) ?? args.grade;
      results = results.filter((s) => {
        const sg = canonicalGrade(s.grade, s.school) ?? s.grade;
        return sg === canonical;
      });
    }
  }

  // 학교 필터
  if (args.school) {
    const schoolTerm = args.school.trim();
    results = results.filter(
      (s) => s.school && fuzzyMatch(s.school, schoolTerm)
    );
  }

  const mapped = results.slice(0, 50).map((s) => ({
    id: s.id,
    name: s.name,
    grade: s.grade ?? "-",
    school: s.school ?? "-",
    parentPhone: s.parentPhone ?? "-",
    isActive: s.isActive,
  }));

  // 보호자 패턴이었으면 그 사실을 결과에 명시
  if (parentQuery && mapped.length > 0) {
    return {
      note: `"${args.query}"(으)로 검색 → 학생 "${parentQuery}" 기준 조회`,
      students: mapped,
    };
  }

  return { students: mapped };
}

async function getStudentProfile(
  args: { student_id: string },
  ctx: ToolContext
) {
  const student = await storage.getStudent(args.student_id);
  if (!student || student.tenantId !== ctx.tenantId) {
    return { error: "학생을 찾을 수 없습니다." };
  }

  // 현재 수강 + 반 정보
  const activeEnrollments = await storage.getActiveEnrollmentsWithClass(
    ctx.tenantId,
    student.id
  );

  // 각 수강의 강사 정보와 시간표
  const allTeachers = await storage.getTeachersByTenant(ctx.tenantId);
  const allClasses = await storage.getClassesByTenant(ctx.tenantId);
  const teacherMap = new Map(allTeachers.map((t) => [t.id, t]));
  const classMap = new Map(allClasses.map((c) => [c.id, c]));

  const enrollmentDetails = activeEnrollments.map((e) => {
    const cls = classMap.get(e.classId);
    const teacher = cls ? teacherMap.get(cls.teacherId) : undefined;
    const slots = cls ? parseSchedule(cls.schedule, cls.name) : [];
    const scheduleText = slots
      .map((s) => `${s.day} ${formatMinutes(s.startMin)}~${formatMinutes(s.endMin)}`)
      .join(", ");

    return {
      enrollmentId: e.id,
      className: e.className,
      subject: e.classSubject,
      teacherName: teacher?.name ?? "-",
      schedule: scheduleText || cls?.schedule || "-",
      tuition: formatKRW(e.tuition ?? e.defaultTuition),
    };
  });

  // 이번 달 납부 상태
  const month = currentMonth();
  const allPayments = await storage.getPaymentsByTenant(ctx.tenantId);
  const studentPayments = allPayments.filter(
    (p) =>
      p.paymentMonth === month &&
      p.amount > 0 &&
      activeEnrollments.some((e) => e.id === p.enrollmentId)
  );

  const paidEnrollmentIds = new Set(studentPayments.map((p) => p.enrollmentId));
  const paymentStatus = activeEnrollments.length === 0
    ? "수강 없음"
    : activeEnrollments.every((e) => paidEnrollmentIds.has(e.id))
      ? "완납"
      : "미납 있음";

  // 최근 상담 수
  const allConsultations = await storage.getConsultationsByTenant(ctx.tenantId);
  const studentConsultations = allConsultations.filter(
    (c) => c.studentId === student.id || c.studentName === student.name
  );

  return {
    student: {
      id: student.id,
      name: student.name,
      grade: student.grade ?? "-",
      school: student.school ?? "-",
      gender: student.gender ?? "-",
      parentPhone: student.parentPhone ?? "-",
      siblingGroup: student.siblingGroup ?? null,
      notes: student.notes ?? null,
      isActive: student.isActive,
      createdAt: formatDate(student.createdAt),
    },
    enrollments: enrollmentDetails,
    paymentStatus: {
      month,
      status: paymentStatus,
      paidCount: studentPayments.length,
      totalEnrollments: activeEnrollments.length,
    },
    recentConsultations: studentConsultations.length,
  };
}

async function getStudentPaymentStatus(
  args: { student_id: string; months?: number },
  ctx: ToolContext
) {
  const student = await storage.getStudent(args.student_id);
  if (!student || student.tenantId !== ctx.tenantId) {
    return { error: "학생을 찾을 수 없습니다." };
  }

  const monthCount = args.months ?? 3;
  const activeEnrollments = await storage.getActiveEnrollmentsWithClass(
    ctx.tenantId,
    student.id
  );

  // 최근 N개월 목록 생성
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < monthCount; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }

  const allPayments = await storage.getPaymentsByTenant(ctx.tenantId);

  const details = activeEnrollments.map((enrollment) => {
    const enrollmentPayments = allPayments.filter(
      (p) => p.enrollmentId === enrollment.id
    );
    const expectedAmount = enrollment.tuition ?? enrollment.defaultTuition;

    const monthlyStatus = months.map((m) => {
      const paid = enrollmentPayments
        .filter((p) => p.paymentMonth === m && p.amount > 0)
        .reduce((sum, p) => sum + p.amount, 0);
      return {
        month: m,
        expectedAmount: formatKRW(expectedAmount),
        paidAmount: formatKRW(paid),
        status: paid >= expectedAmount ? "납부" as const : paid > 0 ? "부분납부" as const : "미납" as const,
      };
    });

    return {
      enrollmentId: enrollment.id,
      className: enrollment.className,
      subject: enrollment.classSubject,
      monthlyStatus,
    };
  });

  return {
    studentName: student.name,
    enrollments: details,
  };
}

// ── Class tools ──

async function searchClasses(
  args: { query?: string; days?: string[]; teacher_name?: string; time_hour?: number; subject?: string },
  ctx: ToolContext
) {
  const allClasses = await storage.getClassesByTenant(ctx.tenantId);
  const activeClasses = allClasses.filter((c) => c.isActive);
  const allTeachers = await storage.getTeachersByTenant(ctx.tenantId);
  const teacherMap = new Map(allTeachers.map((t) => [t.id, t]));

  // 수강 인원 계산
  const allEnrollments = await storage.getEnrollmentsByTenant(ctx.tenantId);
  const enrollmentCounts = new Map<string, number>();
  for (const e of allEnrollments) {
    if (e.isActive) {
      enrollmentCounts.set(e.classId, (enrollmentCounts.get(e.classId) ?? 0) + 1);
    }
  }

  let results = activeClasses;

  // 반 이름 키워드 필터
  if (args.query) {
    const q = args.query.trim();
    results = results.filter((c) => fuzzyMatch(c.name, q) || fuzzyMatch(c.subject, q));
  }

  // 요일 필터
  if (args.days && args.days.length > 0) {
    const targetDays = new Set(args.days.flatMap((d) => parseDays(d)));
    results = results.filter((c) => {
      const classDays = parseDays(c.schedule);
      return classDays.some((d) => targetDays.has(d));
    });
  }

  // 강사명 필터
  if (args.teacher_name) {
    const tName = args.teacher_name.trim();
    results = results.filter((c) => {
      const teacher = teacherMap.get(c.teacherId);
      return teacher && fuzzyMatch(teacher.name, tName);
    });
  }

  // 시간 필터
  if (args.time_hour !== undefined) {
    const targetMin = args.time_hour * 60;
    const tolerance = 60; // +-1시간 허용
    results = results.filter((c) => {
      const slots = parseSchedule(c.schedule, c.name);
      return slots.some(
        (s) => Math.abs(s.startMin - targetMin) <= tolerance
      );
    });
  }

  // 과목 필터
  if (args.subject) {
    const subj = args.subject.trim();
    results = results.filter((c) => fuzzyMatch(c.subject, subj));
  }

  return {
    classes: results.slice(0, 50).map((c) => {
      const teacher = teacherMap.get(c.teacherId);
      const slots = parseSchedule(c.schedule, c.name);
      const scheduleText = slots
        .map((s) => `${s.day} ${formatMinutes(s.startMin)}~${formatMinutes(s.endMin)}`)
        .join(", ");

      return {
        id: c.id,
        name: c.name,
        subject: c.subject,
        teacherName: teacher?.name ?? "-",
        schedule: scheduleText || c.schedule,
        currentStudents: enrollmentCounts.get(c.id) ?? 0,
        maxStudents: c.maxStudents ?? 20,
        defaultTuition: formatKRW(c.defaultTuition),
      };
    }),
  };
}

async function getClassRoster(
  args: { class_id: string },
  ctx: ToolContext
) {
  const cls = await storage.getClass(args.class_id);
  if (!cls || cls.tenantId !== ctx.tenantId) {
    return { error: "반을 찾을 수 없습니다." };
  }

  const allEnrollments = await storage.getEnrollmentsByTenant(ctx.tenantId);
  const classEnrollments = allEnrollments.filter(
    (e) => e.classId === args.class_id && e.isActive
  );

  const allStudents = await storage.getStudentsByTenant(ctx.tenantId);
  const studentMap = new Map(allStudents.map((s) => [s.id, s]));

  const roster = classEnrollments
    .map((e) => {
      const student = studentMap.get(e.studentId);
      if (!student) return null;
      return {
        studentId: student.id,
        name: student.name,
        grade: student.grade ?? "-",
        school: student.school ?? "-",
        parentPhone: student.parentPhone ?? "-",
        isActive: student.isActive,
      };
    })
    .filter(Boolean);

  const teacher = await storage.getTeacher(cls.teacherId);

  return {
    className: cls.name,
    subject: cls.subject,
    teacherName: teacher?.name ?? "-",
    schedule: cls.schedule,
    studentCount: roster.length,
    maxStudents: cls.maxStudents ?? 20,
    students: roster,
  };
}

// ── Payment tools ──

async function getUnpaidStudents(
  args: { month?: string },
  ctx: ToolContext
) {
  const month = args.month ?? currentMonth();

  const allEnrollments = await storage.getEnrollmentsByTenant(ctx.tenantId);
  const activeEnrollments = allEnrollments.filter((e) => e.isActive);

  const allPayments = await storage.getPaymentsByTenant(ctx.tenantId);
  const monthPayments = allPayments.filter(
    (p) => p.paymentMonth === month && p.amount > 0
  );
  const paidEnrollmentIds = new Set(monthPayments.map((p) => p.enrollmentId));

  const unpaidEnrollments = activeEnrollments.filter(
    (e) => !paidEnrollmentIds.has(e.id)
  );

  const allStudents = await storage.getStudentsByTenant(ctx.tenantId);
  const studentMap = new Map(allStudents.map((s) => [s.id, s]));
  const allClasses = await storage.getClassesByTenant(ctx.tenantId);
  const classMap = new Map(allClasses.map((c) => [c.id, c]));
  const allTeachers = await storage.getTeachersByTenant(ctx.tenantId);
  const teacherMap = new Map(allTeachers.map((t) => [t.id, t]));

  const unpaid = unpaidEnrollments
    .map((e) => {
      const student = studentMap.get(e.studentId);
      const cls = classMap.get(e.classId);
      const teacher = cls ? teacherMap.get(cls.teacherId) : undefined;
      if (!student || !student.isActive) return null;

      return {
        studentId: student.id,
        studentName: student.name,
        parentPhone: student.parentPhone ?? "-",
        className: cls?.name ?? "-",
        teacherName: teacher?.name ?? "-",
        month,
        expectedAmount: formatKRW(e.tuition ?? cls?.defaultTuition ?? 0),
      };
    })
    .filter(Boolean);

  return {
    month,
    unpaidCount: unpaid.length,
    students: unpaid,
  };
}

async function recordPayment(
  args: {
    student_id: string;
    enrollment_id?: string;
    amount: number;
    method?: "계좌이체" | "카드" | "현금";
    month?: string;
    type?: "원비" | "환불" | "지출" | "기타";
    notes?: string;
  },
  ctx: ToolContext
) {
  const student = await storage.getStudent(args.student_id);
  if (!student || student.tenantId !== ctx.tenantId) {
    return { error: "학생을 찾을 수 없습니다." };
  }

  let enrollmentId = args.enrollment_id ?? null;

  // enrollment_id가 없으면 활성 수강을 찾는다
  if (!enrollmentId) {
    const activeEnrollments = await storage.getActiveEnrollmentsWithClass(
      ctx.tenantId,
      student.id
    );

    if (activeEnrollments.length === 0) {
      return { error: "활성 수강 등록이 없습니다." };
    }
    if (activeEnrollments.length === 1) {
      enrollmentId = activeEnrollments[0].id;
    } else {
      // 여러 수강이 있으면 사용자에게 선택하게 한다
      return {
        error: "수강이 여러 건이라 선택이 필요합니다.",
        enrollments: activeEnrollments.map((e) => ({
          enrollmentId: e.id,
          className: e.className,
          subject: e.classSubject,
          tuition: formatKRW(e.tuition ?? e.defaultTuition),
        })),
      };
    }
  }

  const paymentType = args.type ?? "원비";
  const paymentMonth = args.month ?? currentMonth();

  const created = await storage.createPayment({
    tenantId: ctx.tenantId,
    enrollmentId,
    amount: args.amount,
    type: paymentType,
    method: args.method ?? null,
    paymentMonth,
    paidDate: new Date(),
    createdBy: ctx.userId,
    notes: args.notes ?? null,
    sourceText: null,
  });

  return {
    success: true,
    payment: {
      id: created.id,
      studentName: student.name,
      amount: formatKRW(created.amount),
      type: paymentType,
      method: args.method ?? "-",
      month: paymentMonth,
      paidDate: formatDate(created.paidDate),
    },
  };
}

function computeRevenueSummary(payments: Array<{ amount: number; type: string; method: string | null }>) {
  const total = payments.reduce((s, p) => s + p.amount, 0);

  const byType: Record<string, number> = { 원비: 0, 환불: 0, 지출: 0, 기타: 0 };
  const byMethod: Record<string, number> = { 계좌이체: 0, 카드: 0, 현금: 0, 미지정: 0 };

  for (const p of payments) {
    byType[p.type] = (byType[p.type] ?? 0) + p.amount;
    const method = p.method ?? "미지정";
    byMethod[method] = (byMethod[method] ?? 0) + p.amount;
  }

  return {
    total: formatKRW(total),
    totalRaw: total,
    byType: Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, formatKRW(v)])
    ),
    byMethod: Object.fromEntries(
      Object.entries(byMethod).map(([k, v]) => [k, formatKRW(v)])
    ),
    count: payments.length,
  };
}

async function getMonthlyRevenue(
  args: { month?: string },
  ctx: ToolContext
) {
  const month = args.month ?? currentMonth();
  const allPayments = await storage.getPaymentsByTenant(ctx.tenantId);
  const monthPayments = allPayments.filter((p) => p.paymentMonth === month);

  return {
    month,
    ...computeRevenueSummary(monthPayments),
  };
}

async function compareMonthlyRevenue(
  args: { month1?: string; month2?: string },
  ctx: ToolContext
) {
  const now = new Date();
  const m2 = args.month2 ?? currentMonth();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const m1 = args.month1 ?? prev.toISOString().slice(0, 7);

  const allPayments = await storage.getPaymentsByTenant(ctx.tenantId);
  const p1 = allPayments.filter((p) => p.paymentMonth === m1);
  const p2 = allPayments.filter((p) => p.paymentMonth === m2);

  const s1 = computeRevenueSummary(p1);
  const s2 = computeRevenueSummary(p2);

  const diff = s2.totalRaw - s1.totalRaw;
  const diffPct = s1.totalRaw !== 0 ? ((diff / Math.abs(s1.totalRaw)) * 100).toFixed(1) : "-";

  return {
    month1: { month: m1, ...s1 },
    month2: { month: m2, ...s2 },
    diff: {
      amount: formatKRW(diff),
      percentage: diffPct === "-" ? "-" : `${diffPct}%`,
      direction: diff > 0 ? "증가" : diff < 0 ? "감소" : "동일",
    },
  };
}

// ── Consultation tools ──

async function getRecentConsultations(
  args: { student_id?: string; limit?: number },
  ctx: ToolContext
) {
  const allConsultations = await storage.getConsultationsByTenant(ctx.tenantId);
  const limit = args.limit ?? 10;

  let filtered = allConsultations;

  if (args.student_id) {
    // studentId 또는 studentName으로 매칭
    const student = await storage.getStudent(args.student_id);
    if (student) {
      filtered = allConsultations.filter(
        (c) => c.studentId === args.student_id || c.studentName === student.name
      );
    } else {
      return { error: "학생을 찾을 수 없습니다." };
    }
  }

  // 최신순 정렬 후 limit 적용 (이미 storage에서 createdAt desc로 정렬됨)
  const results = filtered.slice(0, limit).map((c) => ({
    id: c.id,
    studentName: c.studentName ?? "-",
    guardianName: c.guardianName ?? "-",
    phone: c.phone ?? "-",
    studentGrade: c.studentGrade ?? "-",
    status: c.status,
    subject: c.subject ?? "-",
    followUp: c.followUp ?? null,
    memo: c.memo ?? null,
    createdAt: formatDate(c.createdAt),
  }));

  return { consultations: results };
}

async function createConsultation(
  args: {
    phone?: string;
    guardianName?: string;
    studentName?: string;
    studentGrade?: string;
    status?: "상담문의" | "대기등록" | "최종등록" | "보류";
    subject?: string;
    followUp?: string;
    memo?: string;
  },
  ctx: ToolContext
) {
  // 학년을 정규화
  const grade = args.studentGrade
    ? canonicalGrade(args.studentGrade) ?? args.studentGrade
    : null;

  const created = await storage.createConsultation({
    tenantId: ctx.tenantId,
    phone: args.phone ?? null,
    guardianName: args.guardianName ?? null,
    studentName: args.studentName ?? null,
    studentGrade: grade,
    status: args.status ?? "상담문의",
    subject: args.subject ?? null,
    followUp: args.followUp ?? null,
    memo: args.memo ?? null,
    classId: null,
    studentId: null,
    sourceText: null,
    createdBy: ctx.userId,
  });

  return {
    success: true,
    consultation: {
      id: created.id,
      studentName: created.studentName ?? "-",
      guardianName: created.guardianName ?? "-",
      status: created.status,
      createdAt: formatDate(created.createdAt),
    },
  };
}

// ── Task tools ──

async function createTask(
  args: { title: string; dueDate?: string; slot?: "퇴근전" | "출근전" },
  ctx: ToolContext
) {
  const dueDate = args.dueDate ?? todayStr();
  const slot = args.slot ?? "퇴근전";

  const created = await storage.createTask({
    tenantId: ctx.tenantId,
    title: args.title,
    dueDate,
    slot,
    completedAt: null,
    deferCount: 0,
    notes: null,
    sourceText: null,
    createdBy: ctx.userId,
  });

  return {
    success: true,
    task: {
      id: created.id,
      title: created.title,
      dueDate: created.dueDate,
      slot: created.slot,
    },
  };
}

async function getTasks(
  args: { date?: string },
  ctx: ToolContext
) {
  const targetDate = args.date ?? todayStr();
  const allTasks = await storage.getTasksByTenant(ctx.tenantId);

  // 미완료이면서 해당 날짜 이하인 할 일 (밀린 것 포함)
  const pending = allTasks
    .filter((t) => !t.completedAt && t.dueDate <= targetDate)
    .sort((a, b) => {
      // 밀린 횟수 내림차순, 같으면 날짜 오름차순
      if (b.deferCount !== a.deferCount) return b.deferCount - a.deferCount;
      return a.dueDate.localeCompare(b.dueDate);
    });

  return {
    date: targetDate,
    count: pending.length,
    tasks: pending.map((t) => ({
      id: t.id,
      title: t.title,
      dueDate: t.dueDate,
      slot: t.slot,
      deferCount: t.deferCount,
      notes: t.notes ?? null,
      isOverdue: t.dueDate < targetDate,
    })),
  };
}

// ── Statistics tools ──

async function getDashboardSummary(
  _args: Record<string, never>,
  ctx: ToolContext
) {
  const month = currentMonth();

  const allStudents = await storage.getStudentsByTenant(ctx.tenantId);
  const activeStudents = allStudents.filter((s) => s.isActive);

  const allClasses = await storage.getClassesByTenant(ctx.tenantId);
  const activeClasses = allClasses.filter((c) => c.isActive);

  const allPayments = await storage.getPaymentsByTenant(ctx.tenantId);
  const monthPayments = allPayments.filter((p) => p.paymentMonth === month);
  const revenue = monthPayments.reduce((s, p) => s + p.amount, 0);

  // 미납자 수 계산
  const allEnrollments = await storage.getEnrollmentsByTenant(ctx.tenantId);
  const activeEnrollments = allEnrollments.filter((e) => e.isActive);
  const paidEnrollmentIds = new Set(
    monthPayments.filter((p) => p.amount > 0).map((p) => p.enrollmentId)
  );
  const unpaidStudentIds = new Set(
    activeEnrollments
      .filter((e) => !paidEnrollmentIds.has(e.id))
      .map((e) => e.studentId)
  );
  // 재원생 중에서만 미납자 카운트
  const unpaidCount = activeStudents.filter((s) => unpaidStudentIds.has(s.id)).length;

  // 최근 7일 신규 등록 수
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const recentRegistrations = activeStudents.filter(
    (s) => s.createdAt && new Date(s.createdAt) >= weekAgo
  ).length;

  return {
    month,
    activeStudents: activeStudents.length,
    activeClasses: activeClasses.length,
    monthlyRevenue: formatKRW(revenue),
    unpaidStudents: unpaidCount,
    recentRegistrations,
  };
}

async function getAttendanceIssues(
  args: { days?: number },
  ctx: ToolContext
) {
  const lookbackDays = args.days ?? 7;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);

  const allClasses = await storage.getClassesByTenant(ctx.tenantId);
  const activeClasses = allClasses.filter((c) => c.isActive);

  const allLessonLogs = await storage.getLessonLogsByTenant(ctx.tenantId);
  const allTeachers = await storage.getTeachersByTenant(ctx.tenantId);
  const teacherMap = new Map(allTeachers.map((t) => [t.id, t]));

  // 수강 인원
  const allEnrollments = await storage.getEnrollmentsByTenant(ctx.tenantId);
  const enrollmentCounts = new Map<string, number>();
  for (const e of allEnrollments) {
    if (e.isActive) {
      enrollmentCounts.set(e.classId, (enrollmentCounts.get(e.classId) ?? 0) + 1);
    }
  }

  // 최근 N일간 수업 일지가 없는 활성 반 찾기
  const recentLogClassIds = new Set(
    allLessonLogs
      .filter((l) => new Date(l.date) >= cutoff)
      .map((l) => l.classId)
  );

  // 수강생이 있는데 일지가 없는 반만 문제로 보고
  const issues = activeClasses
    .filter((c) => {
      const count = enrollmentCounts.get(c.id) ?? 0;
      return count > 0 && !recentLogClassIds.has(c.id);
    })
    .map((c) => {
      const teacher = teacherMap.get(c.teacherId);
      // 해당 반의 가장 최근 일지
      const classLogs = allLessonLogs
        .filter((l) => l.classId === c.id)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const lastLog = classLogs[0];

      return {
        classId: c.id,
        className: c.name,
        subject: c.subject,
        teacherName: teacher?.name ?? "-",
        studentCount: enrollmentCounts.get(c.id) ?? 0,
        lastLessonLog: lastLog ? formatDate(lastLog.date) : "기록 없음",
        schedule: c.schedule,
      };
    });

  return {
    lookbackDays,
    issueCount: issues.length,
    note: "개별 학생 출석 테이블이 없어 반별 수업 일지 기준으로 점검합니다.",
    classes: issues,
  };
}

// ── Utility tools ──

async function getTeacherInfo(
  args: { teacher_name?: string },
  ctx: ToolContext
) {
  const allTeachers = await storage.getTeachersByTenant(ctx.tenantId);
  const allClasses = await storage.getClassesByTenant(ctx.tenantId);

  let filtered = allTeachers.filter((t) => t.isActive);

  if (args.teacher_name) {
    const name = args.teacher_name.trim();
    filtered = filtered.filter((t) => fuzzyMatch(t.name, name));
  }

  const result = filtered.map((t) => {
    const teacherClasses = allClasses
      .filter((c) => c.teacherId === t.id && c.isActive)
      .map((c) => ({
        classId: c.id,
        className: c.name,
        subject: c.subject,
        schedule: c.schedule,
      }));

    return {
      id: t.id,
      name: t.name,
      subject: t.subject,
      phone: t.phone ?? "-",
      classCount: teacherClasses.length,
      classes: teacherClasses,
    };
  });

  return { teachers: result };
}

// ─── Dispatcher ─────────────────────────────────────────────────────────

// ── Student CRUD tools ──

async function createStudentTool(
  args: { name: string; school?: string; grade?: string; gender?: string; parent_phone?: string; notes?: string },
  ctx: ToolContext
) {
  // 동명이인 확인
  const existing = await storage.findStudentsByName(ctx.tenantId, args.name);
  const activeExisting = existing.filter((s) => s.isActive);

  const student = await storage.createStudent({
    tenantId: ctx.tenantId,
    name: args.name,
    school: args.school ?? null,
    grade: args.grade ? (canonicalGrade(args.grade) ?? args.grade) : null,
    gender: args.gender ?? null,
    parentPhone: args.parent_phone ?? null,
    notes: args.notes ?? null,
    isActive: true,
  });

  return {
    success: true,
    student: {
      id: student.id,
      name: student.name,
      school: student.school,
      grade: student.grade,
      gender: student.gender,
      parentPhone: student.parentPhone,
    },
    ...(activeExisting.length > 0 ? {
      warning: `동명이인 ${activeExisting.length}명이 이미 있습니다: ${activeExisting.map((s) => `${s.name}(${s.grade ?? "학년 미정"}, ${s.school ?? "학교 미정"})`).join(", ")}`,
    } : {}),
  };
}

async function updateStudentTool(
  args: { student_id: string; name?: string; school?: string; grade?: string; gender?: string; parent_phone?: string; notes?: string; is_active?: boolean },
  ctx: ToolContext
) {
  // 해당 학생이 이 학원 소속인지 확인
  const allStudents = await storage.getStudentsByTenant(ctx.tenantId);
  const target = allStudents.find((s) => s.id === args.student_id);
  if (!target) return { error: "해당 학생을 찾을 수 없습니다." };

  const updateData: Record<string, any> = {};
  if (args.name !== undefined) updateData.name = args.name;
  if (args.school !== undefined) updateData.school = args.school;
  if (args.grade !== undefined) updateData.grade = canonicalGrade(args.grade) ?? args.grade;
  if (args.gender !== undefined) updateData.gender = args.gender;
  if (args.parent_phone !== undefined) updateData.parentPhone = args.parent_phone;
  if (args.notes !== undefined) updateData.notes = args.notes;
  if (args.is_active !== undefined) updateData.isActive = args.is_active;

  const updated = await storage.updateStudent(args.student_id, updateData);
  return {
    success: true,
    student: {
      id: updated.id,
      name: updated.name,
      school: updated.school,
      grade: updated.grade,
      parentPhone: updated.parentPhone,
      isActive: updated.isActive,
    },
  };
}

async function enrollStudentTool(
  args: { student_id: string; class_id: string; tuition?: number; due_day?: number; start_date?: string },
  ctx: ToolContext
) {
  // 학생과 반이 이 학원 소속인지 확인
  const allStudents = await storage.getStudentsByTenant(ctx.tenantId);
  const student = allStudents.find((s) => s.id === args.student_id);
  if (!student) return { error: "해당 학생을 찾을 수 없습니다." };

  const allClasses = await storage.getClassesByTenant(ctx.tenantId);
  const cls = allClasses.find((c) => c.id === args.class_id);
  if (!cls) return { error: "해당 반을 찾을 수 없습니다." };

  // 이미 등록되어 있는지 확인
  const existingEnrollments = await storage.getEnrollmentsByTenant(ctx.tenantId);
  const alreadyEnrolled = existingEnrollments.find(
    (e) => e.studentId === args.student_id && e.classId === args.class_id && e.isActive
  );
  if (alreadyEnrolled) {
    return { error: `${student.name}은(는) 이미 ${cls.name}에 등록되어 있습니다.` };
  }

  const enrollment = await storage.createEnrollment({
    tenantId: ctx.tenantId,
    studentId: args.student_id,
    classId: args.class_id,
    tuition: args.tuition ?? cls.defaultTuition,
    dueDay: args.due_day ?? 1,
    startDate: new Date(args.start_date ?? todayStr()),
    isActive: true,
  });

  return {
    success: true,
    enrollment: {
      id: enrollment.id,
      studentName: student.name,
      className: cls.name,
      tuition: enrollment.tuition,
      startDate: enrollment.startDate,
    },
  };
}

async function listStudentsBySchedule(
  args: { days?: string[]; teacher_name?: string; hour?: number; grade?: string },
  ctx: ToolContext
) {
  const allStudents = await storage.getStudentsByTenant(ctx.tenantId);
  const allEnrollments = await storage.getEnrollmentsByTenant(ctx.tenantId);
  const allClasses = await storage.getClassesByTenant(ctx.tenantId);
  const allTeachers = await storage.getTeachersByTenant(ctx.tenantId);

  const studentById = new Map(allStudents.map((s) => [s.id, s]));
  const classById = new Map(allClasses.map((c) => [c.id, c]));
  const teacherById = new Map(allTeachers.map((t) => [t.id, t]));

  const results: Array<{
    studentName: string;
    grade: string | null;
    parentPhone: string | null;
    teacherName: string;
    className: string;
    schedule: string | null;
  }> = [];

  for (const enrollment of allEnrollments) {
    if (!enrollment.isActive) continue;
    const student = studentById.get(enrollment.studentId);
    if (!student || !student.isActive) continue;
    const cls = classById.get(enrollment.classId);
    if (!cls || !cls.isActive) continue;
    const teacher = cls.teacherId ? teacherById.get(cls.teacherId) : undefined;

    // 요일 필터
    if (args.days && args.days.length > 0) {
      const classSlots = parseSchedule(cls.schedule || "", cls.name || "");
      const classDays = classSlots.length > 0
        ? Array.from(new Set(classSlots.map((s) => s.day)))
        : parseDays(cls.schedule || "");
      if (!args.days.some((d) => classDays.includes(d as any))) continue;
    }

    // 강사 필터
    if (args.teacher_name) {
      const wanted = args.teacher_name.replace(/\s+/g, "");
      const actual = teacher?.name?.replace(/\s+/g, "") ?? "";
      if (!actual.includes(wanted)) continue;
    }

    // 시간 필터
    if (args.hour !== undefined) {
      const slots = parseSchedule(cls.schedule || "", cls.name || "");
      if (slots.length === 0) continue;
      if (!slots.some((s) => Math.floor(s.startMin / 60) === args.hour)) continue;
    }

    // 학년 필터
    if (args.grade) {
      const g = student.grade || "";
      if (args.grade.length === 1) {
        if (!g.startsWith(args.grade)) continue;
      } else {
        const canonical = canonicalGrade(args.grade) ?? args.grade;
        if (g !== canonical && !g.startsWith(args.grade)) continue;
      }
    }

    results.push({
      studentName: student.name,
      grade: student.grade,
      parentPhone: student.parentPhone,
      teacherName: teacher?.name || "담당 미정",
      className: cls.name,
      schedule: cls.schedule,
    });
  }

  results.sort((a, b) => a.studentName.localeCompare(b.studentName, "ko"));

  return {
    count: results.length,
    students: results,
  };
}

const TOOL_MAP: Record<
  string,
  (args: any, ctx: ToolContext) => Promise<any>
> = {
  search_students: searchStudents,
  get_student_profile: getStudentProfile,
  get_student_payment_status: getStudentPaymentStatus,
  search_classes: searchClasses,
  get_class_roster: getClassRoster,
  get_unpaid_students: getUnpaidStudents,
  record_payment: recordPayment,
  get_monthly_revenue: getMonthlyRevenue,
  compare_monthly_revenue: compareMonthlyRevenue,
  get_recent_consultations: getRecentConsultations,
  create_consultation: createConsultation,
  create_task: createTask,
  get_tasks: getTasks,
  get_dashboard_summary: getDashboardSummary,
  get_attendance_issues: getAttendanceIssues,
  get_teacher_info: getTeacherInfo,
  create_student: createStudentTool,
  update_student: updateStudentTool,
  enroll_student: enrollStudentTool,
  list_students_by_schedule: listStudentsBySchedule,
};

export async function executeTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<any> {
  const fn = TOOL_MAP[name];
  if (!fn) {
    return { error: `알 수 없는 도구: ${name}` };
  }
  try {
    return await fn(args, ctx);
  } catch (err: any) {
    return {
      error: `도구 실행 중 오류: ${err.message ?? String(err)}`,
    };
  }
}
