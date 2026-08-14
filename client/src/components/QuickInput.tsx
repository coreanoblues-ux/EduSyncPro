/**
 * 자연어 한 줄 입력 (빠른 입력)
 *
 * 흐름: 문장 입력 → 서버가 초안 생성 → 원장이 확인·수정 → 저장
 *
 * ⚠️ 핵심 설계: 파싱 결과는 절대 자동 저장되지 않는다.
 *    AI가 학생 이름을 지어내거나 금액을 잘못 읽어도 저장 전에 사람이 막을 수 있어야 한다.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
}

interface StudentMatch {
  student: { id: string; name: string; grade: string | null; school: string | null };
  enrollments: EnrollmentOption[];
}

interface AccountingDraft {
  category: "accounting";
  studentName: string | null;
  amount: number;
  type: PaymentType;
  paymentMonth: string;
  method: PaymentMethod | null;
  memo: string | null;
}

interface ContactDraft {
  category: "contact";
  phone: string;
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

interface ClassOption {
  id: string;
  name: string;
  subject: string;
  defaultTuition: number;
}

interface UnclearDraft {
  category: "unclear";
  reason: string;
  question: string;
}

interface ParseResponse {
  draft: AccountingDraft | ContactDraft | UnclearDraft;
  sourceText: string;
  corrections: string[];
  studentMatches: StudentMatch[];
  /** 원문에 반 이름이 있으면 서버가 실제 반 목록과 대조해 찾아준 결과 */
  classMatch: { id: string; name: string } | null;
}

const EXAMPLES = [
  "010-1234-5678 김민준 중2 영어 등록, 기준일 13일, 8월 13일부터",
  "김민준 35만원 이번달 원비 카드 결제",
  "010-1234-5678 박서연 어머니 중2 영어 문의",
];

export default function QuickInput() {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  // 초안을 원장이 수정할 수 있도록 별도 상태로 복사해 둔다
  const [draft, setDraft] = useState<any>(null);
  const [enrollmentId, setEnrollmentId] = useState<string>("");
  // 최종등록으로 저장할 때 새로 만들 수강 등록이 들어갈 반
  const [classId, setClassId] = useState<string>("");
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: classes = [] } = useQuery<ClassOption[]>({ queryKey: ["/api/classes"] });

  const parseMutation = useMutation({
    mutationFn: async (input: string) => {
      const res = await apiRequest("POST", "/api/nlp/parse", { text: input });
      return (await res.json()) as ParseResponse;
    },
    onSuccess: (data) => {
      setParsed(data);
      setDraft({ ...data.draft });
      // 수강 등록이 딱 하나면 자동 선택, 여러 개면 원장이 직접 고르게 둔다
      const only = data.studentMatches?.[0];
      setEnrollmentId(
        only && only.enrollments.length === 1 ? only.enrollments[0].id : ""
      );
      // 문장에 반 이름을 적었으면 미리 골라둔다 ("김민준 초등A반 등록")
      setClassId(data.classMatch?.id ?? "");
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
    onSuccess: (result) => {
      toast({
        title: result?.enrolled ? "학생 등록까지 완료되었습니다" : "저장되었습니다",
      });
      qc.invalidateQueries({ queryKey: ["/api/payments"] });
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      qc.invalidateQueries({ queryKey: ["/api/students"] });
      qc.invalidateQueries({ queryKey: ["/api/enrollments"] });
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
  };

  const matches = parsed?.studentMatches ?? [];
  const matchedStudent = matches[0];
  const needsEnrollment =
    draft?.category === "accounting" && (draft.type === "원비" || draft.type === "환불");
  // 최종등록이면 학생·수강 등록을 만들어야 하므로 반과 등록일이 반드시 있어야 한다
  const isFinalRegistration = draft?.category === "contact" && draft.status === "최종등록";
  const canSave =
    draft &&
    draft.category !== "unclear" &&
    (!needsEnrollment || !!enrollmentId) &&
    (!isFinalRegistration || (!!classId && !!draft.startDate && !!draft.studentName));

  return (
    <Card data-testid="quick-input">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" />
          빠른 입력
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

        {/* 수납 초안 확인 폼 */}
        {draft?.category === "accounting" && (
          <div className="space-y-3 rounded-md border p-3" data-testid="quick-input-accounting">
            <Badge variant="secondary">수납/회계</Badge>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>금액</Label>
                <Input
                  type="number"
                  value={draft.amount}
                  onChange={(e) => setDraft({ ...draft, amount: Number(e.target.value) })}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  {draft.amount < 0 ? "환불·지출이므로 음수입니다" : `${draft.amount.toLocaleString()}원`}
                </p>
              </div>

              <div>
                <Label>종류</Label>
                <Select
                  value={draft.type}
                  onValueChange={(v: PaymentType) => {
                    // 종류를 바꾸면 부호도 같이 맞춰준다
                    const magnitude = Math.abs(draft.amount);
                    const signed = v === "환불" || v === "지출" ? -magnitude : magnitude;
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

            {needsEnrollment && (
              <div>
                <Label>학생 / 반</Label>
                {matches.length === 0 && (
                  <p className="text-sm text-destructive">
                    "{draft.studentName}" 이름의 재원생을 찾지 못했습니다. 학생 등록 여부를 확인해주세요.
                  </p>
                )}
                {matches.length > 1 && (
                  <p className="mb-1 text-xs text-amber-700">
                    동명이인 {matches.length}명이 있습니다. 반을 보고 골라주세요.
                  </p>
                )}
                {matches.length > 0 && (
                  <Select value={enrollmentId} onValueChange={setEnrollmentId}>
                    <SelectTrigger>
                      <SelectValue placeholder="수강 반을 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      {matches.flatMap((m: StudentMatch) =>
                        m.enrollments.map((en) => (
                          <SelectItem key={en.id} value={en.id}>
                            {m.student.name}
                            {m.student.grade ? ` (${m.student.grade})` : ""} · {en.className} ·{" "}
                            {(en.tuition ?? en.defaultTuition).toLocaleString()}원
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                )}
                {matchedStudent && matchedStudent.enrollments.length === 0 && (
                  <p className="mt-1 text-sm text-destructive">
                    이 학생은 활성 수강 등록이 없습니다. 먼저 반에 등록해주세요.
                  </p>
                )}
              </div>
            )}

            <div>
              <Label>메모</Label>
              <Input
                value={draft.memo ?? ""}
                onChange={(e) => setDraft({ ...draft, memo: e.target.value || null })}
              />
            </div>
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
                  value={draft.phone}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                />
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

        {draft && draft.category !== "unclear" && (
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
