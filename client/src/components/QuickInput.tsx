/**
 * 자연어 한 줄 입력 (AI 입력)
 *
 * 흐름: 문장 입력 → 서버가 초안 생성 → 원장이 확인·수정 → 저장
 *
 * ⚠️ 핵심 설계: 파싱 결과는 절대 자동 저장되지 않는다.
 *    AI가 학생 이름을 지어내거나 금액을 잘못 읽어도 저장 전에 사람이 막을 수 있어야 한다.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Sparkles, AlertTriangle, Loader2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

type PaymentType = "원비" | "환불" | "지출" | "기타";
type PaymentMethod = "계좌이체" | "카드" | "현금";
type ConsultationStatus = "상담문의" | "대기등록" | "최종등록" | "보류";

interface EnrollmentOption {
  id: string;
  className: string;
  classSubject: string;
  tuition: number | null;
  defaultTuition: number;
  dueDay?: number | null;
  /** 조회(lookup) 응답에만 붙는다 — 이번 달 납부 실적 */
  paidThisMonth?: boolean;
  paidAmount?: number;
  paidDate?: string | null;
}

interface StudentMatch {
  student: {
    id: string;
    name: string;
    grade: string | null;
    school: string | null;
    parentPhone?: string | null;
    notes?: string | null;
  };
  enrollments: EnrollmentOption[];
}

interface AccountingDraft {
  category: "accounting";
  studentName: string | null;
  /** null = 원장이 금액을 안 적음. 고른 반의 수강료로 채운 뒤에야 저장할 수 있다. */
  amount: number | null;
  type: PaymentType;
  paymentMonth: string;
  method: PaymentMethod | null;
  memo: string | null;
}

/** 학생·교사 정보를 고치거나 교사를 새로 넣는 초안 */
interface PersonDraft {
  category: "person";
  target: "student" | "teacher";
  action: "create" | "update";
  name: string | null;
  school: string | null;
  grade: string | null;
  phone: string | null;
  subject: string | null;
  notes: string | null;
}

interface ContactDraft {
  category: "contact";
  /** 통화 중 입력을 위해 비어 있을 수 있다. 저장 전에 여기서 채운다. */
  phone: string | null;
  guardianName: string | null;
  studentName: string | null;
  studentGrade: string | null;
  status: ConsultationStatus;
  subject: string | null;
  followUp: string | null;
  memo: string | null;
  dueDay: number | null;
  startDate: string | null; // YYYY-MM-DD
}

/** 등록과 동시에 받은 돈. 수강 등록이 만들어진 뒤 그 enrollmentId에 붙는다. */
interface PaymentPart {
  amount: number;
  type: PaymentType;
  method: PaymentMethod | null;
  paymentMonth: string;
}

interface RegistrationDraft {
  category: "registration";
  studentName: string | null;
  school: string | null;
  grade: string | null;
  /** 없으면 null — 원장이 여기서 채운다. 없다고 등록을 막지 않는다. */
  parentPhone: string | null;
  guardianName: string | null;
  classHint: { scheduleDays: string[] | null; teacherName: string | null; level: string | null };
  startDate: string | null;
  dueDay: number | null;
  payment: PaymentPart | null;
  subject: string | null;
  memo: string | null;
}

interface ClassOption {
  id: string;
  name: string;
  subject: string;
  defaultTuition: number;
}

interface TeacherOption {
  id: string;
  name: string;
  subject: string;
  phone: string | null;
  isActive: boolean;
}

/**
 * 반 자체를 만들거나 고치는 초안. 학생이 아니라 시간표를 건드린다.
 * 서버 ClassDraft(server/lib/nlpParser.ts)와 짝을 이룬다.
 */
interface ClassDraft {
  category: "class";
  action: "create" | "update";
  classHint: { scheduleDays: string[] | null; teacherName: string | null; level: string | null };
  name: string | null;
  subject: string | null;
  schedule: string | null;
  teacherName: string | null;
  defaultTuition: number | null;
  maxStudents: number | null;
  memo: string | null;
}

/** 이름만 친 경우. 저장할 것이 없고 학생 상태만 보여준다. */
interface LookupDraft {
  category: "lookup";
  name: string;
}

/** 퇴근전 할 일. 날짜는 서버가 오늘(KST)로 채워 온다. */
interface TaskDraft {
  category: "task";
  title: string;
  dueDate: string;
  slot: "퇴근전" | "출근전";
}

interface UnclearDraft {
  category: "unclear";
  reason: string;
  question: string;
}

interface ParseResponse {
  draft:
    | AccountingDraft
    | RegistrationDraft
    | ContactDraft
    | ClassDraft
    | PersonDraft
    | LookupDraft
    | TaskDraft
    | UnclearDraft;
  sourceText: string;
  corrections: string[];
  studentMatches: StudentMatch[];
  /** 원문에 반 이름이 있으면 서버가 실제 반 목록과 대조해 찾아준 결과 */
  classMatch: { id: string; name: string } | null;
  /** 요일·강사로 좁혔지만 하나로 확정되지 않은 반들 */
  classCandidates?: Array<{ id: string; name: string }>;
  /** 문장 속 강사 이름을 실제 강사와 대조해 찾은 결과 (반 초안일 때만) */
  teacherMatch?: { id: string; name: string } | null;
  /** 교사 수정 초안에서 고칠 수 있는 교사 후보들 */
  teacherMatches?: Array<{ id: string; name: string; subject: string; phone: string | null }>;
}

