import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock,
  Check,
  ChevronsRight,
  Flame,
  ListChecks,
  Plus,
  Sunrise,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Task } from "@shared/schema";
import { addDays, daysBetween, todayKst } from "@shared/day";

/**
 * 퇴근전 할 일.
 *
 * 이 화면의 주인공은 "오늘 퇴근 전에 끝내야 하는 일"이다. 나머지(출근전·예정·완료)는
 * 곁다리라 작게 둔다. 미룬 일은 위로 올라오고, 미룰수록 색이 세진다.
 */

const SLOT_LABEL: Record<Task["slot"], string> = {
  퇴근전: "퇴근 전",
  출근전: "출근 전",
};

/** 며칠 밀렸는지에 따라 경고 강도를 올린다. 3일이면 눈에 아프게. */
function severity(daysLate: number) {
  if (daysLate >= 3) {
    return {
      level: 3,
      card: "border-red-500 bg-red-500/10 dark:bg-red-500/15",
      badge: "bg-red-600 text-white border-transparent",
      title: "text-red-700 dark:text-red-300",
    };
  }
  if (daysLate === 2) {
    return {
      level: 2,
      card: "border-orange-500 bg-orange-500/10 dark:bg-orange-500/15",
      badge: "bg-orange-500 text-white border-transparent",
      title: "text-orange-700 dark:text-orange-300",
    };
  }
  if (daysLate === 1) {
    return {
      level: 1,
      card: "border-amber-500 bg-amber-400/10 dark:bg-amber-500/15",
      badge: "bg-amber-500 text-white border-transparent",
      title: "text-amber-700 dark:text-amber-300",
    };
  }
  return { level: 0, card: "border-border bg-card", badge: "", title: "" };
}

