/**
 * 프로젝트 스케쥴러
 *
 * 원장이 여기서 하는 일은 사실상 하나다 — **D-day 하나를 넣고, 준비가 밀렸는지 본다.**
 * 그래서 카드가 보여 주는 것도 그 두 가지뿐이다: 며칠 남았나, 준비가 몇 개 밀렸나.
 * 장소·예산 같은 건 적어 두면 보이고, 안 적으면 줄이 아예 생기지 않는다.
 *
 * 탭 넷(설명회·광고 / 신규반 형성 / 신규학생 모집 / 교차수업)은 **같은 projects 테이블**을
 * kind 로 갈라 본 것이다. 테이블을 넷으로 나누지 않은 이유: 넷 다 하는 일이 똑같다
 * (D-day → 역산 할 일 → 진행률). 나눠 두면 나중에 다섯 번째가 생길 때마다 테이블·API·화면을
 * 통째로 복사해야 한다. 마지막 탭(대기 학생)만 성격이 달라 기존 waiters 를 그대로 읽는다.
 *
 * 준비 할 일 목록은 이 화면에 펼치지 않는다. 할 일은 `/todos` 한 곳에서만 본다 —
 * 두 곳에 같은 체크박스가 있으면 어디서 체크했는지 헷갈려 결국 둘 다 못 믿게 된다.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  CalendarDays,
  Flame,
  ListChecks,
  MessageSquare,
  Phone,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  UserPlus,
  Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { taskSeverity } from "@/lib/tasks";
import { SCHEDULER_TABS, type Class, type Project, type ProjectKind, type Task, type Waiter } from "@shared/schema";
import { daysBetween, todayKst } from "@shared/day";

/** 비어 있는 칸은 서버에 null 로 보낸다. 빈 문자열을 넣으면 화면에 빈 줄이 생긴다. */
function orNull(s: string): string | null {
  const v = s.trim();
  return v === "" ? null : v;
}

/** 탭마다 D-day 가 가리키는 날이 다르다. 잘못 넣으면 역산 전체가 어긋난다. */
const DDAY_HINT: Record<string, string> = {
  promo: "설명회·광고를 하는 날",
  newclass: "개강일 (모집 마감일이 아닙니다)",
  cross: "첫 수업일",
};

type FormState = {
  name: string;
  kind: ProjectKind;
  dDay: string;
  place: string;
  partner: string;
  budget: string;
  notes: string;
};