const EXAMPLES = [
  "정재현",
  "수찬이 7월 납부",
  "김민 수납",
  "김민준 35만원 이번달 원비 카드 결제",
  "정재현 숭의중1 등록 결제 28만 정우석 선생님 화 목 심화",
  "010-1234-5678 박서연 어머니 중2 영어 문의",
  "중등심화반 신설 정우석 선생님 화목 19:00-21:00 수강료 35만 정원 15명",
  "퇴근전 김민준 어머니 전화드리기",
  "학생 수정 김민준 학교 숭의중으로",
  "교사 추가 박지훈 수학 010-1111-2222",
];

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 수정 대상의 현재 값을 초안의 빈 칸에 채운다.
 *
 * 초안에서 null은 "문장에 언급이 없었다"는 뜻이다. 그 자리를 지금 저장된 값으로
 * 메워 두면 원장이 화면에서 바뀌는 항목과 그대로인 항목을 한눈에 비교할 수 있고,
 * 저장할 때 언급 없던 항목이 빈 값으로 지워지지도 않는다.
 */
function fillFromStudent(draft: any, s: StudentMatch["student"]) {
  draft.name = draft.name ?? s.name;
  draft.school = draft.school ?? s.school;
  draft.grade = draft.grade ?? s.grade;
  draft.phone = draft.phone ?? s.parentPhone ?? null;
  draft.notes = draft.notes ?? s.notes ?? null;
}

function fillFromTeacher(draft: any, t: { name: string; subject: string; phone: string | null }) {
  draft.name = draft.name ?? t.name;
  draft.subject = draft.subject ?? t.subject;
  draft.phone = draft.phone ?? t.phone;
}

