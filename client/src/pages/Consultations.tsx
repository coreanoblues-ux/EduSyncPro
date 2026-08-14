/**
 * 상담/문의 목록
 *
 * AI 입력으로 저장한 상담 기록이 여기 쌓인다.
 * 상담문의 → 대기등록 → 최종등록으로 이어지는 흐름을 이 화면에서 끝낼 수 있도록,
 * 목록에서 바로 학생·수강 등록을 만드는 "학생으로 등록"을 함께 둔다.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Phone, Search, Trash2, UserPlus, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

type Status = "상담문의" | "대기등록" | "최종등록" | "보류";

const STATUSES: Status[] = ["상담문의", "대기등록", "최종등록", "보류"];

/**
 * 목록에 쌓이는 순서. 원장이 처리해야 할 급한 것부터 위로 올린다.
 * 최종등록은 이미 끝난 건이라 맨 아래에 두고, 보류는 그 뒤에 붙인다.
 */
const GROUP_ORDER: Status[] = ["상담문의", "대기등록", "최종등록", "보류"];

const GROUP_HINT: Record<Status, string> = {
  상담문의: "연락은 왔지만 아직 아무것도 정해지지 않은 건",
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

  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: consultations = [], isLoading } = useQuery<Consultation[]>({
    queryKey: ["/api/consultations"],
  });
  const { data: classes = [] } = useQuery<Class[]>({ queryKey: ["/api/classes"] });

  const counts = useMemo(() => {
    const acc: Record<string, number> = { 상담문의: 0, 대기등록: 0, 최종등록: 0, 보류: 0 };
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

      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        {STATUSES.map((s) => (
          <Card key={s} className="hover-elevate">
            <CardContent className="pt-6 text-center">
              <div className="text-2xl font-bold">{counts[s] ?? 0}</div>
              <p className="text-sm text-muted-foreground">{s}</p>
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
                {c.sourceText && (
                  <p className="text-xs text-muted-foreground/70 border-l-2 pl-2">입력: {c.sourceText}</p>
                )}

                {canEdit && !c.studentId && (
                  <div className="pt-3 border-t">
                    <Button size="sm" variant="outline" onClick={() => openEnroll(c)} data-testid={`button-enroll-${c.id}`}>
                      <UserPlus className="h-4 w-4 mr-2" />
                      학생으로 등록
                    </Button>
                  </div>
                )}
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
    </div>
  );
}
