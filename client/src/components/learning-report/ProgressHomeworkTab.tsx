/**
 * ① 진도 · 숙제 탭.
 *
 * 진도와 숙제 출제는 **반 전체에 한 번만** 적는다. 학생별로 다른 것은 숙제 검사 결과뿐이다.
 * 검사는 "전원 완료로 채우기" 를 누른 뒤 못 한 학생만 고치는 흐름이다 — 열 명 중 여덟 명은
 * 다 해 오는데 여덟 번을 누르게 하면 강사가 입력을 미룬다.
 */

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { HOMEWORK_COUNT_UNITS, type HomeworkStatus } from "@shared/schema";
import { deriveHomeworkStatus, homeworkShortfall } from "@shared/learningReport";
import {
  API,
  bundleKey,
  orNull,
  toIntOrNull,
  usePatchBundle,
  type HomeworkRow,
  type Track,
  type WeekBundle,
} from "./shared";
import LocalInput from "./LocalInput";

type Props = {
  bundle: WeekBundle;
  track: Track;
  schedule: (key: string, fn: () => void) => void;
};

const STATUS_LABEL: Record<HomeworkStatus, string> = { done: "완료", partial: "일부", none: "안함", pending: "미검사" };

export default function ProgressHomeworkTab({ bundle, track, schedule }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const classId = bundle.class.id;
  const weekStart = bundle.weekStart;
  const weekPath = `${API}/classes/${classId}/weeks/${weekStart}`;
  const patchBundle = usePatchBundle(classId, weekStart);
  const refetch = () => qc.invalidateQueries({ queryKey: bundleKey(classId, weekStart) });

  // ── 진도 ── 처음 열 때 한 번만 서버 값으로 채운다(부모가 반·주가 바뀌면 이 컴포넌트를 새로 만든다).
  const [progress, setProgress] = useState({
    textbook: bundle.week?.textbook ?? "",
    unit: bundle.week?.unit ?? "",
    topic: bundle.week?.topic ?? "",
    progressPct: bundle.week?.progressPct ?? null,
  });

  const saveProgress = (next: typeof progress) => {
    setProgress(next);
    // 반·주를 이름에 넣는다. 그냥 "progress" 면 A반을 고치고 0.7초 안에 B반으로 넘어가 고칠 때 A반 저장이 덮여 사라진다.
    schedule(`progress:${classId}:${weekStart}`, () => {
      track(
        apiRequest("PATCH", weekPath, {
          textbook: orNull(next.textbook),
          unit: orNull(next.unit),
          topic: orNull(next.topic),
          progressPct: next.progressPct,
        })
      ).then(() => {
        // 처음 저장이면 서버가 주 기록을 막 만들었다. 공개 버튼 상태를 맞추려고 한 번 다시 받는다.
        if (!bundle.week) refetch();
      });
    });
  };

  // ── 숙제 출제 ──
  const [draft, setDraft] = useState({ title: "", totalCount: "", countUnit: "문항", dueDate: "" });

  const addHomework = async () => {
    if (!draft.title.trim()) return;
    const ok = await track(
      apiRequest("POST", `${weekPath}/homework`, {
        title: draft.title.trim(),
        totalCount: toIntOrNull(draft.totalCount),
        countUnit: toIntOrNull(draft.totalCount) ? draft.countUnit : null,
        dueDate: draft.dueDate || null,
      })
    );
    if (ok) {
      setDraft({ title: "", totalCount: "", countUnit: draft.countUnit, dueDate: "" });
      refetch();
    }
  };

  // 제목을 고치고 곧바로 개수를 고치면 저장이 한 번으로 합쳐진다. 마지막 칸만 보내면 제목 수정이 사라지므로
  // 보내기 전까지 바뀐 칸을 모아 둔다.
  const hwPending = useRef(new Map<string, Partial<HomeworkRow>>());
  const updateHomework = (item: HomeworkRow, patch: Partial<HomeworkRow>) => {
    patchBundle((b) => ({ ...b, homework: b.homework.map((h) => (h.id === item.id ? { ...h, ...patch } : h)) }));
    hwPending.current.set(item.id, { ...hwPending.current.get(item.id), ...patch });
    schedule(`hw:${item.id}`, () => {
      const body = hwPending.current.get(item.id) ?? {};
      hwPending.current.delete(item.id);
      track(apiRequest("PATCH", `${API}/homework/${item.id}`, body)).then(() => {
        // 총 개수를 바꾸면 서버가 학생별 상태를 다시 맞춘다. 그 결과를 받아 온다.
        if ("totalCount" in body) refetch();
      });
    });
  };

  const deleteHomework = async (item: HomeworkRow) => {
    const checked = Object.values(item.checks).filter((c) => c.status !== "pending").length;
    if (checked && !window.confirm(`"${item.title}" 를 지우면 검사한 ${checked}명의 결과도 함께 지워집니다. 지울까요?`)) return;
    if (await track(apiRequest("DELETE", `${API}/homework/${item.id}`))) refetch();
  };

  // ── 숙제 검사 ──
  const setCheck = (item: HomeworkRow, studentId: string, input: { status?: HomeworkStatus; doneCount?: number | null }, immediate: boolean) => {
    let doneCount = input.doneCount !== undefined ? input.doneCount : item.checks[studentId]?.doneCount ?? null;
    // 서버와 같은 규칙으로 미리 보여 준다(shared/learningReport.ts). 저장 뒤에도 같은 값이 남는다.
    if (input.doneCount === undefined && item.totalCount != null) {
      if (input.status === "done") doneCount = item.totalCount;
      if (input.status === "none") doneCount = 0;
    }
    if (doneCount != null && item.totalCount != null) doneCount = Math.min(doneCount, item.totalCount);
    // 개수 칸을 비우면 "검사 전" 으로 되돌린다. 안 그러면 지우기 전 상태(예: 일부)가 숫자 없이 남는다.
    const chosen = input.doneCount === null && item.totalCount != null ? "pending" : input.status ?? item.checks[studentId]?.status ?? "pending";
    const status = deriveHomeworkStatus(item.totalCount, doneCount, chosen);
    patchBundle((b) => ({
      ...b,
      homework: b.homework.map((h) => (h.id === item.id ? { ...h, checks: { ...h.checks, [studentId]: { status, doneCount } } } : h)),
    }));
    const send = () => track(apiRequest("PUT", `${API}/homework/${item.id}/checks`, { checks: [{ studentId, status, doneCount }] }));
    if (immediate) send();
    else schedule(`chk:${item.id}:${studentId}`, send);
  };

  const fillDone = async (item: HomeworkRow) => {
    const r = await track(apiRequest("POST", `${API}/homework/${item.id}/fill-done`));
    if (r) {
      const { filled, kept } = await r.json();
      toast({ title: `${filled}명을 완료로 채웠습니다`, description: kept ? `이미 검사한 ${kept}명은 그대로 두었습니다.` : undefined });
      refetch();
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              이번 주 진도 <span className="ml-1 text-xs font-normal text-muted-foreground">반 전체 공통</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">교재</Label>
              <Input data-testid="input-textbook" value={progress.textbook} placeholder="예: 중등 영어 Level 2" onChange={(e) => saveProgress({ ...progress, textbook: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">단원</Label>
              <Input data-testid="input-unit" value={progress.unit} placeholder="예: Unit 05. Our Daily Life" onChange={(e) => saveProgress({ ...progress, unit: e.target.value })} />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs text-muted-foreground">이번 주 주제</Label>
              <Input data-testid="input-topic" value={progress.topic} placeholder="예: 현재완료 표현과 핵심 어휘" onChange={(e) => saveProgress({ ...progress, topic: e.target.value })} />
            </div>
            <div className="col-span-2 space-y-2">
              <Label className="text-xs text-muted-foreground">전체 진도 (부모님 화면의 도넛 그래프)</Label>
              <div className="flex items-center gap-3">
                <Slider
                  data-testid="slider-progress"
                  className="flex-1"
                  min={0}
                  max={100}
                  step={1}
                  value={[progress.progressPct ?? 0]}
                  onValueChange={([v]) => saveProgress({ ...progress, progressPct: v })}
                />
                <Input
                  data-testid="input-progress"
                  className="w-20 text-right font-semibold text-orange-600"
                  inputMode="numeric"
                  value={progress.progressPct ?? ""}
                  onChange={(e) => {
                    const n = toIntOrNull(e.target.value);
                    saveProgress({ ...progress, progressPct: n == null ? null : Math.max(0, Math.min(100, n)) });
                  }}
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              이번 주 숙제 출제 <span className="ml-1 text-xs font-normal text-muted-foreground">반 전체 공통</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {bundle.homework.map((h, i) => (
              <div key={h.id} className="flex items-center gap-2" data-testid={`row-homework-${i}`}>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-orange-100 text-xs font-bold text-orange-600">{i + 1}</span>
                <LocalInput className="h-8 flex-1" value={h.title} onValueChange={(v) => updateHomework(h, { title: v })} />
                <LocalInput
                  className="h-8 w-16 text-right"
                  inputMode="numeric"
                  placeholder="개수"
                  value={h.totalCount}
                  onValueChange={(v) => updateHomework(h, { totalCount: toIntOrNull(v) })}
                />
                <span className="w-8 text-xs text-muted-foreground">{h.totalCount ? h.countUnit ?? "개" : ""}</span>
                <LocalInput className="h-8 w-36" type="date" value={h.dueDate} onValueChange={(v) => updateHomework(h, { dueDate: v || null })} />
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => deleteHomework(h)} aria-label="숙제 삭제">
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-orange-300 p-2">
              <Input
                data-testid="input-new-homework"
                className="h-8 flex-1"
                placeholder="숙제 내용 (예: 워크북 p.32–35)"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                // 한글 조합 중 Enter 는 무시한다. 안 그러면 마지막 글자가 빠진 채 추가되고 그 글자가 빈 칸에 남는다.
                onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && addHomework()}
              />
              <Input
                className="h-8 w-16 text-right"
                inputMode="numeric"
                placeholder="개수"
                value={draft.totalCount}
                onChange={(e) => setDraft({ ...draft, totalCount: e.target.value })}
              />
              <Select value={draft.countUnit} onValueChange={(v) => setDraft({ ...draft, countUnit: v })}>
                <SelectTrigger className="h-8 w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOMEWORK_COUNT_UNITS.map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input className="h-8 w-36" type="date" value={draft.dueDate} onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })} />
              <Button data-testid="button-add-homework" size="sm" className="h-8 bg-orange-500 hover:bg-orange-600" onClick={addHomework} disabled={!draft.title.trim()}>
                <Plus className="mr-1 h-4 w-4" />
                추가
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">개수를 비우면 완료 · 일부 · 안함만 고르는 숙제가 됩니다.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-baseline gap-2 text-base">
            숙제 검사
            <span className="text-xs font-normal text-muted-foreground">
              "전원 완료" 를 누른 뒤 <b className="text-orange-600">못 한 학생만</b> 고치세요
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {bundle.homework.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">위에서 이번 주 숙제를 먼저 추가하세요.</p>
          ) : bundle.students.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">이 반에 수강 중인 학생이 없습니다.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                  <th className="px-2 py-2 font-semibold">학생</th>
                  {bundle.homework.map((h, i) => (
                    <th key={h.id} className="px-2 py-2 font-semibold">
                      <div className="flex items-center gap-2">
                        <span className="whitespace-nowrap">
                          {i + 1}. {h.title}
                          {h.totalCount ? <span className="ml-1 font-normal text-muted-foreground/70">{h.totalCount}{h.countUnit ?? "개"}</span> : null}
                        </span>
                        <Button data-testid={`button-fill-done-${i}`} size="sm" variant="outline" className="h-6 px-2 text-[11px] text-orange-600" onClick={() => fillDone(h)}>
                          <Wand2 className="mr-1 h-3 w-3" />
                          전원 완료
                        </Button>
                      </div>
                    </th>
                  ))}
                  <th className="px-2 py-2 font-semibold">부모님께 보이는 결과</th>
                </tr>
              </thead>
              <tbody>
                {bundle.students.map((s) => {
                  const cells = bundle.homework.map((h) => ({ h, c: h.checks[s.id] ?? { status: "pending" as HomeworkStatus, doneCount: null } }));
                  const done = cells.filter(({ c }) => c.status === "done").length;
                  const short = cells.reduce((sum, { h, c }) => sum + (c.status === "partial" ? homeworkShortfall(h.totalCount, c.doneCount) ?? 0 : 0), 0);
                  const flagged = cells.some(({ c }) => c.status === "partial" || c.status === "none");
                  return (
                    <tr key={s.id} className={`border-b ${flagged ? "bg-orange-50/60" : ""}`} data-testid={`row-check-${s.id}`}>
                      <td className="whitespace-nowrap px-2 py-1.5 font-bold">{s.name}</td>
                      {cells.map(({ h, c }) => (
                        <td key={h.id} className="px-2 py-1.5">
                          {h.totalCount != null ? (
                            <div className="flex items-center gap-1.5">
                              <LocalInput
                                className="h-8 w-14 text-center font-bold"
                                inputMode="numeric"
                                value={c.doneCount}
                                placeholder="-"
                                onValueChange={(v) => setCheck(h, s.id, { doneCount: toIntOrNull(v) }, false)}
                              />
                              <span className="text-xs text-muted-foreground">/ {h.totalCount}</span>
                              <StatusTag status={c.status} shortfall={homeworkShortfall(h.totalCount, c.doneCount)} unit={h.countUnit} />
                            </div>
                          ) : (
                            <div className="inline-flex rounded-md bg-muted p-0.5">
                              {(["done", "partial", "none"] as const).map((st) => (
                                <button
                                  key={st}
                                  type="button"
                                  onClick={() => setCheck(h, s.id, { status: c.status === st ? "pending" : st }, true)}
                                  className={`rounded px-2.5 py-1 text-xs font-semibold ${
                                    c.status === st
                                      ? `bg-background shadow-sm ${st === "done" ? "text-green-700" : st === "partial" ? "text-orange-600" : "text-red-700"}`
                                      : "text-muted-foreground"
                                  }`}
                                >
                                  {STATUS_LABEL[st]}
                                </button>
                              ))}
                            </div>
                          )}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-2 py-1.5">
                        <ResultTag
                          done={done}
                          total={cells.length}
                          short={short}
                          anyNone={cells.some(({ c }) => c.status === "none")}
                          allPending={cells.every(({ c }) => c.status === "pending")}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusTag({ status, shortfall, unit }: { status: HomeworkStatus; shortfall: number | null; unit: string | null }) {
  if (status === "done") return <Badge className="bg-green-100 text-green-700 hover:bg-green-100">완료</Badge>;
  if (status === "partial") return <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100">{shortfall}{unit ?? "개"} 부족</Badge>;
  if (status === "none") return <Badge className="bg-red-100 text-red-700 hover:bg-red-100">안 해옴</Badge>;
  return <span className="text-xs text-muted-foreground/60">미검사</span>;
}

function ResultTag({ done, total, short, anyNone, allPending }: { done: number; total: number; short: number; anyNone: boolean; allPending: boolean }) {
  if (allPending) return <span className="text-xs text-muted-foreground/60">검사 전</span>;
  const text = `${done}/${total} 완료${short ? ` · ${short}문항 모자랍니다` : ""}`;
  if (done === total) return <Badge className="bg-green-100 text-green-700 hover:bg-green-100">{text}</Badge>;
  if (anyNone && done === 0) return <Badge className="bg-red-100 text-red-700 hover:bg-red-100">{`0/${total} · 보강 권장`}</Badge>;
  return <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100">{text}</Badge>;
}