export default function QuickInput() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  // 초안을 원장이 수정할 수 있도록 별도 상태로 복사해 둔다
  const [draft, setDraft] = useState<any>(null);
  const [enrollmentId, setEnrollmentId] = useState<string>("");
  // 최종등록으로 저장할 때 새로 만들 수강 등록이 들어갈 반
  const [classId, setClassId] = useState<string>("");
  // 같은 이름의 학생이 이미 있을 때, 새로 만들지 않고 그 학생에 붙이려면 여기에 id가 들어간다
  const [existingStudentId, setExistingStudentId] = useState<string>("");
  // 반 초안에서 고른 담당 강사. classes.teacherId가 NOT NULL이라 반드시 있어야 한다.
  const [teacherId, setTeacherId] = useState<string>("");
  // 이름만 쳐서 조회했을 때 원장이 고른 학생. 동명이인이면 비어 있다.
  const [lookupStudentId, setLookupStudentId] = useState<string>("");
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();

  const { data: classes = [] } = useQuery<ClassOption[]>({ queryKey: ["/api/classes"] });
  const { data: teachers = [] } = useQuery<TeacherOption[]>({ queryKey: ["/api/teachers"] });

  const parseMutation = useMutation({
    mutationFn: async (input: string) => {
      const res = await apiRequest("POST", "/api/nlp/parse", { text: input });
      return (await res.json()) as ParseResponse;
    },
    onSuccess: (data) => {
      setParsed(data);
      // 등록일은 enrollments.startDate가 NOT NULL이라 반드시 있어야 한다.
      // 원장이 등록 직후에 적는 문장이므로 날짜가 없으면 오늘로 두고 화면에서 보여준다.
      const d: any = { ...data.draft };
      if (d.category === "registration" && !d.startDate) d.startDate = today();

      /*
        후보가 한 명으로 좁혀지고 그 학생이 듣는 반도 하나면 더 물어볼 것이 없다.
        바로 골라 두고, 금액을 안 적었으면 그 반의 수강료까지 채워 둔다.
        "김민 중2 수납"을 치면 확인 버튼 하나만 남는다는 뜻이다.
      */
      const all = (data.studentMatches ?? []).flatMap((m) => m.enrollments);
      const only = all.length === 1 ? all[0] : null;
      setEnrollmentId(only?.id ?? "");
      if (d.category === "accounting" && d.amount == null && only) {
        d.amount = only.tuition ?? only.defaultTuition;
      }

      // 문장에 반 이름을 적었으면 미리 골라둔다 ("김민준 초등A반 등록")
      setClassId(data.classMatch?.id ?? "");
      // 강사는 이름이 정확히 하나로 맞을 때만 서버가 알려준다. 애매하면 비워 두고 고르게 한다.
      setTeacherId(data.teacherMatch?.id ?? "");
      setExistingStudentId("");

      // 조회는 후보가 한 명이면 고르는 단계를 건너뛰고 바로 카드를 펼친다
      const matches = data.studentMatches ?? [];
      setLookupStudentId(
        d.category === "lookup" && matches.length === 1 ? matches[0].student.id : ""
      );

      // 정보 수정 대상이 한 명뿐이면 바로 고르고, 현재 값을 폼에 채워 둔다
      if (d.category === "person") {
        const students = data.studentMatches ?? [];
        if (d.target === "student" && students.length === 1) {
          setExistingStudentId(students[0].student.id);
          fillFromStudent(d, students[0].student);
        }
        const found = data.teacherMatches ?? [];
        if (d.target === "teacher" && d.action === "update" && found.length === 1) {
          setTeacherId(found[0].id);
          fillFromTeacher(d, found[0]);
        }
      }

      setDraft(d);
    },
    onError: (err: Error) => {
      toast({
        title: "분석 실패",
        description: err.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      // 학생·교사 정보 수정
      if (draft.category === "person") {
        if (draft.target === "student") {
          await apiRequest("PUT", `/api/students/${existingStudentId}`, {
            name: draft.name,
            school: draft.school,
            grade: draft.grade,
            parentPhone: draft.phone,
            notes: draft.notes,
          });
          return { personSaved: "학생 정보를 수정했습니다" };
        }
        const body = { name: draft.name, subject: draft.subject, phone: draft.phone };
        if (draft.action === "create") {
          await apiRequest("POST", "/api/teachers", body);
          return { personSaved: "교사를 추가했습니다" };
        }
        await apiRequest("PUT", `/api/teachers/${teacherId}`, body);
        return { personSaved: "교사 정보를 수정했습니다" };
      }

      // 반 생성·수정 — 학생 데이터는 건드리지 않는다.
      if (draft.category === "class") {
        const body = {
          name: draft.name,
          subject: draft.subject,
          schedule: draft.schedule,
          teacherId,
          defaultTuition: draft.defaultTuition,
          maxStudents: draft.maxStudents,
        };
        if (draft.action === "update") {
          // 수정은 화면에서 실제로 채워진 항목만 보낸다.
          // 빈 칸까지 보내면 문장에 없던 값이 기본값으로 덮어써진다.
          const patch = Object.fromEntries(
            Object.entries(body).filter(([, v]) => v !== null && v !== "")
          );
          await apiRequest("PUT", `/api/classes/${classId}`, patch);
        } else {
          await apiRequest("POST", "/api/classes", { ...body, maxStudents: body.maxStudents ?? 20 });
        }
        return { enrolled: false, classSaved: true };
      }

      // 퇴근전 할 일 — 날짜는 초안이 이미 오늘(또는 내일)로 들고 있다.
      if (draft.category === "task") {
        await apiRequest("POST", "/api/tasks", {
          title: draft.title,
          dueDate: draft.dueDate,
          slot: draft.slot,
          sourceText: parsed?.sourceText ?? null,
        });
        return { taskSaved: true };
      }

      if (draft.category === "accounting") {
        await apiRequest("POST", "/api/payments", {
          enrollmentId: enrollmentId || null,
          amount: draft.amount,
          type: draft.type,
          method: draft.method,
          paymentMonth: draft.paymentMonth,
          paidDate: new Date().toISOString(),
          notes: draft.memo,
          sourceText: parsed?.sourceText ?? null,
        });
        return { enrolled: false };
      }

      // 등록 — 학생 → 수강 등록 → (있으면) 수납 순서로 만든다.
      // payments.enrollmentId가 필수라 순서를 뒤집을 수 없다.
      if (draft.category === "registration") {
        let sid = existingStudentId;
        if (!sid) {
          const res = await apiRequest("POST", "/api/students", {
            name: draft.studentName,
            school: draft.school,
            grade: draft.grade,
            parentPhone: draft.parentPhone,
            notes: draft.memo,
          });
          sid = (await res.json()).id as string;
        }

        // tuition을 비워두면 반의 기본 수강료가 그대로 적용된다
        const enRes = await apiRequest("POST", "/api/enrollments", {
          studentId: sid,
          classId,
          startDate: draft.startDate,
          dueDay: draft.dueDay ?? 8,
        });
        const newEnrollmentId = (await enRes.json()).id as string;

        if (draft.payment) {
          await apiRequest("POST", "/api/payments", {
            enrollmentId: newEnrollmentId,
            amount: draft.payment.amount,
            type: draft.payment.type,
            method: draft.payment.method,
            paymentMonth: draft.payment.paymentMonth,
            paidDate: new Date().toISOString(),
            notes: draft.memo,
            sourceText: parsed?.sourceText ?? null,
          });
        }
        return { enrolled: true };
      }

      // 최종등록은 상담 기록만 남기고 끝내지 않는다. 학생과 수강 등록을 실제로 만들어야
      // 학생 목록에 뜨고, 납부 기준일이 미납 계산에 반영된다.
      let studentId: string | null = null;
      if (draft.status === "최종등록") {
        const res = await apiRequest("POST", "/api/students", {
          name: draft.studentName,
          grade: draft.studentGrade,
          parentPhone: draft.phone,
          notes: draft.memo,
        });
        studentId = (await res.json()).id as string;

        // tuition을 비워두면 반의 기본 수강료가 그대로 적용된다
        await apiRequest("POST", "/api/enrollments", {
          studentId,
          classId,
          startDate: draft.startDate,
          dueDay: draft.dueDay ?? 8,
        });
      }

      await apiRequest("POST", "/api/consultations", {
        phone: draft.phone,
        guardianName: draft.guardianName,
        studentName: draft.studentName,
        studentGrade: draft.studentGrade,
        status: draft.status,
        subject: draft.subject,
        followUp: draft.followUp,
        memo: draft.memo,
        sourceText: parsed?.sourceText ?? null,
        studentId,
        classId: studentId ? classId : null,
      });
      return { enrolled: studentId !== null };
    },
    onSuccess: (result: any) => {
      toast({
        title:
          result?.personSaved ??
          (result?.taskSaved
            ? "할 일에 추가했습니다"
            : result?.classSaved
              ? "반 정보가 저장되었습니다"
              : result?.enrolled
                ? "학생 등록까지 완료되었습니다"
                : "저장되었습니다"),
      });
      qc.invalidateQueries({ queryKey: ["/api/tasks"] });
      qc.invalidateQueries({ queryKey: ["/api/teachers"] });
      qc.invalidateQueries({ queryKey: ["/api/payments"] });
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      qc.invalidateQueries({ queryKey: ["/api/students"] });
      qc.invalidateQueries({ queryKey: ["/api/enrollments"] });
      qc.invalidateQueries({ queryKey: ["/api/classes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/students"] });
      reset();
    },
    onError: (err: Error) => {
      toast({
        title: "저장 실패",
        description: err.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      });
    },
  });

  const reset = () => {
    setText("");
    setParsed(null);
    setDraft(null);
    setEnrollmentId("");
    setClassId("");
    setExistingStudentId("");
    setTeacherId("");
    setLookupStudentId("");
  };

  const matches = parsed?.studentMatches ?? [];
  const matchedStudent = matches[0];
  const teacherMatches = parsed?.teacherMatches ?? [];
  const classCandidates = parsed?.classCandidates ?? [];

  /** 한 학생이 두 반을 들으면 줄이 두 개 나온다. 화면에서는 이 줄 단위로 고른다. */
  const pickEnrollment = (id: string) => {
    setEnrollmentId(id);
    // 금액을 안 적었으면 고른 반의 수강료로 채운다. 이미 적었으면 건드리지 않는다.
    const en = matches.flatMap((m) => m.enrollments).find((e) => e.id === id);
    if (en && draft?.category === "accounting" && draft.amount == null) {
      setDraft({ ...draft, amount: en.tuition ?? en.defaultTuition });
    }
  };

  const pickStudentToEdit = (id: string) => {
    setExistingStudentId(id);
    const m = matches.find((x) => x.student.id === id);
    if (!m) return;
    const next = { ...draft };
    fillFromStudent(next, m.student);
    setDraft(next);
  };

  const pickTeacherToEdit = (id: string) => {
    setTeacherId(id);
    const t = teacherMatches.find((x) => x.id === id);
    if (!t) return;
    const next = { ...draft };
    fillFromTeacher(next, t);
    setDraft(next);
  };

  const needsEnrollment =
    draft?.category === "accounting" && (draft.type === "원비" || draft.type === "환불");
  // 최종등록이면 학생·수강 등록을 만들어야 하므로 반과 등록일이 반드시 있어야 한다
  const isFinalRegistration = draft?.category === "contact" && draft.status === "최종등록";
  const activeTeachers = teachers.filter((t) => t.isActive);
  // 새 반은 classes 테이블의 NOT NULL 컬럼(이름·과목·일정·수강료·강사)이 모두 차야 만들 수 있다.
  const canSaveClass =
    draft?.category === "class" &&
    (draft.action === "update"
      ? !!classId
      : !!draft.name &&
        !!draft.subject &&
        !!draft.schedule &&
        !!draft.defaultTuition &&
        !!teacherId);
  // 수정은 "누구를" 고르지 않으면 저장할 수 없다. 교사 추가만 대상 없이 진행된다.
  const canSavePerson =
    draft?.category === "person" &&
    !!draft.name &&
    (draft.target === "student"
      ? !!existingStudentId
      : draft.action === "create"
        ? !!draft.subject
        : !!teacherId && !!draft.subject);
  const canSave =
    draft &&
    draft.category !== "unclear" &&
    // 조회는 보여주기만 한다. 저장할 대상 자체가 없다.
    draft.category !== "lookup" &&
    (draft.category !== "task" || !!draft.title.trim()) &&
    (draft.category !== "class" || canSaveClass) &&
    (draft.category !== "person" || canSavePerson) &&
    (draft.category !== "accounting" || draft.amount != null) &&
    // 상담·대기는 번호 없이도 폼이 열린다. 연락처가 곧 기록의 전부라 저장은 막는다.
    (draft.category !== "contact" || !!draft.phone) &&
    (!needsEnrollment || !!enrollmentId) &&
    (draft.category !== "registration" ||
      (!!classId && !!draft.startDate && !!draft.studentName)) &&
    (!isFinalRegistration || (!!classId && !!draft.startDate && !!draft.studentName));

  return (
    <Card data-testid="quick-input">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" />
          AI 입력
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) parseMutation.mutate(text.trim());
          }}
          className="flex gap-2"
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="예) 김민준 35만원 이번달 원비 계좌이체"
            maxLength={500}
            data-testid="quick-input-text"
          />
          <Button type="submit" disabled={!text.trim() || parseMutation.isPending}>
            {parseMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "분석"
            )}
          </Button>
        </form>

        {!parsed && (
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setText(ex)}
                className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
              >
                {ex}
              </button>
            ))}
          </div>
        )}

        {/* 코드가 AI 결과를 고친 내역 — 원장이 무엇이 바뀌었는지 알 수 있어야 한다 */}
        {parsed && parsed.corrections.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
            <div className="mb-1 flex items-center gap-1 font-medium text-amber-900 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4" />
              이렇게 해석했습니다
            </div>
            <ul className="ml-5 list-disc space-y-0.5 text-amber-800 dark:text-amber-300">
              {parsed.corrections.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}

        {/* 판단 불가 — 되묻기 */}
        {draft?.category === "unclear" && (
          <div className="rounded-md border bg-muted p-3 text-sm" data-testid="quick-input-unclear">
            <p className="font-medium">{draft.reason}</p>
            <p className="mt-1 text-muted-foreground">{draft.question}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={reset}>
              다시 입력
            </Button>
          </div>
        )}

        {/* 퇴근전 할 일 — 날짜는 오늘로 자동. 시점만 두 갈래로 고르게 한다. */}
        {draft?.category === "task" && (
          <div className="space-y-3 rounded-md border p-3" data-testid="quick-input-task">
            <div className="flex items-center justify-between gap-2">
              <Badge variant="secondary">할 일 · {draft.dueDate}</Badge>
              <Button variant="ghost" size="sm" onClick={reset}>
                다시 입력
              </Button>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="task-title">할 일</Label>
              <Input
                id="task-title"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                data-testid="input-task-title"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="task-due">날짜</Label>
                <Input
                  id="task-due"
                  type="date"
                  value={draft.dueDate}
                  onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                  data-testid="input-task-due"
                />
              </div>
              <div className="space-y-1.5">
                <Label>언제까지</Label>
                <div className="flex gap-2">
                  {(["퇴근전", "출근전"] as const).map((s) => (
                    <Button
                      key={s}
                      type="button"
                      variant={draft.slot === s ? "default" : "outline"}
                      size="sm"
                      className="flex-1"
                      onClick={() => setDraft({ ...draft, slot: s })}
                      data-testid={`button-task-slot-${s}`}
                    >
                      {s === "퇴근전" ? "퇴근 전" : "출근 전"}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 이름만 친 경우 — 학생 상태 조회 (저장할 것이 없다) */}
        {draft?.category === "lookup" && (
          <div className="space-y-3 rounded-md border p-3" data-testid="quick-input-lookup">
            <div className="flex items-center justify-between gap-2">
              <Badge variant="secondary">학생 조회 · {draft.name}</Badge>
              <Button variant="ghost" size="sm" onClick={reset}>
                다시 입력
              </Button>
            </div>

            {matches.length === 0 && (
              <p className="text-sm text-muted-foreground">
                "{draft.name}" 과 이름이 겹치는 학생을 찾지 못했습니다.
              </p>
            )}

            {/* 동명이인이거나 부분 일치가 여럿이면 먼저 한 명을 고르게 한다 */}
            {matches.length > 1 && (
              <div className="space-y-1.5">
                <Label>{matches.length}명이 검색되었습니다. 한 명을 고르세요</Label>
                {matches.map((m) => (
                  <button
                    key={m.student.id}
                    type="button"
                    onClick={() => setLookupStudentId(m.student.id)}
                    className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                      lookupStudentId === m.student.id
                        ? "border-primary bg-primary/5"
                        : "hover:bg-accent"
                    }`}
                    data-testid={`quick-input-lookup-pick-${m.student.id}`}
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{m.student.name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {[m.student.school, m.student.grade].filter(Boolean).join(" ") || "학교·학년 미입력"}
                      </span>
                    </span>
                    {lookupStudentId === m.student.id && (
                      <Check className="h-4 w-4 shrink-0 text-primary" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {(() => {
              const picked = matches.find((m) => m.student.id === lookupStudentId);
              if (!picked) return null;
              return (
                <div className="space-y-3 rounded-md border bg-muted/40 p-3">
                  <div>
                    <p className="text-base font-semibold">{picked.student.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {[picked.student.school, picked.student.grade].filter(Boolean).join(" ") ||
                        "학교·학년 미입력"}
                    </p>
                  </div>

                  <div className="grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <p className="text-xs text-muted-foreground">학부모 연락처</p>
                      <p className="font-medium">{picked.student.parentPhone || "미입력"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">수강 중인 반</p>
                      <p className="font-medium">
                        {picked.enrollments.length === 0
                          ? "없음"
                          : picked.enrollments.map((e) => e.className).join(", ")}
                      </p>
                    </div>
                  </div>

                  {picked.enrollments.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground">이번 달 수납</p>
                      {picked.enrollments.map((en) => (
                        <div
                          key={en.id}
                          className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{en.className}</span>
                            <span className="text-xs text-muted-foreground">
                              {(en.tuition ?? en.defaultTuition).toLocaleString()}원
                              {en.dueDay ? ` · 매월 ${en.dueDay}일` : ""}
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <Badge variant={en.paidThisMonth ? "secondary" : "destructive"}>
                              {en.paidThisMonth ? "납부완료" : "미납"}
                            </Badge>
                            {en.paidThisMonth && (
                              <span className="mt-0.5 block text-xs text-muted-foreground">
                                {en.paidDate
                                  ? `${new Date(en.paidDate).toLocaleDateString("ko-KR", {
                                      month: "numeric",
                                      day: "numeric",
                                    })} 결제`
                                  : "결제일 미상"}
                                {en.paidAmount ? ` · ${en.paidAmount.toLocaleString()}원` : ""}
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {picked.student.notes && (
                    <p className="text-xs text-muted-foreground">메모: {picked.student.notes}</p>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLocation(`/students/edit/${picked.student.id}`)}
                    data-testid="quick-input-lookup-edit"
                  >
                    학생 정보 열기
                  </Button>
                </div>
              );
            })()}
          </div>
        )}

        {/* 수납 초안 확인 폼 */}
        {draft?.category === "accounting" && (
          <div className="space-y-3 rounded-md border p-3" data-testid="quick-input-accounting">
            <Badge variant="secondary">수납/회계</Badge>

            {/*
              누구의 수납인지가 첫 결정이라 금액보다 위에 둔다.
              후보가 여럿이면 눌러서 고르고, 하나면 이미 골라져 있어 확인만 하면 된다.
            */}
            {needsEnrollment && (
              <div>
                <Label>학생 / 반</Label>
                {matches.length === 0 && (
                  <p className="text-sm text-destructive">
                    "{draft.studentName}" 로 찾은 재원생이 없습니다. 이름을 다시 확인해주세요.
                  </p>
                )}
                {matches.length > 1 && (
                  <p className="mb-1 text-xs text-amber-700 dark:text-amber-400">
                    {matches.length}명이 검색되었습니다. 누구인지 골라주세요.
                  </p>
                )}
                <div className="mt-1 space-y-1.5">
                  {matches.flatMap((m: StudentMatch) =>
                    m.enrollments.map((en) => {
                      const picked = enrollmentId === en.id;
                      return (
                        <button
                          key={en.id}
                          type="button"
                          onClick={() => pickEnrollment(en.id)}
                          className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                            picked ? "border-primary bg-primary/5" : "hover:bg-accent"
                          }`}
                          data-testid={`quick-input-enrollment-${en.id}`}
                        >
                          <span className="min-w-0">
                            <span className="font-medium">{m.student.name}</span>
                            {m.student.grade && (
                              <span className="ml-1 text-xs text-muted-foreground">
                                {m.student.grade}
                              </span>
                            )}
                            <span className="block truncate text-xs text-muted-foreground">
                              {en.className}
                              {m.student.school ? ` · ${m.student.school}` : ""}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="text-sm font-semibold">
                              {(en.tuition ?? en.defaultTuition).toLocaleString()}원
                            </span>
                            {picked && <Check className="h-4 w-4 text-primary" />}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
                {matchedStudent && matches.every((m) => m.enrollments.length === 0) && (
                  <p className="mt-1 text-sm text-destructive">
                    이 학생은 활성 수강 등록이 없습니다. 먼저 반에 등록해주세요.
                  </p>
                )}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>금액</Label>
                <Input
                  type="number"
                  value={draft.amount ?? ""}
                  placeholder="반을 고르면 수강료가 채워집니다"
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      amount: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {draft.amount == null
                    ? "금액을 채워야 저장할 수 있습니다"
                    : draft.amount < 0
                      ? "환불·지출이므로 음수입니다"
                      : `${draft.amount.toLocaleString()}원`}
                </p>
              </div>

              <div>
                <Label>종류</Label>
                <Select
                  value={draft.type}
                  onValueChange={(v: PaymentType) => {
                    // 종류를 바꾸면 부호도 같이 맞춰준다
                    const magnitude = draft.amount == null ? null : Math.abs(draft.amount);
                    const signed =
                      magnitude == null
                        ? null
                        : v === "환불" || v === "지출"
                          ? -magnitude
                          : magnitude;
                    setDraft({ ...draft, type: v, amount: signed });
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(["원비", "환불", "지출", "기타"] as PaymentType[]).map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>납부월</Label>
                <Input
                  value={draft.paymentMonth}
                  placeholder="YYYY-MM"
                  onChange={(e) => setDraft({ ...draft, paymentMonth: e.target.value })}
                />
              </div>

              <div>
                <Label>결제수단</Label>
                <Select
                  value={draft.method ?? "미지정"}
                  onValueChange={(v) => setDraft({ ...draft, method: v === "미지정" ? null : v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="미지정">미지정</SelectItem>
                    {(["계좌이체", "카드", "현금"] as PaymentMethod[]).map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label>메모</Label>
              <Input
                value={draft.memo ?? ""}
                onChange={(e) => setDraft({ ...draft, memo: e.target.value || null })}
              />
            </div>
          </div>
        )}

        {/* 등록 초안 확인 폼 — 저장하면 학생·수강 등록(+수납)이 함께 생성된다 */}
        {draft?.category === "registration" && (
          <div className="space-y-3 rounded-md border p-3" data-testid="quick-input-registration">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">신규 등록</Badge>
              {draft.payment && <Badge variant="secondary">결제 동시</Badge>}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>학생명</Label>
                <Input
                  value={draft.studentName ?? ""}
                  onChange={(e) => setDraft({ ...draft, studentName: e.target.value || null })}
                />
                {!draft.studentName && (
                  <p className="mt-1 text-xs text-destructive">학생명이 있어야 등록할 수 있습니다</p>
                )}
              </div>
              <div>
                <Label>학교</Label>
                <Input
                  value={draft.school ?? ""}
                  onChange={(e) => setDraft({ ...draft, school: e.target.value || null })}
                  placeholder="예) 숭의중"
                />
              </div>
              <div>
                <Label>학년</Label>
                <Input
                  value={draft.grade ?? ""}
                  onChange={(e) => setDraft({ ...draft, grade: e.target.value || null })}
                  placeholder="예) 1학년"
                />
              </div>
              <div>
                {/* 문장에 번호가 없는 것은 흔한 일이다. 빈칸으로 두고 여기서 바로 채운다. */}
                <Label>학부모 연락처</Label>
                <Input
                  value={draft.parentPhone ?? ""}
                  onChange={(e) => setDraft({ ...draft, parentPhone: e.target.value || null })}
                  placeholder="010-0000-0000 (없으면 비워두세요)"
                  data-testid="quick-input-parent-phone"
                />
              </div>
              <div className="sm:col-span-2">
                <Label>메모</Label>
                <Input
                  value={draft.memo ?? ""}
                  onChange={(e) => setDraft({ ...draft, memo: e.target.value || null })}
                />
              </div>
            </div>

            {/* 같은 이름이 이미 있으면 중복 생성을 막을 기회를 준다 */}
            {matches.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm dark:bg-amber-950/30">
                <p className="mb-1 font-medium text-amber-900 dark:text-amber-200">
                  같은 이름의 학생이 이미 {matches.length}명 있습니다
                </p>
                <Select
                  value={existingStudentId || "new"}
                  onValueChange={(v) => setExistingStudentId(v === "new" ? "" : v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="new">새 학생으로 만들기</SelectItem>
                    {matches.map((m: StudentMatch) => (
                      <SelectItem key={m.student.id} value={m.student.id}>
                        기존 학생에 반 추가 — {m.student.name}
                        {m.student.school ? ` · ${m.student.school}` : ""}
                        {m.student.grade ? ` ${m.student.grade}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label>반</Label>
                {classes.length === 0 ? (
                  <p className="text-sm text-destructive">
                    등록된 반이 없습니다. 반을 먼저 만들어주세요.
                  </p>
                ) : (
                  <Select value={classId} onValueChange={setClassId}>
                    <SelectTrigger>
                      <SelectValue placeholder="반을 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      {classes.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} · {c.subject} · {c.defaultTuition.toLocaleString()}원
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {/* 요일·강사·레벨로 좁혔지만 하나로 확정되지 않은 경우 */}
                {!classId && classCandidates.length > 1 && (
                  <p className="mt-1 text-xs text-amber-700">
                    문장의 요일·강사로 {classCandidates.map((c) => c.name).join(", ")} 까지
                    좁혔습니다. 어느 반인지 골라주세요.
                  </p>
                )}
                {!classId && classCandidates.length === 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    문장만으로는 반을 특정하지 못했습니다.
                  </p>
                )}
              </div>

              <div>
                <Label>등록일</Label>
                <Input
                  type="date"
                  value={draft.startDate ?? ""}
                  onChange={(e) => setDraft({ ...draft, startDate: e.target.value || null })}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  미납 개월 수를 세는 기준입니다
                </p>
              </div>

              <div>
                <Label>납부 기준일 (매월)</Label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={draft.dueDay ?? ""}
                  placeholder="비우면 8일"
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    setDraft({
                      ...draft,
                      dueDay: Number.isInteger(n) && n >= 1 && n <= 31 ? n : null,
                    });
                  }}
                />
              </div>
            </div>

            {/* 등록과 동시에 받은 돈 */}
            {draft.payment && (
              <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">이 등록과 함께 수납도 기록합니다</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDraft({ ...draft, payment: null })}
                  >
                    수납 빼기
                  </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <Label>금액</Label>
                    <Input
                      type="number"
                      value={draft.payment.amount}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          payment: { ...draft.payment, amount: Number(e.target.value) },
                        })
                      }
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      {draft.payment.amount.toLocaleString()}원
                    </p>
                  </div>

                  <div>
                    <Label>납부월</Label>
                    <Input
                      value={draft.payment.paymentMonth}
                      placeholder="YYYY-MM"
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          payment: { ...draft.payment, paymentMonth: e.target.value },
                        })
                      }
                    />
                  </div>

                  <div>
                    <Label>결제수단</Label>
                    <Select
                      value={draft.payment.method ?? "미지정"}
                      onValueChange={(v) =>
                        setDraft({
                          ...draft,
                          payment: { ...draft.payment, method: v === "미지정" ? null : v },
                        })
                      }
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="미지정">미지정</SelectItem>
                        {(["계좌이체", "카드", "현금"] as PaymentMethod[]).map((m) => (
                          <SelectItem key={m} value={m}>{m}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 상담 초안 확인 폼 */}
        {draft?.category === "contact" && (
          <div className="space-y-3 rounded-md border p-3" data-testid="quick-input-contact">
            <Badge variant="secondary">상담/문의</Badge>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>연락처</Label>
                <Input
                  value={draft.phone ?? ""}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value || null })}
                  placeholder="010-0000-0000"
                  autoFocus={!draft.phone}
                  data-testid="quick-input-contact-phone"
                />
                {!draft.phone && (
                  <p className="mt-1 text-xs text-destructive">
                    연락처를 입력해야 저장할 수 있습니다
                  </p>
                )}
              </div>
              <div>
                <Label>상태</Label>
                <Select
                  value={draft.status}
                  onValueChange={(v: ConsultationStatus) => setDraft({ ...draft, status: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(["상담문의", "대기등록", "최종등록", "보류"] as ConsultationStatus[]).map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>보호자명</Label>
                <Input
                  value={draft.guardianName ?? ""}
                  onChange={(e) => setDraft({ ...draft, guardianName: e.target.value || null })}
                />
              </div>
              <div>
                <Label>학생명</Label>
                <Input
                  value={draft.studentName ?? ""}
                  onChange={(e) => setDraft({ ...draft, studentName: e.target.value || null })}
                />
              </div>
              <div>
                <Label>학년</Label>
                <Input
                  value={draft.studentGrade ?? ""}
                  onChange={(e) => setDraft({ ...draft, studentGrade: e.target.value || null })}
                />
              </div>
              <div>
                <Label>과목</Label>
                <Input
                  value={draft.subject ?? ""}
                  onChange={(e) => setDraft({ ...draft, subject: e.target.value || null })}
                />
              </div>
              <div className="sm:col-span-2">
                <Label>후속 조치</Label>
                <Input
                  value={draft.followUp ?? ""}
                  onChange={(e) => setDraft({ ...draft, followUp: e.target.value || null })}
                  placeholder="예) 다음주 화요일 재통화"
                />
              </div>
              <div className="sm:col-span-2">
                <Label>메모</Label>
                <Input
                  value={draft.memo ?? ""}
                  onChange={(e) => setDraft({ ...draft, memo: e.target.value || null })}
                />
              </div>
            </div>

            {/* 최종등록이면 상담 기록에 그치지 않고 학생·수강 등록까지 만든다 */}
            {isFinalRegistration && (
              <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
                <p className="text-sm font-medium">
                  저장하면 학생과 수강 등록이 함께 생성됩니다
                </p>

                {!draft.studentName && (
                  <p className="text-sm text-destructive">
                    학생명이 비어 있습니다. 위에서 학생명을 입력해주세요.
                  </p>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Label>반</Label>
                    {classes.length === 0 ? (
                      <p className="text-sm text-destructive">
                        등록된 반이 없습니다. 반을 먼저 만들어주세요.
                      </p>
                    ) : (
                      <Select value={classId} onValueChange={setClassId}>
                        <SelectTrigger>
                          <SelectValue placeholder="반을 선택하세요" />
                        </SelectTrigger>
                        <SelectContent>
                          {classes.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name} · {c.subject} · {c.defaultTuition.toLocaleString()}원
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  <div>
                    <Label>등록일</Label>
                    <Input
                      type="date"
                      value={draft.startDate ?? ""}
                      onChange={(e) => setDraft({ ...draft, startDate: e.target.value || null })}
                    />
                    {!draft.startDate && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        미납 개월 수를 세는 기준이라 반드시 필요합니다
                      </p>
                    )}
                  </div>

                  <div>
                    <Label>납부 기준일 (매월)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={draft.dueDay ?? ""}
                      placeholder="비우면 8일"
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        setDraft({
                          ...draft,
                          dueDay: Number.isInteger(n) && n >= 1 && n <= 31 ? n : null,
                        });
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 반 생성·수정 초안 확인 폼 */}
        {draft?.category === "class" && (
          <div className="space-y-3 rounded-md border p-3" data-testid="quick-input-class">
            <Badge variant="secondary">
              {draft.action === "update" ? "반 수정" : "반 개설"}
            </Badge>

            {/* 수정은 대상 반을 잘못 고르면 엉뚱한 시간표가 바뀐다. 반드시 사람이 확인한다. */}
            {draft.action === "update" && (
              <div>
                <Label>수정할 반</Label>
                {classes.length === 0 ? (
                  <p className="text-sm text-destructive">등록된 반이 없습니다.</p>
                ) : (
                  <Select value={classId} onValueChange={setClassId}>
                    <SelectTrigger data-testid="quick-input-class-target">
                      <SelectValue placeholder="반을 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      {classes.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} · {c.subject}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {classCandidates.length > 1 && !classId && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    후보가 여러 개입니다: {classCandidates.map((c) => c.name).join(", ")}
                  </p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  아래에서 비워 둔 항목은 지금 값 그대로 둡니다
                </p>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>반 이름</Label>
                <Input
                  value={draft.name ?? ""}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value || null })}
                  placeholder="예) 중등심화반"
                />
              </div>
              <div>
                <Label>과목</Label>
                <Input
                  value={draft.subject ?? ""}
                  onChange={(e) => setDraft({ ...draft, subject: e.target.value || null })}
                  placeholder="예) 영어"
                />
              </div>
              <div>
                <Label>담당 강사</Label>
                {activeTeachers.length === 0 ? (
                  <p className="text-sm text-destructive">
                    등록된 강사가 없습니다. 강사를 먼저 등록해주세요.
                  </p>
                ) : (
                  <Select value={teacherId} onValueChange={setTeacherId}>
                    <SelectTrigger data-testid="quick-input-class-teacher">
                      <SelectValue placeholder="강사를 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      {activeTeachers.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name} · {t.subject}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {draft.teacherName && !teacherId && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    "{draft.teacherName}" 과 일치하는 강사를 찾지 못했습니다
                  </p>
                )}
              </div>
              <div>
                <Label>수업 일정</Label>
                <Input
                  value={draft.schedule ?? ""}
                  onChange={(e) => setDraft({ ...draft, schedule: e.target.value || null })}
                  placeholder="예) 화목 19:00-21:00"
                />
              </div>
              <div>
                <Label>수강료</Label>
                <Input
                  type="number"
                  value={draft.defaultTuition ?? ""}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    setDraft({ ...draft, defaultTuition: Number.isFinite(n) ? n : null });
                  }}
                />
                {draft.defaultTuition != null && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {draft.defaultTuition.toLocaleString()}원
                  </p>
                )}
              </div>
              <div>
                <Label>정원</Label>
                <Input
                  type="number"
                  min={1}
                  value={draft.maxStudents ?? ""}
                  placeholder="비우면 20명"
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    setDraft({ ...draft, maxStudents: Number.isFinite(n) && n > 0 ? n : null });
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* 학생·교사 정보 수정 폼 — 알아들은 값은 채워져 있고, 나머지는 현재 값 그대로다 */}
        {draft?.category === "person" && (
          <div className="space-y-3 rounded-md border p-3" data-testid="quick-input-person">
            <Badge variant="secondary">
              {draft.target === "student"
                ? "학생 정보 수정"
                : draft.action === "create"
                  ? "교사 추가"
                  : "교사 정보 수정"}
            </Badge>

            {/* 대상 고르기 — 후보가 하나면 이미 골라져 있다 */}
            {draft.target === "student" && (
              <div>
                <Label>수정할 학생</Label>
                {matches.length === 0 ? (
                  <p className="text-sm text-destructive">
                    "{draft.name ?? ""}" 로 찾은 재원생이 없습니다.
                  </p>
                ) : (
                  <div className="mt-1 space-y-1.5">
                    {matches.map((m: StudentMatch) => {
                      const picked = existingStudentId === m.student.id;
                      return (
                        <button
                          key={m.student.id}
                          type="button"
                          onClick={() => pickStudentToEdit(m.student.id)}
                          className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                            picked ? "border-primary bg-primary/5" : "hover:bg-accent"
                          }`}
                          data-testid={`quick-input-person-student-${m.student.id}`}
                        >
                          <span className="min-w-0">
                            <span className="font-medium">{m.student.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {[m.student.grade, m.student.school, m.enrollments[0]?.className]
                                .filter(Boolean)
                                .join(" · ") || "정보 없음"}
                            </span>
                          </span>
                          {picked && <Check className="h-4 w-4 shrink-0 text-primary" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {draft.target === "teacher" && draft.action === "update" && (
              <div>
                <Label>수정할 교사</Label>
                {teacherMatches.length === 0 ? (
                  <p className="text-sm text-destructive">
                    "{draft.name ?? ""}" 로 찾은 교사가 없습니다.
                  </p>
                ) : (
                  <Select value={teacherId} onValueChange={pickTeacherToEdit}>
                    <SelectTrigger data-testid="quick-input-person-teacher">
                      <SelectValue placeholder="교사를 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      {teacherMatches.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name} · {t.subject}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>이름</Label>
                <Input
                  value={draft.name ?? ""}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value || null })}
                />
              </div>

              {draft.target === "student" ? (
                <>
                  <div>
                    <Label>학년</Label>
                    <Input
                      value={draft.grade ?? ""}
                      onChange={(e) => setDraft({ ...draft, grade: e.target.value || null })}
                      placeholder="예) 중2"
                    />
                  </div>
                  <div>
                    <Label>학교</Label>
                    <Input
                      value={draft.school ?? ""}
                      onChange={(e) => setDraft({ ...draft, school: e.target.value || null })}
                    />
                  </div>
                  <div>
                    <Label>학부모 연락처</Label>
                    <Input
                      value={draft.phone ?? ""}
                      onChange={(e) => setDraft({ ...draft, phone: e.target.value || null })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>메모</Label>
                    <Input
                      value={draft.notes ?? ""}
                      onChange={(e) => setDraft({ ...draft, notes: e.target.value || null })}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <Label>담당 과목</Label>
                    <Input
                      value={draft.subject ?? ""}
                      onChange={(e) => setDraft({ ...draft, subject: e.target.value || null })}
                      placeholder="예) 수학"
                    />
                  </div>
                  <div>
                    <Label>연락처</Label>
                    <Input
                      value={draft.phone ?? ""}
                      onChange={(e) => setDraft({ ...draft, phone: e.target.value || null })}
                    />
                  </div>
                </>
              )}
            </div>

            {/* 반 배정·수강료처럼 여기서 못 다루는 항목은 원래 화면으로 보낸다 */}
            {draft.target === "student" && existingStudentId && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocation(`/students/edit/${existingStudentId}`)}
                data-testid="quick-input-person-more"
              >
                반·수강료까지 수정하기
              </Button>
            )}
          </div>
        )}

        {draft && draft.category !== "unclear" && draft.category !== "lookup" && (
          <div className="flex gap-2">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!canSave || saveMutation.isPending}
              data-testid="quick-input-save"
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1 h-4 w-4" />
              )}
              확인 후 저장
            </Button>
            <Button variant="outline" onClick={reset}>
              <X className="mr-1 h-4 w-4" />
              취소
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