export default function Todos() {
  const today = todayKst();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [newTitle, setNewTitle] = useState("");

  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["/api/tasks"] });

  const createTask = useMutation({
    mutationFn: async (title: string) =>
      (await apiRequest("POST", "/api/tasks", {
        title,
        dueDate: today,
        slot: "퇴근전",
      })).json(),
    onSuccess: () => {
      setNewTitle("");
      invalidate();
    },
    onError: (e: Error) =>
      toast({ title: "등록 실패", description: e.message, variant: "destructive" }),
  });

  const patchTask = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      (await apiRequest("PATCH", `/api/tasks/${id}`, body)).json(),
    onSuccess: () => invalidate(),
    onError: (e: Error) =>
      toast({ title: "변경 실패", description: e.message, variant: "destructive" }),
  });

  const removeTask = useMutation({
    mutationFn: async (id: string) => (await apiRequest("DELETE", `/api/tasks/${id}`)).json(),
    onSuccess: () => invalidate(),
    onError: (e: Error) =>
      toast({ title: "삭제 실패", description: e.message, variant: "destructive" }),
  });

  const groups = useMemo(() => {
    const open = tasks.filter((t) => !t.completedAt);
    const byDue = (a: Task, b: Task) => a.dueDate.localeCompare(b.dueDate);

    return {
      // 기한이 지난 일. 가장 오래 밀린 것이 맨 위로 온다.
      late: open.filter((t) => t.dueDate < today).sort(byDue),
      morning: open.filter((t) => t.dueDate === today && t.slot === "출근전").sort(byDue),
      evening: open.filter((t) => t.dueDate === today && t.slot === "퇴근전").sort(byDue),
      upcoming: open.filter((t) => t.dueDate > today).sort(byDue),
      done: tasks
        .filter((t) => t.completedAt && t.dueDate >= addDays(today, -1))
        .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt))),
    };
  }, [tasks, today]);

  const remaining = groups.late.length + groups.morning.length + groups.evening.length;

  function TaskRow({ task }: { task: Task }) {
    const daysLate = Math.max(daysBetween(task.dueDate, today), 0);
    const s = severity(daysLate);
    const done = !!task.completedAt;
    const busy = patchTask.isPending || removeTask.isPending;

    return (
      <div
        className={`flex items-start gap-3 rounded-lg border p-3 ${done ? "border-border bg-muted/40" : s.card}`}
        data-testid={`task-${task.id}`}
      >
        {/* 완료는 한 번의 큰 클릭으로. 이 화면에서 가장 자주 누르는 버튼이다. */}
        <button
          type="button"
          disabled={busy}
          onClick={() => patchTask.mutate({ id: task.id, body: { completed: !done } })}
          aria-label={done ? "완료 취소" : "완료"}
          data-testid={`button-complete-${task.id}`}
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
            done
              ? "border-emerald-600 bg-emerald-600 text-white"
              : "border-muted-foreground/40 text-transparent hover:border-emerald-600 hover:bg-emerald-600 hover:text-white"
          }`}
        >
          <Check className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`text-sm font-medium ${done ? "text-muted-foreground line-through" : s.title}`}
            >
              {task.title}
            </span>
            {daysLate > 0 && !done && (
              <Badge className={`gap-1 ${s.badge}`} data-testid={`badge-late-${task.id}`}>
                {s.level >= 3 && <Flame className="h-3 w-3" />}
                {daysLate}일 밀림
              </Badge>
            )}
            {task.deferCount > 0 && !done && (
              <Badge variant="outline" className="text-xs">
                {task.deferCount}번 미룸
              </Badge>
            )}
            {task.slot === "출근전" && !done && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <Sunrise className="h-3 w-3" />
                출근 전
              </Badge>
            )}
          </div>
          {task.notes && (
            <p className="mt-1 text-xs text-muted-foreground">{task.notes}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {task.dueDate} · {SLOT_LABEL[task.slot]}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!done && (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => patchTask.mutate({ id: task.id, body: { defer: "퇴근전" } })}
                data-testid={`button-defer-${task.id}`}
                title="내일 퇴근 전으로 미루기"
              >
                <ChevronsRight className="h-4 w-4" />
                <span className="ml-1 hidden sm:inline">하루 미루기</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => patchTask.mutate({ id: task.id, body: { defer: "출근전" } })}
                data-testid={`button-morning-${task.id}`}
                title="내일 출근 전(오후 4시 이전)에 하기"
              >
                <Sunrise className="h-4 w-4" />
                <span className="ml-1 hidden sm:inline">출근전 하기</span>
              </Button>
            </>
          )}
          {done && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => patchTask.mutate({ id: task.id, body: { completed: false } })}
              data-testid={`button-undo-${task.id}`}
            >
              <Undo2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => removeTask.mutate(task.id)}
            data-testid={`button-delete-${task.id}`}
          >
            <Trash2 className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </div>
    );
  }

  function Section({
    title,
    icon,
    tasks,
    tone,
    empty,
  }: {
    title: string;
    icon: React.ReactNode;
    tasks: Task[];
    tone?: string;
    empty?: string;
  }) {
    if (tasks.length === 0 && !empty) return null;
    return (
      <Card className={tone}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
            <Badge variant="secondary" className="ml-1">{tasks.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {tasks.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">{empty}</p>
          ) : (
            tasks.map((t) => <TaskRow key={t.id} task={t} />)
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 p-6" data-testid="page-todos">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ListChecks className="h-6 w-6" />
            퇴근전 할 일
          </h1>
          <p className="text-sm text-muted-foreground">
            {today} · 남은 일 {remaining}개
          </p>
        </div>
        {groups.late.length > 0 && (
          <Badge className="gap-1 bg-red-600 text-white" data-testid="badge-late-total">
            <Flame className="h-3 w-3" />
            밀린 일 {groups.late.length}개
          </Badge>
        )}
      </div>

      {/* 빠른 입력: 적으면 오늘 퇴근 전 할 일이 된다. 날짜는 물어보지 않는다. */}
      <Card>
        <CardContent className="flex gap-2 p-4">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newTitle.trim()) createTask.mutate(newTitle.trim());
            }}
            placeholder="퇴근 전에 할 일을 적어주세요 (예: 김민준 어머니 전화)"
            data-testid="input-new-task"
          />
          <Button
            onClick={() => newTitle.trim() && createTask.mutate(newTitle.trim())}
            disabled={!newTitle.trim() || createTask.isPending}
            data-testid="button-add-task"
          >
            <Plus className="h-4 w-4" />
            <span className="ml-1 hidden sm:inline">추가</span>
          </Button>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">불러오는 중...</p>
      ) : (
        <>
          <Section
            title="밀린 일"
            icon={<Flame className="h-4 w-4 text-red-600" />}
            tasks={groups.late}
            tone="border-red-500/60"
          />
          <Section
            title="오늘 출근 전"
            icon={<Sunrise className="h-4 w-4 text-amber-500" />}
            tasks={groups.morning}
          />
          <Section
            title="오늘 퇴근 전"
            icon={<AlarmClock className="h-4 w-4" />}
            tasks={groups.evening}
            empty="오늘 퇴근 전에 할 일이 없습니다."
          />
          <Section
            title="예정"
            icon={<ChevronsRight className="h-4 w-4" />}
            tasks={groups.upcoming}
          />
          <Section
            title="완료"
            icon={<Check className="h-4 w-4 text-emerald-600" />}
            tasks={groups.done}
          />
        </>
      )}
    </div>
  );
}
