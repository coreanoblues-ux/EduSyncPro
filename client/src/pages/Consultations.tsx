/**
 * 상담/문의 목록
 *
 * AI 입력으로 저장한 상담 기록이 여기 쌓인다.
 * 상담문의 → 대기등록 → 최종등록으로 이어지는 흐름을 이 화면에서 끝낼 수 있도록,
 * 목록에서 바로 학생·수강 등록을 만드는 "학생으로 등록"을 함께 둔다.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Phone, Search, Trash2, UserPlus, CalendarClock, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Consultation, Class } from "@shared/schema";

type Status =
  | "상담문의"
  | "레벨테스트예정"
  | "레벨테스트완료"
  | "반배정상담"
  | "대기등록"
  | "최종등록"
  | "보류";

const STATUSES: Status[] = [
  "상담문의",
  "레벨테스트예정",
  "레벨테스트완료",
  "반배정상담",
  "대기등록",
  "최종등록",
  "보류",
];

/**
 * 목록에 쌓이는 순서. 실제 상담 흐름 순서대로 배치한다.
 * (상담문의 → 레벨테스트예정 → 레벨테스트완료 → 반배정상담 → 대기/최종 → 보류)
 * 각 단계에서 사람이 새지 않게 원장이 대시보드에서 바로 볼 수 있어야 매출 손실이 줄어든다.
 */
const GROUP_ORDER: Status[] = [
  "상담문의",
  "레벨테스트예정",
  "레벨테스트완료",
  "반배정상담",
  "대기등록",
  "최종등록",
  "보류",
];

const GROUP_HINT: Record<Status, string> = {
  상담문의: "연락은 왔지만 아직 아무것도 정해지지 않은 건",
  레벨테스트예정: "테스트 일정이 잡힌 건 — 하루 전에 확인 연락 필요",
  레벨테스트완료: "결과가 나온 건 — 반배정 상담을 잡아야 함",
  반배정상담: "결과를 놓고 반을 정하는 중",
  대기등록: "자리가 나면 등록하기로 한 건",
  최종등록: "등록이 끝난 건 — 7일이 지나면 목록에서 사라집니다",
  보류: "진행이 멈춘 건",
};

/**
 * 최종등록이 목록에 남아 있는 기간(일).
 *
 * 등록이 끝나도 며칠은 보여야 원장이 "이번 주에 누가 들어왔지"를 확인할 수 있다.
 * 그 뒤로는 학생 관리에서 보면 되므로 상담 목록에서 치운다. 데이터는 그대로 있고
 * 화면에서만 감춘다.
 */
const FINAL_VISIBLE_DAYS = 7;

function daysSince(value: string | Date, now: number): number {
  return (now - new Date(value).getTime()) / (1000 * 60 * 60 * 24);
}

