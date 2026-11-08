/**
 * 주간 클리닉 — 금(토) 단계별 주간 시험 입력.
 *
 * 클리닉은 반이 섞인다: 듣기반은 다른 교실, 브릿지·모의고사는 여러 반 학생이 한 교실에서 각자 단계를 푼다.
 * 그래서 이 화면은 반이 아니라 **날짜 하나**를 고르고, 학생을 **단계별로** 묶어 보여 준다.
 * 학생 단계는 한 번 정하면 기억한다(맨 위 "학생 단계 정하기"). 안 듣는 학생은 "안 들음".
 *
 * 올 때마다 보는 단어시험도 이 화면에서 같이 적는다 — 그 학생 반의 단어시험 표(학습 기록 입력)에 그대로 들어간다.
 * 공개는 클리닉 날마다 따로 건다(반의 주 공개를 따를 수 없다 — 반이 섞여서).
 */

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { CLINIC_LEVELS, CLINIC_LEVEL_CHOICES, type ClinicLevel } from "@shared/schema";
import { addDays, todayKst } from "@shared/day";
import {
  CLINIC_LEVEL_LABEL,
  dayOfWeekKo,
  englishGrade,
  isCountLevel,
  isMockLevel,
  mondayOf,
  vocabResult,
  MIN_TAKERS_FOR_RANK,
} from "@shared/learningReport";
import { toIntOrNull, useDebounced, useSaveTracker } from "@/components/learning-report/shared";
import LocalInput from "@/components/learning-report/LocalInput";

type ClinicStudent = { studentId: string; name: string; grade: string | null; classId: string; className: string; level: string | null };
type ClinicScore = { studentId: string; level: string; score: number | null; correct: number | null; total: number | null; reviewDone: boolean };
type VocabCell = { studentId: string; classId: string; total: number; wrong: number; retestPassed: boolean | null };
type ClinicBundle = {
  date: string;
  day: { papers: Partial<Record<ClinicLevel, string>>; publishedAt: string | null } | null;
  students: ClinicStudent[];
  scores: ClinicScore[];
  vocab: VocabCell[];
  lastVocabTotals: Record<string, number>;
  listeningDefaultTotal: number;
};

const API = "/api/learning-report/clinic";
const key = (date: string) => [`${API}/days`, date];

/** 오늘이 금·토면 오늘, 아니면 가장 최근의 금·토 — 클리닉이 끝난 직후에 여는 화면이라서. */
function defaultClinicDate(): string {
  let d = todayKst();
  for (let i = 0; i < 7; i++) {
    const dow = dayOfWeekKo(d);
    if (dow === "금" || dow === "토") return d;
    d = addDays(d, -1);
  }
  return todayKst();
}

function label(ymd: string) {
  return `${Number(ymd.slice(5, 7))}월 ${Number(ymd.slice(8, 10))}일 (${dayOfWeekKo(ymd)})`;
}

const VOCAB_BADGE = { pass: "bg-green-100 text-green-700", rewrite: "bg-orange-100 text-orange-700", retest: "bg-red-100 text-red-700" } as const;
const VOCAB_SHORT = { pass: "통과", rewrite: "반복쓰기", retest: "재시험" } as const;