export default function Scheduler() {
  const today = todayKst();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<string>(SCHEDULER_TABS[0].key);
  const [form, setForm] = useState<FormState | null>(null);

  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ["/api/projects"],
  });

  /*
    할 일은 프로젝트별로 따로 묻지 않고 테넌트 전체를 한 번 받아 와서 묶는다.
    프로젝트가 10개여도 요청은 1개다. 게다가 이 쿼리는 /todos 와 캐시를 공유하므로
    할 일을 깔고 /todos 로 넘어가면 이미 받아져 있다.
  */
  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/api/projects"] });
    qc.invalidateQueries({ queryKey: ["/api/tasks"] });
  };

  const createProject = useMutation({
    mutationFn: async (f: FormState) =>
      (
        await apiRequest("POST", "/api/projects", {
          name: f.name.trim(),
          kind: f.kind,
          dDay: f.dDay,
          place: orNull(f.place),
          partner: orNull(f.partner),
          budget: f.budget.trim() === "" ? null : Number(f.budget),
          notes: orNull(f.notes),
        })
      ).json(),
    // 만들자마자 역산 할 일까지 깔아 준다. 두 번 누르게 할 이유가 없다 —
    // 프로젝트만 있고 준비 할 일이 없는 상태는 원장에게 아무 쓸모가 없다.
    onSuccess: async (project: Project) => {
      setForm(null);
      try {
        const r = await apiRequest("POST", `/api/projects/${project.id}/generate-tasks`, {});
        const { created } = await r.json();
        toast({
          title: "프로젝트를 만들었습니다",
          description: `준비 할 일 ${created}개가 날짜별로 깔렸습니다. 퇴근전 할일에서 보입니다.`,
        });
      } catch (e) {
        // 템플릿이 없는 종류는 여기서 걸린다. 프로젝트는 이미 만들어졌으니 실패로 치지 않는다.
        toast({
          title: "프로젝트는 만들었습니다",
          description: `준비 할 일은 못 깔았습니다 — ${(e as Error).message}`,
        });
      }
      invalidate();
    },
    onError: (e: Error) =>
      toast({ title: "등록 실패", description: e.message, variant: "destructive" }),
  });

  const regenerate = useMutation({
    mutationFn: async (id: string) =>
      (await apiRequest("POST", `/api/projects/${id}/generate-tasks`, { replace: true })).json(),
    onSuccess: ({ created }: { created: number }) => {
      invalidate();
      toast({
        title: "다시 깔았습니다",
        description: `${created}개를 새 날짜로 옮겼습니다. 이미 완료한 준비는 그대로 둡니다.`,
      });
    },
    onError: (e: Error) =>
      toast({ title: "실패", description: e.message, variant: "destructive" }),
  });

  const removeProject = useMutation({
    mutationFn: async (id: string) => (await apiRequest("DELETE", `/api/projects/${id}`)).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "삭제했습니다", description: "딸린 준비 할 일도 함께 사라졌습니다." });
    },
    onError: (e: Error) =>
      toast({ title: "삭제 실패", description: e.message, variant: "destructive" }),
  });

  /** 프로젝트별 준비 현황. 밀린 날수의 최대값으로 카드 색을 정한다. */
  const stats = useMemo(() => {
    const map = new Map<string, { total: number; done: number; late: number; maxLate: number }>();
    for (const t of tasks) {
      if (!t.projectId) continue;
      const s = map.get(t.projectId) ?? { total: 0, done: 0, late: 0, maxLate: 0 };
      s.total++;
      if (t.completedAt) s.done++;
      else if (t.dueDate < today) {
        s.late++;
        s.maxLate = Math.max(s.maxLate, daysBetween(t.dueDate, today));
      }
      map.set(t.projectId, s);
    }
    return map;
  }, [tasks, today]);

  /** 탭별 밀린 준비 개수. 다른 탭에 불난 걸 모르고 지나치지 않도록 탭 머리에 숫자를 띄운다. */
  const lateByTab = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of SCHEDULER_TABS) {
      const kinds = new Set<string>(t.kinds);
      m.set(
        t.key,
        projects
          .filter((p) => kinds.has(p.kind))
          .reduce((n, p) => n + (stats.get(p.id)?.late ?? 0), 0)
      );
    }
    return m;
  }, [projects, stats]);

  function ProjectCard({ project }: { project: Project }) {
    const s = stats.get(project.id) ?? { total: 0, done: 0, late: 0, maxLate: 0 };
    const left = daysBetween(today, project.dDay);
    const tone = taskSeverity(s.maxLate);
    const busy = regenerate.isPending || removeProject.isPending;

    return (
      <Card className={s.late > 0 ? tone.card : undefined} data-testid={`project-${project.id}`}>
        <CardHeader className="pb-3">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <span className="font-semibold">{project.name}</span>
            <Badge variant="outline" className="text-xs">{project.kind}</Badge>
            {left === 0 ? (
              <Badge className="bg-emerald-600 text-white">오늘</Badge>
            ) : left > 0 ? (
              <Badge variant={left <= 7 ? "default" : "secondary"}>D-{left}</Badge>
            ) : (
              <Badge variant="secondary" className="text-muted-foreground">
                {-left}일 지남
              </Badge>
            )}
            {s.late > 0 && (
              <Badge className={`gap-1 ${tone.badge}`} data-testid={`badge-late-${project.id}`}>
                <Flame className="h-3 w-3" />
                준비 {s.late}개 밀림
              </Badge>
            )}
          </CardTitle>
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <CalendarDays className="h-3 w-3" />
            {project.dDay}
            {project.place && <> · {project.place}</>}
            {project.partner && <> · {project.partner}</>}
            {project.budget != null && <> · {project.budget.toLocaleString()}원</>}
          </p>
        </CardHeader>

        <CardContent className="space-y-3">
          {project.notes && <p className="text-sm text-muted-foreground">{project.notes}</p>}

          {s.total > 0 ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>준비 진행</span>
                <span>
                  {s.done} / {s.total}
                </span>
              </div>
              <Progress value={(s.done / s.total) * 100} className="h-2" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">준비 할 일이 아직 없습니다.</p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link href="/todos">
                <ListChecks className="h-4 w-4" />
                <span className="ml-1">준비 할일 보기</span>
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (
                  s.total > 0 &&
                  !window.confirm(
                    `"${project.name}" 준비 할 일을 ${project.dDay} 기준으로 다시 깝니다.\n\n` +
                      "아직 안 끝낸 준비는 새 날짜로 옮겨지고, 이미 완료한 준비는 그대로 남습니다."
                  )
                ) {
                  return;
                }
                regenerate.mutate(project.id);
              }}
              data-testid={`button-generate-${project.id}`}
            >
              {s.total > 0 ? <RefreshCw className="h-4 w-4" /> : <Wand2 className="h-4 w-4" />}
              <span className="ml-1">{s.total > 0 ? "날짜에 맞춰 다시 깔기" : "준비 할일 만들기"}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    `"${project.name}" 를 삭제합니다.\n\n` +
                      `딸린 준비 할 일 ${s.total}개도 함께 사라집니다. 되돌릴 수 없습니다.`
                  )
                ) {
                  removeProject.mutate(project.id);
                }
              }}
              data-testid={`button-delete-${project.id}`}
            >
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  function ProjectTab({ tabKey }: { tabKey: string }) {
    const def = SCHEDULER_TABS.find((t) => t.key === tabKey)!;
    const kinds = new Set<string>(def.kinds);
    const mine = projects.filter((p) => kinds.has(p.kind));
    const upcoming = mine.filter((p) => p.dDay >= today).sort((a, b) => a.dDay.localeCompare(b.dDay));
    // 지난 것은 최근 것이 위로. 작년 전단지가 맨 위에 있을 이유가 없다.
    const past = mine.filter((p) => p.dDay < today).sort((a, b) => b.dDay.localeCompare(a.dDay));

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            예정 {upcoming.length}개 · 지난 {past.length}개
          </p>
          <Button
            size="sm"
            onClick={() =>
              setForm({
                name: "",
                kind: def.kinds[0],
                dDay: "",
                place: "",
                partner: "",
                budget: "",
                notes: "",
              })
            }
            data-testid={`button-new-${tabKey}`}
          >
            <Plus className="h-4 w-4" />
            <span className="ml-1">새 프로젝트</span>
          </Button>
        </div>

        {isLoading ? (
          <p className="py-12 text-center text-sm text-muted-foreground">불러오는 중...</p>
        ) : mine.length === 0 ? (
          <Card>
            <CardContent className="space-y-2 py-12 text-center">
              <p className="text-sm text-muted-foreground">아직 등록한 프로젝트가 없습니다.</p>
              <p className="text-xs text-muted-foreground">
                날짜 하나만 넣으면 준비 할 일이 역산으로 깔립니다.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="space-y-3">
              {upcoming.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
            {past.length > 0 && (
              <div className="space-y-3">
                <h2 className="text-sm font-medium text-muted-foreground">지난 프로젝트</h2>
                {past.map((p) => (
                  <ProjectCard key={p.id} project={p} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const activeDef = SCHEDULER_TABS.find((t) => t.key === tab);
  const lateTotal = Array.from(stats.values()).reduce((n, s) => n + s.late, 0);

  return (
    <div className="space-y-6 p-6" data-testid="page-scheduler">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <CalendarDays className="h-6 w-6" />
          프로젝트 스케쥴러
        </h1>
        <p className="text-sm text-muted-foreground">
          {today} · 프로젝트 {projects.length}개
          {lateTotal > 0 && ` · 밀린 준비 ${lateTotal}개`}
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex h-auto w-full flex-wrap justify-start">
          {SCHEDULER_TABS.map((t) => {
            const late = lateByTab.get(t.key) ?? 0;
            return (
              <TabsTrigger key={t.key} value={t.key} data-testid={`tab-${t.key}`}>
                {t.label}
                {late > 0 && (
                  <Badge className="ml-1 bg-red-600 px-1.5 text-white">{late}</Badge>
                )}
              </TabsTrigger>
            );
          })}
          <TabsTrigger value="waiters" data-testid="tab-waiters">
            대기 학생
          </TabsTrigger>
        </TabsList>

        {SCHEDULER_TABS.map((t) => (
          <TabsContent key={t.key} value={t.key} className="mt-4">
            <ProjectTab tabKey={t.key} />
          </TabsContent>
        ))}
        <TabsContent value="waiters" className="mt-4">
          {/*
            대기 명단에서 바로 신규반을 시작한다. 탭을 옮겨 주고 양식을 채워 둘 뿐
            저장하지는 않는다 — 개강일은 원장만 안다.
          */}
          <WaiterTab
            onOpenNewClass={(cls, names) => {
              setTab("newclass");
              setForm({
                name: `${cls} 추가반`,
                kind: "신규반",
                dDay: "",
                place: "",
                partner: "",
                budget: "",
                notes: `대기 학생 ${names.length}명: ${names.join(", ")}`,
              });
            }}
          />
        </TabsContent>
      </Tabs>

      {/* 새 프로젝트. 꼭 필요한 건 이름·종류·날짜 셋이고 나머지는 비워도 된다. */}
      <Dialog
        open={!!form}
        onOpenChange={(open) => !open && !createProject.isPending && setForm(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>새 프로젝트 — {activeDef?.label}</DialogTitle>
            <DialogDescription>
              날짜를 넣으면 종류에 맞는 역산 템플릿으로 준비 할 일이 함께 깔립니다.
            </DialogDescription>
          </DialogHeader>

          {form && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="project-name">이름</Label>
                <Input
                  id="project-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="예: 예비 고1 입시설명회"
                  data-testid="input-project-name"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* 종류는 이 탭이 맡은 것 중에서만 고른다. 탭을 옮겨 다닐 필요가 없게. */}
                <div className="space-y-1">
                  <Label>종류</Label>
                  <Select
                    value={form.kind}
                    onValueChange={(v) => setForm({ ...form, kind: v as ProjectKind })}
                    disabled={(activeDef?.kinds.length ?? 1) < 2}
                  >
                    <SelectTrigger data-testid="select-project-kind">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(activeDef?.kinds ?? []).map((k) => (
                        <SelectItem key={k} value={k}>
                          {k}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="project-dday">날짜 (D-day)</Label>
                  <Input
                    id="project-dday"
                    type="date"
                    value={form.dDay}
                    onChange={(e) => setForm({ ...form, dDay: e.target.value })}
                    data-testid="input-project-dday"
                  />
                  <p className="text-xs text-muted-foreground">{DDAY_HINT[tab]}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="project-place">장소</Label>
                  <Input
                    id="project-place"
                    value={form.place}
                    onChange={(e) => setForm({ ...form, place: e.target.value })}
                    placeholder="비워도 됩니다"
                    data-testid="input-project-place"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="project-budget">예산 (원)</Label>
                  <Input
                    id="project-budget"
                    type="number"
                    min={0}
                    value={form.budget}
                    onChange={(e) => setForm({ ...form, budget: e.target.value })}
                    placeholder="비워도 됩니다"
                    data-testid="input-project-budget"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="project-partner">
                  {tab === "cross" ? "제휴 학원·담당" : "업체·담당"}
                </Label>
                <Input
                  id="project-partner"
                  value={form.partner}
                  onChange={(e) => setForm({ ...form, partner: e.target.value })}
                  placeholder={tab === "cross" ? "예: 봉선 OO수학학원 김원장" : "예: 네이버 광고 / 인쇄소"}
                  data-testid="input-project-partner"
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="project-notes">메모</Label>
                <Textarea
                  id="project-notes"
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  data-testid="input-project-notes"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setForm(null)} disabled={createProject.isPending}>
              취소
            </Button>
            <Button
              onClick={() => form && createProject.mutate(form)}
              disabled={!form?.name.trim() || !form?.dDay || createProject.isPending}
              data-testid="button-save-project"
            >
              만들기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * 대기 학생.
 *
 * ── 이 화면이 답해야 하는 질문 ──
 *   명단을 보여 주는 게 목적이 아니다. 원장이 알고 싶은 건 둘뿐이다:
 *     ① **지금 반을 하나 더 열 수 있나?**  ② **놓치기 직전인 학생이 누구인가?**
 *   그래서 반별 묶음을 "대기 인원이 많은 순"으로 세우고, 정원이 찰 만큼 모인 반에는
 *   신규반 프로젝트를 **그 자리에서** 시작하는 버튼을 둔다. 탭을 옮겨 이름을 다시
 *   입력하게 만들면 아무도 안 누른다.
 *
 *   오래 기다린 학생을 빨갛게 칠하는 이유: 대기 두 달이면 이미 다른 학원에 갔다.
 *   명단에 남아 있다고 기다리는 중인 게 아니다.
 *
 * 지금 대기자는 **반에 매여 있다**(waiters.classId). "아직 반이 없는 관심 학생"은
 * 이 구조로는 못 받는다 — DB 한 칸을 고쳐야 하는 일이라 원장 확인을 받은 뒤에 붙인다.
 */

/** 이만큼 모이면 반 하나가 선다. 원장이 바꿀 수 있게 되기 전까지의 기본값. */
const OPENABLE = 4;
/** 이보다 오래 기다리면 식은 것으로 본다. */
const STALE_DAYS = 30;

function WaiterTab({ onOpenNewClass }: { onOpenNewClass: (className: string, names: string[]) => void }) {
  const today = todayKst();
  const { data: waiters = [], isLoading } = useQuery<Waiter[]>({
    queryKey: ["/api/waiters"],
  });
  const { data: classes = [] } = useQuery<Class[]>({
    queryKey: ["/api/classes"],
  });

  const className = useMemo(() => new Map(classes.map((c) => [c.id, c.name])), [classes]);

  const groups = useMemo(() => {
    const m = new Map<string, Waiter[]>();
    for (const w of waiters) {
      const list = m.get(w.classId) ?? [];
      list.push(w);
      m.set(w.classId, list);
    }
    return (
      Array.from(m.entries())
        .map(([classId, list]) => ({
          classId,
          name: className.get(classId) ?? "알 수 없는 반",
          // 오래 기다린 사람이 위로. 전화는 그 순서로 돌면 된다.
          list: [...list].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
        }))
        // 인원이 많은 반이 위로 — 그게 곧 "다음에 열 반"이다.
        .sort((a, b) => b.list.length - a.list.length)
    );
  }, [waiters, className]);

  const openable = groups.filter((g) => g.list.length >= OPENABLE);
  const stale = waiters.filter(
    (w) => daysBetween(String(w.createdAt).slice(0, 10), today) >= STALE_DAYS
  ).length;

  if (isLoading) {
    return <p className="py-12 text-center text-sm text-muted-foreground">불러오는 중...</p>;
  }

  if (waiters.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-2 py-12 text-center">
          <p className="text-sm text-muted-foreground">대기 중인 학생이 없습니다.</p>
          <p className="text-xs text-muted-foreground">
            대기 등록은 「상담 및 테스트 예약」 화면에서 반을 고른 뒤 합니다.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* 맨 위 한 줄로 "지금 뭘 해야 하는지"를 말한다. */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">대기 {waiters.length}명</span>
        {openable.length > 0 && (
          <Badge className="gap-1 bg-emerald-600 text-white" data-testid="badge-openable">
            <Sparkles className="h-3 w-3" />
            {openable.length}개 반은 지금 열 수 있습니다
          </Badge>
        )}
        {stale > 0 && (
          <Badge className="gap-1 bg-red-600 text-white" data-testid="badge-stale">
            <Flame className="h-3 w-3" />
            {STALE_DAYS}일 넘게 기다린 학생 {stale}명
          </Badge>
        )}
      </div>

      {groups.map((g) => {
        const ready = g.list.length >= OPENABLE;
        return (
          <Card
            key={g.classId}
            className={ready ? "border-emerald-500 bg-emerald-500/5" : undefined}
            data-testid={`waiters-${g.classId}`}
          >
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <UserPlus className="h-4 w-4" />
                {g.name}
                <Badge variant={ready ? "default" : "secondary"}>{g.list.length}명 대기</Badge>
                {ready && (
                  <Badge className="bg-emerald-600 text-white">반 하나 더 열 수 있음</Badge>
                )}
              </CardTitle>
              {!ready && (
                <p className="text-xs text-muted-foreground">
                  {OPENABLE - g.list.length}명 더 모이면 분반을 권합니다.
                </p>
              )}
            </CardHeader>

            <CardContent className="space-y-2">
              {g.list.map((w) => {
                const waited = daysBetween(String(w.createdAt).slice(0, 10), today);
                const cold = waited >= STALE_DAYS;
                return (
                  <div
                    key={w.id}
                    className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${
                      cold ? "border-red-500/60 bg-red-500/5" : ""
                    }`}
                    data-testid={`waiter-${w.id}`}
                  >
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {w.name}
                        <Badge
                          variant="outline"
                          className={`text-xs ${cold ? "border-red-500 text-red-600 dark:text-red-400" : ""}`}
                        >
                          {waited}일 대기
                        </Badge>
                      </p>
                      {w.notes && <p className="text-xs text-muted-foreground">{w.notes}</p>}
                    </div>
                    {/* 전화와 문자를 둘 다 둔다. 수업 중에는 문자가 유일한 수단이다. */}
                    {w.phone && (
                      <div className="flex shrink-0 gap-1">
                        <Button variant="outline" size="sm" asChild>
                          <a href={`tel:${w.phone}`} data-testid={`button-call-${w.id}`}>
                            <Phone className="h-4 w-4" />
                            <span className="ml-1">전화</span>
                          </a>
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <a href={`sms:${w.phone}`} data-testid={`button-sms-${w.id}`}>
                            <MessageSquare className="h-4 w-4" />
                            <span className="ml-1">문자</span>
                          </a>
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* 여기서 바로 신규반 프로젝트로 넘어간다. 이름과 명단을 미리 채워 준다. */}
              <Button
                variant={ready ? "default" : "outline"}
                size="sm"
                className="w-full"
                onClick={() => onOpenNewClass(g.name, g.list.map((w) => w.name))}
                data-testid={`button-open-class-${g.classId}`}
              >
                <Wand2 className="h-4 w-4" />
                <span className="ml-1">이 대기자들로 신규반 프로젝트 시작</span>
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
