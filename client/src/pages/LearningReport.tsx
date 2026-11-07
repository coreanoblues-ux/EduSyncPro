/**
 * 학습 기록 입력 — 학부모 리포트의 선생님 쪽 화면.
 *
 * 반 하나 · 주 하나를 골라 그 반 전체를 한 번에 입력한다. 시안: design/parent-report/teacher_input_english.html
 * 설계: docs/PARENT_REPORT_PLAN.md
 *
 * 공개 규칙(§6): 입력은 자동 저장만 되고 부모님께는 안 보인다. "이번 주 리포트 공개하기" 를 눌러야 보인다.
 * 반쯤 입력된 점수가 부모님께 나가면 나머지 부모님은 "우리 애 점수가 없다" 가 되고 평균도 틀린다.
 * 공개한 뒤 고친 것은 바로 반영된다. 강사·원장 누구나 누를 수 있다(원장 결정 2026-11-07).
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Class } from "@shared/schema";
import { addDays, todayKst } from "@shared/day";
import { mondayOf, weekLabel } from "@shared/learningReport";
import { API, bundleKey, useDebounced, useSaveTracker, type WeekBundle } from "@/components/learning-report/shared";
import ProgressHomeworkTab from "@/components/learning-report/ProgressHomeworkTab";
import ExamTab from "@/components/learning-report/ExamTab";
import MakeupTab from "@/components/learning-report/MakeupTab";
import PhotoTab from "@/components/learning-report/PhotoTab";
import LinksTab from "@/components/learning-report/LinksTab";

const LAST_CLASS_KEY = "learning-report:last-class";

/** 마지막으로 연 반을 기억한다. 저장소가 막힌 브라우저에서도 화면은 그대로 떠야 한다. */
function readLastClass(): string | null {
  try {
    return localStorage.getItem(LAST_CLASS_KEY);
  } catch {
    return null;
  }
}
function writeLastClass(id: string) {
  try {
    localStorage.setItem(LAST_CLASS_KEY, id);
  } catch {
    /* 기억 못 해도 기능에는 지장 없다 */
  }
}

function shortRange(weekStart: string) {
  const f = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return `${f(weekStart)} ~ ${f(addDays(weekStart, 6))}`;
}

