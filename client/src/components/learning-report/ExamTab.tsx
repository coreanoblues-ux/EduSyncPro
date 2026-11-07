/**
 * ② 시험 점수 탭.
 *
 * 선생님이 넣는 것은 영역 점수와 (원하면) 한마디뿐이다. 총점·반 평균·상위 %·통과 여부는
 * 화면이 즉시 계산해 보여 주고, 서버도 같은 규칙(shared/learningReport.ts)으로 저장한다.
 * 통과 못 한 학생은 날짜만 고르면 재시 일정으로 한 번에 잡힌다 — 부모님 화면 맨 위 D-day 배너가 된다.
 */

import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { EXAM_KINDS, type ExamKind } from "@shared/schema";
import { examStats, examTotal, MIN_TAKERS_FOR_RANK } from "@shared/learningReport";
import { addDays } from "@shared/day";
import { API, bundleKey, orNull, toIntOrNull, usePatchBundle, type ExamRow, type ScoreRow, type Track, type WeekBundle } from "./shared";
import LocalInput from "./LocalInput";

type Props = {
  bundle: WeekBundle;
  track: Track;
  schedule: (key: string, fn: () => void) => void;
};

const KIND_LABEL: Record<ExamKind, string> = { weekly: "주간평가", monthly: "월간평가", unit: "단원평가", retest: "재시험" };

/** 자주 쓰는 한마디. 누르면 마지막으로 누른 학생의 한마디 칸 끝에 붙는다. */
const QUICK_COMMENTS = ["꾸준히 좋아지고 있어요", "집중력이 좋았어요", "오답 정리가 필요해요", "단어 암기를 더 해 주세요", "다음 시험이 기대돼요"];

export default function ExamTab({ bundle, track, schedule }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const classId = bundle.class.id;
  const weekStart = bundle.weekStart;
  const weekPath = `${API}/classes/${classId}/weeks/${weekStart}`;
  const patchBundle = usePatchBundle(classId, weekStart);
  const refetch = () => qc.invalidateQueries({ queryKey: bundleKey(classId, weekStart) });

  const [selectedId, setSelectedId] = useState<string | null>(bundle.exams[0]?.id ?? null);
  const exam = bundle.exams.find((e) => e.id === selectedId) ?? bundle.exams[0] ?? null;
  const [adding, setAdding] = useState(bundle.exams.length === 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {bundle.exams.map((e) => (
          <Button
            key={e.id}
            size="sm"
            variant={exam?.id === e.id && !adding ? "default" : "outline"}
            className={exam?.id === e.id && !adding ? "bg-orange-500 hover:bg-orange-600" : ""}
            onClick={() => {
              setSelectedId(e.id);
              setAdding(false);
            }}
          >
            {e.name}
          </Button>
        ))}
        <Button data-testid="button-new-exam" size="sm" variant="outline" className="border-dashed text-orange-600" onClick={() => setAdding(true)}>
          <Plus className="mr-1 h-4 w-4" />
          시험 추가
        </Button>
      </div>

      {adding ? (
        <NewExamForm
          bundle={bundle}
          onCancel={bundle.exams.length ? () => setAdding(false) : undefined}
          onCreate={async (body) => {
            const r = await track(apiRequest("POST", `${weekPath}/exams`, body));
            if (!r) return;
            const created = await r.json();
            setSelectedId(created.id);
            setAdding(false);
            refetch();
          }}
        />
      ) : exam ? (
        <ExamEditor key={exam.id} exam={exam} bundle={bundle} track={track} schedule={schedule} patchBundle={patchBundle} refetch={refetch} toast={toast} />
      ) : null}
    </div>
  );
}

// ─── 새 시험 ─────────────────────────────────────────────────────────────