export default function Clinic() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [date, setDate] = useState(defaultClinicDate);
  const [levelsOpen, setLevelsOpen] = useState(false);
  const [saveState, track] = useSaveTracker();
  const schedule = useDebounced(700);

  const { data, isLoading, error } = useQuery<ClinicBundle>({ queryKey: key(date), staleTime: 0 });
  const patch = (fn: (b: ClinicBundle) => ClinicBundle) => qc.setQueryData<ClinicBundle>(key(date), (old) => (old ? fn(old) : old));
  const refetch = () => qc.invalidateQueries({ queryKey: key(date) });

  const published = !!data?.day?.publishedAt;
  const groups = useMemo(() => {
    const by: Record<string, ClinicStudent[]> = {};
    for (const s of data?.students ?? []) (by[s.level ?? "unset"] ??= []).push(s);
    return by;
  }, [data?.students]);

  const scoreOf = (id: string) => data?.scores.find((s) => s.studentId === id);
  const vocabOf = (id: string) => data?.vocab.find((v) => v.studentId === id);

  const saveScore = (s: ClinicStudent, change: Partial<ClinicScore>, immediate = false) => {
    const level = s.level as ClinicLevel;
    patch((b) => {
      const prev = b.scores.find((x) => x.studentId === s.studentId) ?? {
        studentId: s.studentId,
        level,
        score: null,
        correct: null,
        total: isCountLevel(level) ? b.listeningDefaultTotal : null,
        reviewDone: false,
      };
      const next = { ...prev, ...change };
      const others = b.scores.filter((x) => x.studentId !== s.studentId);
      const empty = next.score == null && next.correct == null;
      return { ...b, scores: empty ? others : [...others, next] };
    });
    const send = () => track(apiRequest("PUT", `${API}/days/${date}/scores`, { entries: [{ studentId: s.studentId, ...change }] }));
    if (immediate) send();
    else schedule(`clinic:${date}:${s.studentId}:${Object.keys(change).join(",")}`, send);
  };

  const saveVocab = (s: ClinicStudent, wrongText: string, totalOverride?: number) => {
    const cur = vocabOf(s.studentId);
    const total = totalOverride ?? cur?.total ?? data?.lastVocabTotals[s.studentId] ?? 50;
    const n = toIntOrNull(wrongText);
    const wrong = n == null ? null : Math.max(0, Math.min(total, n));
    patch((b) => {
      const others = b.vocab.filter((v) => v.studentId !== s.studentId);
      return { ...b, vocab: wrong == null ? others : [...others, { studentId: s.studentId, classId: s.classId, total, wrong, retestPassed: cur?.retestPassed ?? null }] };
    });
    // 그 학생 반의 단어시험 표로 들어간다 (학습 기록 입력 > 단어시험 에도 그대로 보인다).
    schedule(`clinic-vocab:${date}:${s.studentId}`, () =>
      track(apiRequest("PUT", `/api/learning-report/classes/${s.classId}/weeks/${mondayOf(date)}/vocab`, { entries: [{ studentId: s.studentId, testDate: date, total, wrong }] }))
    );
  };

  const savePaper = (level: ClinicLevel, title: string) => {
    patch((b) => ({ ...b, day: { publishedAt: b.day?.publishedAt ?? null, papers: { ...(b.day?.papers ?? {}), [level]: title } } }));
    schedule(`paper:${date}:${level}`, () => track(apiRequest("PATCH", `${API}/days/${date}`, { papers: { [level]: title } })));
  };

  const doPublish = async (on: boolean) => {
    if (await track(apiRequest("POST", `${API}/days/${date}/${on ? "publish" : "unpublish"}`))) {
      refetch();
      toast(on ? { title: "클리닉 결과를 부모님께 공개했습니다" } : { title: "공개를 취소했습니다" });
    }
  };

  const unset = groups["unset"] ?? [];
  const none = groups["none"] ?? [];

  return (
    <div className="flex min-h-full flex-col" data-testid="clinic-page">
      <div className="flex flex-wrap items-center gap-3 border-b px-6 pb-3 pt-5">
        <h1 className="text-xl font-extrabold">주간 클리닉</h1>
        <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setDate(addDays(date, -1))} aria-label="전날">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="px-1 text-sm font-bold" data-testid="text-clinic-date">
            {label(date)}
          </span>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setDate(addDays(date, 1))} aria-label="다음 날">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <Input type="date" className="h-9 w-40" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <Button variant="outline" size="sm" onClick={() => setLevelsOpen(true)} data-testid="button-levels">
          <Users className="mr-1 h-4 w-4" />
          학생 단계 정하기{unset.length ? <span className="ml-1.5 rounded-full bg-orange-500 px-1.5 text-[10px] font-bold text-white">미정 {unset.length}</span> : null}
        </Button>
        <div className="ml-auto">
          {data &&
            (published ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-green-50 px-3 py-1 text-xs font-bold text-green-700">
                <span className="h-1.5 w-1.5 rounded-full bg-green-600" />
                공개됨 · 고치면 바로 반영
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-bold text-amber-800">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                작성 중 · 부모님께 아직 안 보임
              </span>
            ))}
        </div>
      </div>

      <div className="flex-1 space-y-4 px-6 py-4">
        {isLoading || !data ? (
          error ? (
            <p className="py-16 text-center text-red-600">{(error as Error).message.replace(/^\d{3}: /, "")}</p>
          ) : (
            <div className="flex justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )
        ) : (
          <>
            {unset.length > 0 && (
              <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm">
                클리닉 단계를 아직 안 정한 학생이 <b>{unset.length}명</b> 있습니다. 단계를 정해야 이 화면에 나옵니다.{" "}
                <button className="font-bold text-orange-700 underline" onClick={() => setLevelsOpen(true)}>
                  지금 정하기
                </button>
              </div>
            )}
            {CLINIC_LEVELS.map((level) => (
              <LevelCard
                key={level}
                level={level}
                list={groups[level] ?? []}
                data={data}
                scoreOf={scoreOf}
                vocabOf={vocabOf}
                onScore={saveScore}
                onVocab={saveVocab}
                onPaper={(t) => savePaper(level, t)}
              />
            ))}
            {none.length > 0 && <p className="text-xs text-muted-foreground">안 들음 {none.length}명 (고등부·클리닉 미수강) — 이 화면과 부모님 화면 클리닉 칸에서 빠집니다.</p>}
          </>
        )}
      </div>

      {data && (
        <div className="sticky bottom-0 flex items-center gap-3 border-t bg-background px-6 py-3">
          <SaveLine state={saveState} />
          <div className="flex-1" />
          {published ? (
            <Button variant="outline" onClick={() => doPublish(false)} disabled={saveState.pending > 0}>
              공개 취소
            </Button>
          ) : (
            <Button
              className="bg-gradient-to-br from-orange-400 to-orange-600 font-bold shadow-md hover:from-orange-500 hover:to-orange-700"
              disabled={saveState.pending > 0 || data.scores.length === 0}
              onClick={() => window.confirm(`${label(date)} 클리닉 결과를 부모님께 공개할까요?\n공개한 뒤 고친 내용은 바로 반영됩니다.`) && doPublish(true)}
              data-testid="button-clinic-publish"
            >
              이 날 클리닉 결과 공개하기
            </Button>
          )}
        </div>
      )}

      <LevelsDialog open={levelsOpen} onOpenChange={setLevelsOpen} track={track} onChanged={refetch} />
    </div>
  );
}