const STATUS_STYLE: Record<Status, string> = {
  상담문의: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  레벨테스트예정: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  레벨테스트완료: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  반배정상담: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  대기등록: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  최종등록: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  보류: "bg-muted text-muted-foreground",
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDate(value: string | Date): string {
  const d = new Date(value);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

interface ConsultationsProps {
  userRole: "owner" | "teacher" | "superadmin";
}

export default function Consultations({ userRole }: ConsultationsProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showStale, setShowStale] = useState(false);
  const [enrollTarget, setEnrollTarget] = useState<Consultation | null>(null);
  const [form, setForm] = useState({ name: "", grade: "", classId: "", startDate: today(), dueDay: "8" });

  // 레벨테스트 예약/기록 다이얼로그. 하나의 대화상자가 "예약"과 "결과 기록" 두 모드로 동작한다.
  // 상담문의 → 레벨테스트예정: 날짜만 잡는다.
  // 레벨테스트예정 → 레벨테스트완료: 점수·메모·추천반을 입력한다.
  const [levelTestTarget, setLevelTestTarget] = useState<Consultation | null>(null);
  const [ltForm, setLtForm] = useState({
    date: "",
    score: "",
    notes: "",
    recommendedClassId: "",
  });
  const ltMode: "schedule" | "record" = levelTestTarget?.status === "레벨테스트예정" ? "record" : "schedule";

  // 메모/후속조치/과목 수정 다이얼로그. 원장이 각 단계에서 상담 내용을 직접 다듬을 수 있게 한다.
  const [editTarget, setEditTarget] = useState<Consultation | null>(null);
  const [editForm, setEditForm] = useState({ subject: "", followUp: "", memo: "" });

  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: consultations = [], isLoading } = useQuery<Consultation[]>({
    queryKey: ["/api/consultations"],
  });
  const { data: classes = [] } = useQuery<Class[]>({ queryKey: ["/api/classes"] });

  const counts = useMemo(() => {
    const acc: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const c of consultations) acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, [consultations]);

  // 7일이 지난 최종등록. 감춰 두되 몇 건인지는 알려주고 펼쳐 볼 수 있게 한다.
  const staleFinal = useMemo(() => {
    const now = Date.now();
    return consultations.filter(
      (c) => c.status === "최종등록" && daysSince(c.updatedAt, now) > FINAL_VISIBLE_DAYS
    );
  }, [consultations]);

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const staleIds = new Set(staleFinal.map((c) => c.id));

    const matched = consultations
      .filter((c) => statusFilter === "all" || c.status === statusFilter)
      .filter((c) => showStale || !staleIds.has(c.id))
      .filter((c) => {
        if (!term) return true;
        return [c.studentName, c.guardianName, c.phone, c.subject, c.memo]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term));
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return GROUP_ORDER.map((status) => ({
      status,
      items: matched.filter((c) => c.status === status),
    })).filter((g) => g.items.length > 0);
  }, [consultations, search, statusFilter, showStale, staleFinal]);

  const visibleCount = groups.reduce((sum, g) => sum + g.items.length, 0);

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: Status }) => {
      await apiRequest("PATCH", `/api/consultations/${id}`, { status });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
    },
    onError: (err: Error) => {
      toast({ title: "상태 변경 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/consultations/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      toast({ title: "상담 기록이 삭제되었습니다" });
    },
    onError: (err: Error) => {
      toast({ title: "삭제 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const levelTestMutation = useMutation({
    mutationFn: async ({ id, mode }: { id: string; mode: "schedule" | "record" }) => {
      if (mode === "schedule") {
        // datetime-local 값은 로컬 시각으로 해석된다. 서버는 timestamp(without tz)에 그대로 저장한다.
        await apiRequest("PATCH", `/api/consultations/${id}`, {
          status: "레벨테스트예정",
          levelTestDate: ltForm.date ? new Date(ltForm.date).toISOString() : null,
        });
      } else {
        await apiRequest("PATCH", `/api/consultations/${id}`, {
          status: "레벨테스트완료",
          levelTestScore: ltForm.score.trim() || null,
          levelTestNotes: ltForm.notes.trim() || null,
          recommendedClassId: ltForm.recommendedClassId || null,
        });
      }
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      setLevelTestTarget(null);
      toast({
        title: vars.mode === "schedule" ? "레벨테스트 일정이 저장되었습니다" : "레벨테스트 결과가 저장되었습니다",
      });
    },
    onError: (err: Error) => {
      toast({ title: "저장 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async (id: string) => {
      // 빈 문자열은 null로 보내 원본이 지워지도록 한다. 원장이 의도적으로 비우는 경우가 있음.
      await apiRequest("PATCH", `/api/consultations/${id}`, {
        subject: editForm.subject.trim() || null,
        followUp: editForm.followUp.trim() || null,
        memo: editForm.memo.trim() || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      setEditTarget(null);
      toast({ title: "상담 내용이 저장되었습니다" });
    },
    onError: (err: Error) => {
      toast({ title: "저장 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const openEdit = (c: Consultation) => {
    setEditForm({
      subject: c.subject ?? "",
      followUp: c.followUp ?? "",
      memo: c.memo ?? "",
    });
    setEditTarget(c);
  };

  const openLevelTest = (c: Consultation) => {
    // 예약 모드: 현재 값을 기본으로 (yyyy-MM-ddTHH:mm)
    let dateVal = "";
    if (c.levelTestDate) {
      const d = new Date(c.levelTestDate);
      dateVal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    setLtForm({
      date: dateVal,
      score: c.levelTestScore ?? "",
      notes: c.levelTestNotes ?? "",
      recommendedClassId: c.recommendedClassId ?? "",
    });
    setLevelTestTarget(c);
  };

  const enrollMutation = useMutation({
    mutationFn: async (consultation: Consultation) => {
      const res = await apiRequest("POST", "/api/students", {
        name: form.name.trim(),
        grade: form.grade.trim() || null,
        parentPhone: consultation.phone,
        notes: consultation.memo,
      });
      const student = await res.json();

      // tuition을 비우면 반의 기본 수강료가 적용된다
      await apiRequest("POST", "/api/enrollments", {
        studentId: student.id,
        classId: form.classId,
        startDate: form.startDate,
        dueDay: Number(form.dueDay) || 8,
      });

      // 상담 기록을 만들어진 학생에 연결해 둬야 나중에 어디서 온 학생인지 알 수 있다
      await apiRequest("PATCH", `/api/consultations/${consultation.id}`, {
        status: "최종등록",
        studentId: student.id,
        classId: form.classId,
        studentName: form.name.trim(),
        studentGrade: form.grade.trim() || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      qc.invalidateQueries({ queryKey: ["/api/students"] });
      qc.invalidateQueries({ queryKey: ["/api/enrollments"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard/students"] });
      setEnrollTarget(null);
      toast({ title: "학생 등록이 완료되었습니다", description: "학생 관리 화면에서 확인할 수 있습니다." });
    },
    onError: (err: Error) => {
      toast({ title: "등록 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const openEnroll = (c: Consultation) => {
    setForm({
      name: c.studentName ?? "",
      grade: c.studentGrade ?? "",
      classId: c.classId ?? "",
      startDate: today(),
      dueDay: "8",
    });
    setEnrollTarget(c);
  };

  const canEnroll = !!form.name.trim() && !!form.classId && !!form.startDate;
  const canEdit = userRole === "owner" || userRole === "teacher";

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold">상담 관리</h1>
        <div className="text-center py-8 text-muted-foreground">상담 기록을 불러오는 중...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6" data-testid="consultations-page">
      <div>
        <h1 className="text-2xl font-bold">상담 관리</h1>
        <p className="text-muted-foreground">
          AI 입력으로 저장한 상담·문의 {consultations.length}건
        </p>
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
        {STATUSES.map((s) => (
          <Card key={s} className="hover-elevate">
            <CardContent className="pt-4 pb-4 text-center">
              <div className="text-xl font-bold">{counts[s] ?? 0}</div>
              <p className="text-xs text-muted-foreground">{s}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="이름, 연락처, 과목으로 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-consultation-search"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40" data-testid="select-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 상태</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {staleFinal.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            등록된 지 {FINAL_VISIBLE_DAYS}일이 지난 최종등록 {staleFinal.length}건은 목록에서
            숨겼습니다. 학생 관리에는 그대로 있습니다.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowStale((v) => !v)}
            data-testid="button-toggle-stale-final"
          >
            {showStale ? "다시 숨기기" : "숨긴 건 보기"}
          </Button>
        </div>
      )}

      {visibleCount === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <div className="text-lg font-medium">
            {consultations.length === 0 ? "아직 상담 기록이 없습니다" : "조건에 맞는 상담이 없습니다"}
          </div>
          <p className="text-muted-foreground mt-2">
            {consultations.length === 0
              ? "대시보드의 AI 입력에 «010-1234-5678 김민준 중2 영어 문의»처럼 적어보세요."
              : "검색어나 상태 필터를 바꿔보세요."}
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
          <section key={group.status} className="space-y-4" data-testid={`consultation-group-${group.status}`}>
            <div className="flex items-baseline gap-2 border-b pb-2">
              <h2 className="text-lg font-semibold">{group.status}</h2>
              <span className="text-sm text-muted-foreground">{group.items.length}건</span>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                · {GROUP_HINT[group.status]}
              </span>
            </div>
          {group.items.map((c) => (
            <Card key={c.id} className="hover-elevate" data-testid={`consultation-card-${c.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-lg">{c.studentName || c.guardianName || "이름 미기재"}</CardTitle>
                    <Badge className={STATUS_STYLE[c.status as Status]} variant="outline">
                      {c.status}
                    </Badge>
                    {c.studentGrade && <Badge variant="secondary">{c.studentGrade}</Badge>}
                    {c.subject && <Badge variant="outline">{c.subject}</Badge>}
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                    <a href={`tel:${c.phone}`} className="flex items-center gap-1 hover:underline">
                      <Phone className="h-4 w-4" />
                      {c.phone}
                    </a>
                    {c.guardianName && c.studentName && <span>보호자 {c.guardianName}</span>}
                    <span>{formatDate(c.createdAt)}</span>
                  </div>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-2">
                    <Select
                      value={c.status}
                      onValueChange={(v) => statusMutation.mutate({ id: c.id, status: v as Status })}
                    >
                      <SelectTrigger className="w-32" data-testid={`select-status-${c.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          // 최종등록은 학생·수강 등록을 만들어야 하므로 상태만 바꾸게 두지 않는다
                          <SelectItem key={s} value={s} disabled={s === "최종등록" && !c.studentId}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openEdit(c)}
                      title="상담 내용 수정"
                      data-testid={`button-edit-${c.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {userRole === "owner" && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => deleteMutation.mutate(c.id)}
                        data-testid={`button-delete-${c.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {c.followUp && (
                  <div className="flex items-start gap-2 text-sm">
                    <CalendarClock className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <span>{c.followUp}</span>
                  </div>
                )}
                {c.memo && <p className="text-sm text-muted-foreground">{c.memo}</p>}

                {(c.levelTestDate || c.levelTestScore || c.levelTestNotes || c.recommendedClassId) && (
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">레벨테스트</div>
                    {c.levelTestDate && (
                      <div>일정: {new Date(c.levelTestDate).toLocaleString("ko-KR")}</div>
                    )}
                    {c.levelTestScore && <div>결과: {c.levelTestScore}</div>}
                    {c.levelTestNotes && <div className="text-muted-foreground">{c.levelTestNotes}</div>}
                    {c.recommendedClassId && (
                      <div>추천반: {classes.find((k) => k.id === c.recommendedClassId)?.name ?? "(삭제된 반)"}</div>
                    )}
                  </div>
                )}

                {c.sourceText && (
                  <p className="text-xs text-muted-foreground/70 border-l-2 pl-2">입력: {c.sourceText}</p>
                )}

                {canEdit && (() => {
                  const showLevelTest = c.status === "상담문의" || c.status === "레벨테스트예정";
                  const showEnroll = !c.studentId;
                  if (!showLevelTest && !showEnroll) return null;
                  return (
                    <div className="pt-3 border-t flex flex-wrap gap-2">
                      {showLevelTest && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openLevelTest(c)}
                          data-testid={`button-level-test-${c.id}`}
                        >
                          <CalendarClock className="h-4 w-4 mr-2" />
                          {c.status === "레벨테스트예정" ? "레벨테스트 결과 기록" : "레벨테스트 예약"}
                        </Button>
                      )}
                      {showEnroll && (
                        <Button size="sm" variant="outline" onClick={() => openEnroll(c)} data-testid={`button-enroll-${c.id}`}>
                          <UserPlus className="h-4 w-4 mr-2" />
                          학생으로 등록
                        </Button>
                      )}
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          ))}
          </section>
          ))}
        </div>
      )}

      <Dialog open={!!enrollTarget} onOpenChange={(open) => !open && setEnrollTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>학생으로 등록</DialogTitle>
            <DialogDescription>
              학생과 수강 등록을 함께 만듭니다. 저장하면 학생 목록에 바로 나타나고, 납부 기준일부터 미납 계산이 시작됩니다.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>학생 이름</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  data-testid="input-enroll-name"
                />
              </div>
              <div className="space-y-2">
                <Label>학년</Label>
                <Input
                  value={form.grade}
                  placeholder="중2"
                  onChange={(e) => setForm({ ...form, grade: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>반</Label>
              <Select value={form.classId} onValueChange={(v) => setForm({ ...form, classId: v })}>
                <SelectTrigger data-testid="select-enroll-class">
                  <SelectValue placeholder="반을 선택하세요" />
                </SelectTrigger>
                <SelectContent>
                  {classes.filter((c) => c.isActive !== false).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} · {c.subject} · {c.defaultTuition.toLocaleString()}원
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {classes.length === 0 && (
                <p className="text-xs text-destructive">반이 없습니다. 먼저 «반» 화면에서 반을 만들어주세요.</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>등록일</Label>
                <Input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  data-testid="input-enroll-start-date"
                />
              </div>
              <div className="space-y-2">
                <Label>납부 기준일 (매월)</Label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={form.dueDay}
                  onChange={(e) => setForm({ ...form, dueDay: e.target.value })}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEnrollTarget(null)}>
              취소
            </Button>
            <Button
              onClick={() => enrollTarget && enrollMutation.mutate(enrollTarget)}
              disabled={!canEnroll || enrollMutation.isPending}
              data-testid="button-confirm-enroll"
            >
              {enrollMutation.isPending ? "등록 중..." : "등록하기"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!levelTestTarget} onOpenChange={(open) => !open && setLevelTestTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {ltMode === "record" ? "레벨테스트 결과 기록" : "레벨테스트 예약"}
            </DialogTitle>
            <DialogDescription>
              {ltMode === "record"
                ? "점수·메모·추천반을 남기면 상태가 «레벨테스트완료»로 넘어갑니다."
                : "일정을 잡으면 상태가 «레벨테스트예정»으로 바뀝니다."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {ltMode === "schedule" ? (
              <div className="space-y-2">
                <Label>레벨테스트 일시</Label>
                <Input
                  type="datetime-local"
                  value={ltForm.date}
                  onChange={(e) => setLtForm({ ...ltForm, date: e.target.value })}
                  data-testid="input-level-test-date"
                />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>점수 / 등급</Label>
                  <Input
                    placeholder="예: 85점, B+, 초급 상위 등"
                    value={ltForm.score}
                    onChange={(e) => setLtForm({ ...ltForm, score: e.target.value })}
                    data-testid="input-level-test-score"
                  />
                </div>
                <div className="space-y-2">
                  <Label>메모</Label>
                  <Input
                    placeholder="예: 문법 약함, 회화 좋음"
                    value={ltForm.notes}
                    onChange={(e) => setLtForm({ ...ltForm, notes: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>추천반 (선택)</Label>
                  <Select
                    value={ltForm.recommendedClassId || "none"}
                    onValueChange={(v) => setLtForm({ ...ltForm, recommendedClassId: v === "none" ? "" : v })}
                  >
                    <SelectTrigger data-testid="select-recommended-class">
                      <SelectValue placeholder="반을 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">추천하지 않음</SelectItem>
                      {classes.filter((c) => c.isActive !== false).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} · {c.subject}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setLevelTestTarget(null)}>
              취소
            </Button>
            <Button
              onClick={() =>
                levelTestTarget && levelTestMutation.mutate({ id: levelTestTarget.id, mode: ltMode })
              }
              disabled={
                levelTestMutation.isPending ||
                (ltMode === "schedule" && !ltForm.date) ||
                (ltMode === "record" && !ltForm.score.trim())
              }
              data-testid="button-confirm-level-test"
            >
              {levelTestMutation.isPending ? "저장 중..." : "저장"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>상담 내용 수정</DialogTitle>
            <DialogDescription>
              {editTarget?.studentName || editTarget?.guardianName || "이름 미상"} · {editTarget?.status}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>문의 과목</Label>
              <Input
                value={editForm.subject}
                onChange={(e) => setEditForm({ ...editForm, subject: e.target.value })}
                placeholder="예: 영어, 수학"
                data-testid="input-edit-subject"
              />
            </div>
            <div className="space-y-2">
              <Label>후속 조치</Label>
              <Input
                value={editForm.followUp}
                onChange={(e) => setEditForm({ ...editForm, followUp: e.target.value })}
                placeholder="예: 다음주 화요일 재통화"
                data-testid="input-edit-follow-up"
              />
            </div>
            <div className="space-y-2">
              <Label>메모</Label>
              <Textarea
                value={editForm.memo}
                onChange={(e) => setEditForm({ ...editForm, memo: e.target.value })}
                rows={5}
                placeholder="상담 내용 메모"
                data-testid="input-edit-memo"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              취소
            </Button>
            <Button
              onClick={() => editTarget && editMutation.mutate(editTarget.id)}
              disabled={editMutation.isPending}
              data-testid="button-confirm-edit"
            >
              {editMutation.isPending ? "저장 중..." : "저장"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