export default function LearningReport() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const thisWeek = mondayOf(todayKst());
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [classId, setClassId] = useState<string | null>(null);
  const [tab, setTab] = useState("homework");
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [saveState, track] = useSaveTracker();
  const schedule = useDebounced(700);

  const { data: allClasses = [] } = useQuery<Class[]>({ queryKey: ["/api/classes"] });
  const classes = useMemo(
    () => allClasses.filter((c) => c.isActive).sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [allClasses]
  );

  useEffect(() => {
    if (classId || classes.length === 0) return;
    const last = readLastClass();
    setClassId(classes.find((c) => c.id === last)?.id ?? classes[0].id);
  }, [classes, classId]);

  const { data: bundle, isLoading, error } = useQuery<WeekBundle>({
    queryKey: classId ? bundleKey(classId, weekStart) : ["learning-report-idle"],
    enabled: !!classId,
    // 다른 강사가 같은 반을 입력했을 수 있다. 반·주를 다시 열 때는 새로 받는다.
    staleTime: 0,
  });

  const published = !!bundle?.week?.publishedAt;
  const weekPath = classId ? `${API}/classes/${classId}/weeks/${weekStart}` : "";

  const doPublish = async (on: boolean) => {
    const r = await track(apiRequest("POST", `${weekPath}/${on ? "publish" : "unpublish"}`));
    if (!r) return;
    await qc.invalidateQueries({ queryKey: bundleKey(classId!, weekStart) });
    toast(
      on
        ? { title: "부모님께 공개했습니다", description: "이제부터 고치는 내용은 바로 부모님 화면에 반영됩니다." }
        : { title: "공개를 취소했습니다", description: "부모님 화면에서 이번 주 기록이 다시 숨겨졌습니다." }
    );
  };

  return (
    <div className="flex min-h-full flex-col" data-testid="learning-report-page">
      {/* ── 머리 ── */}
      <div className="flex flex-wrap items-center gap-3 border-b px-6 pb-3 pt-5">
        <h1 className="text-xl font-extrabold">학습 기록 입력</h1>
        <Select
          value={classId ?? undefined}
          onValueChange={(v) => {
            setClassId(v);
            writeLastClass(v);
          }}
        >
          <SelectTrigger className="w-56" data-testid="select-class">
            <SelectValue placeholder="반 선택" />
          </SelectTrigger>
          <SelectContent>
            {classes.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name} <span className="text-muted-foreground">· {c.subject}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="이전 주">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-1 text-sm font-bold" data-testid="text-week">
            {weekLabel(weekStart)} <span className="font-normal text-muted-foreground">{shortRange(weekStart)}</span>
          </span>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="다음 주">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {weekStart !== thisWeek && (
          <Button size="sm" variant="ghost" className="text-orange-600" onClick={() => setWeekStart(thisWeek)}>
            이번 주로
          </Button>
        )}
        <div className="ml-auto">
          {bundle &&
            (published ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-bold text-green-700" data-testid="status-published">
                <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
                공개됨 · 고치면 바로 반영
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-bold text-amber-800" data-testid="status-draft">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                작성 중 · 부모님께 아직 안 보임
              </span>
            ))}
        </div>
      </div>

      {/* ── 본문 ── */}
      <div className="flex-1 px-6 py-4">
        {classes.length === 0 ? (
          <p className="py-16 text-center text-muted-foreground">먼저 "반" 메뉴에서 반을 만들어 주세요.</p>
        ) : isLoading || !bundle ? (
          error ? (
            <p className="py-16 text-center text-red-600">{(error as Error).message.replace(/^\d{3}: /, "")}</p>
          ) : (
            <div className="flex justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="homework" data-testid="tab-homework">
                진도 · 숙제
              </TabsTrigger>
              <TabsTrigger value="exam" data-testid="tab-exam">
                시험 점수
                {bundle.exams.length > 0 && <span className="ml-1.5 rounded-full bg-orange-500 px-1.5 text-[10px] font-bold text-white">{bundle.exams.length}</span>}
              </TabsTrigger>
              <TabsTrigger value="makeup" data-testid="tab-makeup">
                보강 계획
                {bundle.makeups.filter((m) => m.date >= todayKst()).length > 0 && (
                  <span className="ml-1.5 rounded-full bg-orange-500 px-1.5 text-[10px] font-bold text-white">{bundle.makeups.filter((m) => m.date >= todayKst()).length}</span>
                )}
              </TabsTrigger>
              <TabsTrigger value="photo" data-testid="tab-photo">
                노트 사진
                {bundle.photos.length > 0 && <span className="ml-1.5 rounded-full bg-slate-400 px-1.5 text-[10px] font-bold text-white">{bundle.photos.length}</span>}
              </TabsTrigger>
              <TabsTrigger value="links" data-testid="tab-links">
                부모님 링크
              </TabsTrigger>
            </TabsList>
            {/* key 로 반·주가 바뀔 때 탭을 새로 만든다 — 앞 반에서 입력하던 칸 값이 다음 반에 남지 않게. */}
            <TabsContent value="homework" className="mt-4">
              <ProgressHomeworkTab key={`${classId}:${weekStart}`} bundle={bundle} track={track} schedule={schedule} />
            </TabsContent>
            <TabsContent value="exam" className="mt-4">
              <ExamTab key={`${classId}:${weekStart}`} bundle={bundle} track={track} schedule={schedule} />
            </TabsContent>
            <TabsContent value="makeup" className="mt-4">
              <MakeupTab key={`${classId}:${weekStart}`} bundle={bundle} track={track} />
            </TabsContent>
            <TabsContent value="photo" className="mt-4">
              <PhotoTab key={`${classId}:${weekStart}`} bundle={bundle} track={track} schedule={schedule} />
            </TabsContent>
            <TabsContent value="links" className="mt-4">
              <LinksTab key={classId} bundle={bundle} track={track} />
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* ── 바닥 줄: 저장 상태 + 공개 ── */}
      {bundle && (
        <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background px-6 py-3">
          <SaveLine state={saveState} />
          <div className="flex-1" />
          {published ? (
            <Button variant="outline" onClick={() => doPublish(false)} disabled={saveState.pending > 0} data-testid="button-unpublish">
              공개 취소
            </Button>
          ) : (
            <Button
              className="bg-gradient-to-br from-orange-400 to-orange-600 font-bold shadow-md hover:from-orange-500 hover:to-orange-700"
              onClick={() => setConfirmPublish(true)}
              disabled={saveState.pending > 0}
              data-testid="button-publish"
            >
              이번 주 리포트 공개하기
            </Button>
          )}
        </div>
      )}

      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bundle?.class.name} · {weekLabel(weekStart)} 기록을 부모님께 공개할까요?
            </AlertDialogTitle>
            <AlertDialogDescription>
              진도·숙제 검사·시험 점수·선생님 한마디가 부모님 화면에 보입니다. 공개한 뒤에 고친 내용은 바로 반영되고, 언제든 공개를 취소할 수 있습니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>아직 아니요</AlertDialogCancel>
            <AlertDialogAction className="bg-orange-500 hover:bg-orange-600" onClick={() => doPublish(true)} data-testid="button-confirm-publish">
              공개하기
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SaveLine({ state }: { state: { pending: number; lastSavedAt: Date | null; error: string | null } }) {
  if (state.pending > 0)
    return (
      <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        저장 중…
      </span>
    );
  if (state.error)
    return (
      <span className="flex items-center gap-1.5 text-xs font-semibold text-red-600" data-testid="text-save-error">
        <AlertCircle className="h-3.5 w-3.5" />
        저장 못 함 — {state.error}
      </span>
    );
  if (state.lastSavedAt)
    return (
      <span className="flex items-center gap-1.5 text-xs font-semibold text-green-700" data-testid="text-saved">
        <CheckCircle2 className="h-3.5 w-3.5" />
        자동 저장됨 · {state.lastSavedAt.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })}
      </span>
    );
  return <span className="text-xs text-muted-foreground">입력하면 자동으로 저장됩니다</span>;
}