// ─── 단계 하나 ───────────────────────────────────────────────────────────

function LevelCard({
  level,
  list,
  data,
  scoreOf,
  vocabOf,
  onScore,
  onVocab,
  onPaper,
}: {
  level: ClinicLevel;
  list: ClinicStudent[];
  data: ClinicBundle;
  scoreOf: (id: string) => ClinicScore | undefined;
  vocabOf: (id: string) => VocabCell | undefined;
  onScore: (s: ClinicStudent, change: Partial<ClinicScore>, immediate?: boolean) => void;
  onVocab: (s: ClinicStudent, wrong: string, total?: number) => void;
  onPaper: (title: string) => void;
}) {
  if (list.length === 0) return null;
  const counted = isCountLevel(level);
  const taken = list.map((s) => scoreOf(s.studentId)).filter((x): x is ClinicScore => !!x);
  const values = taken.map((x) => (counted ? (x.correct != null && x.total ? (x.correct / x.total) * 100 : null) : x.score)).filter((v): v is number => v != null);
  const avg = values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;
  const reviewed = taken.filter((x) => x.reviewDone).length;

  return (
    <Card data-testid={`clinic-level-${level}`}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="text-base">
            {CLINIC_LEVEL_LABEL[level]} <span className="text-sm font-normal text-muted-foreground">{list.length}명</span>
          </CardTitle>
          <LocalInput
            className="h-8 w-64"
            placeholder={counted ? "시험지 이름 (예: 듣기 12회)" : "시험지 이름 (예: 2024년 9월 고1)"}
            value={data.day?.papers?.[level] ?? ""}
            onValueChange={onPaper}
          />
          <span className="ml-auto text-xs text-muted-foreground">
            입력 {taken.length}/{list.length}명
            {avg != null && values.length >= MIN_TAKERS_FOR_RANK && ` · 평균 ${counted ? `${avg}%` : `${avg}점`}`} · 오답 정리 {reviewed}명
          </span>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="px-2 py-2 font-semibold">학생</th>
              <th className="px-2 py-2 font-semibold">{counted ? "맞은 개수" : "점수 (100점)"}</th>
              <th className="px-2 py-2 font-semibold">오답 정리</th>
              <th className="px-2 py-2 font-semibold">단어시험 <span className="font-normal opacity-60">틀린 개수</span></th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => {
              const sc = scoreOf(s.studentId);
              const v = vocabOf(s.studentId);
              const vTotal = v?.total ?? data.lastVocabTotals[s.studentId] ?? 50;
              const vr = v ? vocabResult(v.total, v.wrong) : null;
              return (
                <tr key={s.studentId} className="border-b" data-testid={`row-clinic-${s.studentId}`}>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <b>{s.name}</b> <span className="text-xs text-muted-foreground">{s.className}</span>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {counted ? (
                        <>
                          <LocalInput
                            className="h-8 w-14 text-center font-bold"
                            inputMode="numeric"
                            placeholder="-"
                            value={sc?.correct}
                            onValueChange={(t) => {
                              const n = toIntOrNull(t);
                              const total = sc?.total ?? data.listeningDefaultTotal;
                              onScore(s, { correct: n == null ? null : Math.max(0, Math.min(total, n)), total });
                            }}
                          />
                          <span className="text-xs text-muted-foreground">/ {sc?.total ?? data.listeningDefaultTotal}</span>
                        </>
                      ) : (
                        <>
                          <LocalInput
                            className="h-8 w-16 text-center font-bold"
                            inputMode="numeric"
                            placeholder="-"
                            value={sc?.score}
                            onValueChange={(t) => {
                              const n = toIntOrNull(t);
                              onScore(s, { score: n == null ? null : Math.max(0, Math.min(100, n)) });
                            }}
                          />
                          <span className="text-xs text-muted-foreground">점</span>
                          {isMockLevel(level) && sc?.score != null && (
                            <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100">{englishGrade(sc.score)}등급</Badge>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                      <Checkbox
                        disabled={!sc}
                        checked={!!sc?.reviewDone}
                        onCheckedChange={(c) => onScore(s, { reviewDone: c === true }, true)}
                      />
                      완료
                    </label>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <LocalInput className="h-8 w-12 text-center font-bold" inputMode="numeric" placeholder="-" value={v?.wrong} onValueChange={(t) => onVocab(s, t)} />
                      <span className="text-[11px] text-muted-foreground">/ {vTotal}</span>
                      {vr && <Badge className={`px-1.5 text-[10px] hover:opacity-90 ${VOCAB_BADGE[vr]}`}>{VOCAB_SHORT[vr]}</Badge>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {counted && <p className="mt-2 text-xs text-muted-foreground">듣기는 총 {data.listeningDefaultTotal}문항 기준입니다. 단어시험은 그 학생 반의 단어시험 표에도 같이 들어갑니다.</p>}
      </CardContent>
    </Card>
  );
}

// ─── 학생 단계 정하기 ─────────────────────────────────────────────────────

function LevelsDialog({ open, onOpenChange, track, onChanged }: { open: boolean; onOpenChange: (o: boolean) => void; track: ReturnType<typeof useSaveTracker>[1]; onChanged: () => void }) {
  const qc = useQueryClient();
  const { data: list = [] } = useQuery<ClinicStudent[]>({ queryKey: [`${API}/students`], enabled: open, staleTime: 0 });
  const byClass = useMemo(() => {
    const m = new Map<string, ClinicStudent[]>();
    for (const s of list) m.set(s.className, [...(m.get(s.className) ?? []), s]);
    return Array.from(m.entries());
  }, [list]);

  const setLevels = async (items: { studentId: string; level: string }[]) => {
    qc.setQueryData<ClinicStudent[]>([`${API}/students`], (old) => old?.map((s) => ({ ...s, level: items.find((i) => i.studentId === s.studentId)?.level ?? s.level })));
    if (await track(apiRequest("PUT", `${API}/levels`, { items }))) onChanged();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>학생 클리닉 단계 정하기</DialogTitle>
          <DialogDescription>한 번 정하면 계속 기억합니다. 클리닉을 안 듣는 학생(고등부 포함)은 "안 들음" 으로 두세요.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {byClass.map(([className, students]) => (
            <div key={className} className="rounded-lg border p-3">
              <div className="mb-2 flex items-center gap-2">
                <b className="text-sm">{className}</b>
                <span className="text-xs text-muted-foreground">{students.length}명</span>
                <div className="ml-auto flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">반 전체를</span>
                  <Select value="" onValueChange={(lv) => setLevels(students.map((s) => ({ studentId: s.studentId, level: lv })))}>
                    <SelectTrigger className="h-7 w-36 text-xs">
                      <SelectValue placeholder="한 번에 정하기" />
                    </SelectTrigger>
                    <SelectContent>
                      {CLINIC_LEVEL_CHOICES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {CLINIC_LEVEL_LABEL[c]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {students.map((s) => (
                  <div key={s.studentId} className="flex items-center gap-2">
                    <span className="w-20 truncate text-sm font-semibold">{s.name}</span>
                    <Select value={s.level ?? ""} onValueChange={(lv) => setLevels([{ studentId: s.studentId, level: lv }])}>
                      <SelectTrigger className={`h-7 flex-1 text-xs ${s.level ? "" : "border-orange-300 text-orange-700"}`}>
                        <SelectValue placeholder="미정" />
                      </SelectTrigger>
                      <SelectContent>
                        {CLINIC_LEVEL_CHOICES.map((c) => (
                          <SelectItem key={c} value={c}>
                            {CLINIC_LEVEL_LABEL[c]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
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
      <span className="flex items-center gap-1.5 text-xs font-semibold text-red-600">
        <AlertCircle className="h-3.5 w-3.5" />
        저장 못 함 — {state.error}
      </span>
    );
  if (state.lastSavedAt)
    return (
      <span className="flex items-center gap-1.5 text-xs font-semibold text-green-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        자동 저장됨 · {state.lastSavedAt.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })}
      </span>
    );
  return <span className="text-xs text-muted-foreground">입력하면 자동으로 저장됩니다</span>;
}