function NewExamForm({
  bundle,
  onCreate,
  onCancel,
}: {
  bundle: WeekBundle;
  onCreate: (body: Record<string, unknown>) => void;
  onCancel?: () => void;
}) {
  const [f, setF] = useState({
    name: "",
    kind: "weekly" as ExamKind,
    examDate: bundle.weekStart,
    passScore: "70",
    areas: bundle.defaultAreas.join(", "),
  });
  const areas = f.areas
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">새 시험</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_0.8fr]">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">시험 이름</Label>
            <Input data-testid="input-exam-name" placeholder="예: Unit 05 주간평가" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">종류</Label>
            <Select value={f.kind} onValueChange={(v) => setF({ ...f, kind: v as ExamKind })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXAM_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">시험 날짜</Label>
            <Input type="date" min={bundle.weekStart} max={addDays(bundle.weekStart, 6)} value={f.examDate} onChange={(e) => setF({ ...f, examDate: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">통과 기준</Label>
            <Input inputMode="numeric" value={f.passScore} placeholder="없음" onChange={(e) => setF({ ...f, passScore: e.target.value })} />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">영역 (쉼표로 구분, 부모님 화면의 막대 그래프 줄)</Label>
          <Input value={f.areas} onChange={(e) => setF({ ...f, areas: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button variant="outline" onClick={onCancel}>
              취소
            </Button>
          )}
          <Button
            data-testid="button-create-exam"
            className="bg-orange-500 hover:bg-orange-600"
            disabled={!f.name.trim() || areas.length === 0 || !f.examDate}
            onClick={() =>
              onCreate({
                name: f.name.trim(),
                kind: f.kind,
                examDate: f.examDate,
                passScore: toIntOrNull(f.passScore),
                areas,
              })
            }
          >
            시험 만들기
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── 점수 입력 ───────────────────────────────────────────────────────────

function ExamEditor({
  exam,
  bundle,
  track,
  schedule,
  patchBundle,
  refetch,
  toast,
}: {
  exam: ExamRow;
  bundle: WeekBundle;
  track: Track;
  schedule: (key: string, fn: () => void) => void;
  patchBundle: ReturnType<typeof usePatchBundle>;
  refetch: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const lastFocused = useRef<string | null>(null);
  const [retest, setRetest] = useState({ date: addDays(bundle.weekStart, 5), startTime: "14:00" });
  const names = useMemo(() => Object.fromEntries(bundle.students.map((s) => [s.id, s.name])), [bundle.students]);

  /** 한 학생의 점수 행을 캐시에서 고치고, 총점·통계를 서버와 같은 규칙으로 다시 계산한다. */
  const patchScore = (studentId: string, fn: (row: ScoreRow) => ScoreRow) => {
    patchBundle((b) => ({
      ...b,
      exams: b.exams.map((e) => {
        if (e.id !== exam.id) return e;
        const prev = e.scores.find((s) => s.studentId === studentId) ?? { studentId, areaScores: {}, total: null, absent: false, comment: null };
        const next = fn(prev);
        next.total = examTotal(e.areas, next.areaScores);
        const scores = [...e.scores.filter((s) => s.studentId !== studentId), next];
        return { ...e, scores, stats: examStats(scores, e.passScore) };
      }),
    }));
  };

  const rowOf = (studentId: string): ScoreRow =>
    exam.scores.find((s) => s.studentId === studentId) ?? { studentId, areaScores: {}, total: null, absent: false, comment: null };

  const setArea = (studentId: string, area: string, value: number | null) => {
    const next = { ...rowOf(studentId).areaScores };
    if (value == null) delete next[area];
    else next[area] = Math.max(0, Math.min(100, value));
    patchScore(studentId, (r) => ({ ...r, areaScores: next }));
    // 그 학생의 영역 전부를 보낸다. 비운 칸은 null 이라 서버에서도 지워진다.
    schedule(`sc:${exam.id}:${studentId}`, () =>
      track(
        apiRequest("PUT", `${API}/exams/${exam.id}/scores`, {
          scores: [{ studentId, areaScores: Object.fromEntries(exam.areas.map((a) => [a, next[a] ?? null])) }],
        })
      )
    );
  };

  const setComment = (studentId: string, comment: string) => {
    patchScore(studentId, (r) => ({ ...r, comment }));
    schedule(`cm:${exam.id}:${studentId}`, () =>
      track(apiRequest("PUT", `${API}/exams/${exam.id}/scores`, { scores: [{ studentId, comment: orNull(comment) }] }))
    );
  };

  const toggleAbsent = (studentId: string) => {
    const absent = !rowOf(studentId).absent;
    patchScore(studentId, (r) => ({ ...r, absent }));
    track(apiRequest("PUT", `${API}/exams/${exam.id}/scores`, { scores: [{ studentId, absent }] }));
  };

  const updateExam = (patch: Partial<ExamRow>) => {
    patchBundle((b) => ({
      ...b,
      exams: b.exams.map((e) => (e.id === exam.id ? { ...e, ...patch, stats: examStats(e.scores, patch.passScore !== undefined ? patch.passScore : e.passScore) } : e)),
    }));
    schedule(`exam:${exam.id}:${Object.keys(patch).join(",")}`, () => track(apiRequest("PATCH", `${API}/exams/${exam.id}`, patch)));
  };

  const deleteExam = async () => {
    if (!window.confirm(`"${exam.name}" 시험과 입력한 점수 ${exam.scores.length}명분을 지울까요?`)) return;
    if (await track(apiRequest("DELETE", `${API}/exams/${exam.id}`))) refetch();
  };

  const stats = exam.stats;
  const fails = stats.failStudentIds;
  const retestsForExam = bundle.makeups.filter((m) => m.examId === exam.id);
  const alreadyRetest = new Set(retestsForExam.flatMap((m) => m.students.map((s) => s.studentId)));
  const pendingRetest = fails.filter((id) => !alreadyRetest.has(id));

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">시험 정보</CardTitle>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={deleteExam}>
              <Trash2 className="mr-1 h-4 w-4" />
              시험 삭제
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_0.8fr]">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">시험 이름</Label>
              <LocalInput value={exam.name} onValueChange={(v) => updateExam({ name: v })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">종류</Label>
              <Select value={exam.kind} onValueChange={(v) => updateExam({ kind: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXAM_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {KIND_LABEL[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">시험 날짜</Label>
              <LocalInput type="date" value={exam.examDate} onValueChange={(v) => v && updateExam({ examDate: v })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">통과 기준</Label>
              <LocalInput inputMode="numeric" value={exam.passScore} placeholder="없음" onValueChange={(v) => updateExam({ passScore: toIntOrNull(v) })} />
            </div>
          </div>

          {bundle.students.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">이 반에 수강 중인 학생이 없습니다.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-2 py-2 font-semibold">학생</th>
                    {exam.areas.map((a) => (
                      <th key={a} className="px-2 py-2 font-semibold">
                        {a}
                      </th>
                    ))}
                    <th className="whitespace-nowrap px-2 py-2 font-semibold">점수 <span className="font-normal opacity-60">자동</span></th>
                    <th className="whitespace-nowrap px-2 py-2 font-semibold">결과</th>
                    <th className="whitespace-nowrap px-2 py-2 font-semibold">선생님 한마디 <span className="font-normal opacity-60">부모님께 보임</span></th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.students.map((s) => {
                    const row = rowOf(s.id);
                    const failed = fails.includes(s.id);
                    return (
                      <tr key={s.id} className={`border-b ${failed ? "bg-orange-50/60" : ""}`} data-testid={`row-score-${s.id}`}>
                        <td className="whitespace-nowrap px-2 py-1.5 font-bold">{s.name}</td>
                        {exam.areas.map((a) => (
                          <td key={a} className="px-2 py-1.5">
                            <LocalInput
                              className="h-8 w-14 text-center font-bold"
                              inputMode="numeric"
                              disabled={row.absent}
                              value={row.areaScores[a]}
                              onValueChange={(v) => setArea(s.id, a, toIntOrNull(v))}
                            />
                          </td>
                        ))}
                        <td className="px-2 py-1.5 font-bold">{row.absent ? "-" : row.total ?? ""}</td>
                        <td className="whitespace-nowrap px-2 py-1.5">
                          <button type="button" onClick={() => toggleAbsent(s.id)} title="결시로 바꾸기/되돌리기">
                            {row.absent ? (
                              <Badge variant="secondary">결시</Badge>
                            ) : row.total == null ? (
                              <span className="text-xs text-muted-foreground/60">입력 전</span>
                            ) : failed ? (
                              <Badge className="bg-red-100 text-red-700 hover:bg-red-100">재시</Badge>
                            ) : exam.passScore != null ? (
                              <Badge className="bg-green-100 text-green-700 hover:bg-green-100">통과</Badge>
                            ) : stats.topPct[s.id] ? (
                              <Badge className="bg-orange-100 text-orange-700 hover:bg-orange-100">상위 {stats.topPct[s.id]}%</Badge>
                            ) : null}
                          </button>
                        </td>
                        <td className="px-2 py-1.5">
                          <LocalInput
                            className="h-8 min-w-[220px]"
                            placeholder="+ 한마디 쓰기"
                            value={row.comment}
                            onFocus={() => (lastFocused.current = s.id)}
                            onValueChange={(v) => setComment(s.id, v)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted-foreground">결과 칸을 누르면 결시로 바뀝니다. 결시는 평균·상위 % 계산에서 빠집니다.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">자동 계산</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="반 평균" value={stats.average} unit="점" />
              <Stat label="최고점" value={stats.max} unit="점" />
              <Stat label="통과" value={stats.passCount} unit="명" />
              <Stat label="재시 대상" value={exam.passScore != null ? fails.length : null} unit="명" highlight />
            </div>
            <p className="text-xs text-muted-foreground">
              {stats.takers >= MIN_TAKERS_FOR_RANK
                ? "상위 % 는 학생마다 자동으로 붙어 부모님 화면에 보입니다."
                : `응시 ${MIN_TAKERS_FOR_RANK}명 이상일 때만 상위 % 를 보여 줍니다 (작은 반에서 등수가 드러나지 않게).`}
            </p>
          </CardContent>
        </Card>

        {exam.passScore != null && (
          <Card className="border-orange-200 bg-orange-50/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-base text-orange-800">재시 일정 한 번에 잡기</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {retestsForExam.map((m) => (
                <div key={m.id} className="rounded-md bg-white px-3 py-2 text-xs">
                  <b>등록됨</b> · {m.date.slice(5).replace("-", "/")} {m.startTime ?? ""} · {m.students.map((s) => s.name).join(", ")}
                </div>
              ))}
              {pendingRetest.length === 0 ? (
                <p className="text-xs text-muted-foreground">{fails.length ? "재시 대상 전원이 등록돼 있습니다." : "지금은 재시 대상이 없습니다."}</p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {pendingRetest.map((id) => {
                      const r = rowOf(id);
                      return (
                        <span key={id} className="rounded-full border border-orange-300 bg-white px-2.5 py-0.5 text-xs font-semibold text-orange-700">
                          {names[id]} {r.total}
                        </span>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">재시 날짜</Label>
                      <Input type="date" value={retest.date} onChange={(e) => setRetest({ ...retest, date: e.target.value })} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">시간</Label>
                      <Input type="time" value={retest.startTime} onChange={(e) => setRetest({ ...retest, startTime: e.target.value })} />
                    </div>
                  </div>
                  <Button
                    data-testid="button-register-retest"
                    className="w-full bg-orange-500 hover:bg-orange-600"
                    disabled={!retest.date}
                    onClick={async () => {
                      // 이미 등록된 학생은 빼고 보낸다(같은 재시에 두 번 잡히지 않게).
                      const r = await track(
                        apiRequest("POST", `${API}/exams/${exam.id}/retest`, { date: retest.date, startTime: retest.startTime || null, studentIds: pendingRetest })
                      );
                      if (r) {
                        const m = await r.json();
                        toast({ title: `재시 ${m.studentIds.length}명을 등록했습니다`, description: "부모님 화면 맨 위에 D-day 로 뜹니다." });
                        refetch();
                      }
                    }}
                  >
                    <CalendarPlus className="mr-1 h-4 w-4" />
                    재시 {pendingRetest.length}명 등록
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">한마디 빠른 입력</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-xs text-muted-foreground">학생 한마디 칸을 누른 뒤 아래 문구를 누르면 붙습니다.</p>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_COMMENTS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="rounded-md bg-muted px-2 py-1 text-xs hover:bg-orange-100"
                  onClick={() => {
                    const id = lastFocused.current;
                    if (!id) return toast({ title: "먼저 학생의 한마디 칸을 눌러 주세요" });
                    const cur = rowOf(id).comment ?? "";
                    setComment(id, cur ? `${cur} ${q}` : q);
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value, unit, highlight }: { label: string; value: number | null; unit: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-2.5 ${highlight ? "border-orange-200 bg-orange-50" : "bg-muted/30"}`}>
      <div className="text-[11px] font-semibold text-muted-foreground">{label}</div>
      <div className={`text-lg font-extrabold ${highlight ? "text-orange-600" : ""}`}>
        {value ?? "-"}
        {value != null && <span className="ml-0.5 text-xs font-semibold text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}
