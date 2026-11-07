/**
 * ③ 보강 계획 탭.
 *
 * 보강은 "일정" 이라 주 공개를 기다리지 않고 등록하는 순간 부모님 화면에 보인다(PLAN §6).
 * 그래서 잡는 칸 바로 위에 "부모님께 보이는 문구" 를 따로 받는다 — 교사용 메모가 그대로 나가지 않게.
 *
 * 보강이 끝나면 학생 이름을 눌러 완료/불참으로 바꾼다. 누를 때마다 예정 → 완료 → 불참 → 예정 순으로 돈다.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { MAKEUP_REASONS, type MakeupReason } from "@shared/schema";
import { addDays, daysBetween, todayKst } from "@shared/day";
import { API, bundleKey, usePatchBundle, type MakeupRow, type Track, type WeekBundle } from "./shared";

type Props = { bundle: WeekBundle; track: Track };

const REASON_LABEL: Record<MakeupReason, string> = { retest: "재시", homework: "숙제 부족", absence: "결석", other: "기타" };
const REASON_CLASS: Record<string, string> = {
  retest: "bg-orange-100 text-orange-800",
  homework: "bg-slate-100 text-slate-700",
  absence: "bg-blue-100 text-blue-700",
  other: "bg-slate-100 text-slate-700",
};
const NEXT_STATUS: Record<string, string> = { scheduled: "done", done: "noshow", noshow: "scheduled" };
const DOW = ["일", "월", "화", "수", "목", "금", "토"];

function dateParts(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { m, d, dow: DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
}

function timeLabel(t: string | null) {
  if (!t) return "";
  const [h, mm] = t.split(":").map(Number);
  return `${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}시${mm ? ` ${mm}분` : ""}`;
}

export default function MakeupTab({ bundle, track }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const today = todayKst();
  const classId = bundle.class.id;
  const patchBundle = usePatchBundle(classId, bundle.weekStart);
  const refetch = () => qc.invalidateQueries({ queryKey: bundleKey(classId, bundle.weekStart) });

  const defaultDate = today >= bundle.weekStart && today <= addDays(bundle.weekStart, 6) ? addDays(today, 1) : bundle.weekStart;
  const [form, setForm] = useState({
    studentIds: [] as string[],
    date: defaultDate,
    startTime: "17:00",
    minutes: "60",
    reason: "homework" as MakeupReason,
    content: "",
  });

  const toggleStudent = (id: string) =>
    setForm((f) => ({ ...f, studentIds: f.studentIds.includes(id) ? f.studentIds.filter((x) => x !== id) : [...f.studentIds, id] }));

  const create = async () => {
    const r = await track(
      apiRequest("POST", `${API}/makeups`, {
        classId,
        date: form.date,
        startTime: form.startTime || null,
        minutes: Number(form.minutes) || null,
        reason: form.reason,
        content: form.content.trim(),
        studentIds: form.studentIds,
      })
    );
    if (!r) return;
    toast({ title: `${form.studentIds.length}명 보강을 잡았습니다`, description: "부모님 화면 일정에 바로 보입니다." });
    setForm((f) => ({ ...f, studentIds: [], content: "" }));
    refetch();
  };

  const cycleStatus = (m: MakeupRow, studentId: string, current: string) => {
    const status = NEXT_STATUS[current] ?? "scheduled";
    patchBundle((b) => ({
      ...b,
      makeups: b.makeups.map((x) =>
        x.id === m.id ? { ...x, students: x.students.map((s) => (s.studentId === studentId ? { ...s, status } : s)) } : x
      ),
    }));
    track(apiRequest("PATCH", `${API}/makeups/${m.id}/students/${studentId}`, { status }));
  };

  const remove = async (m: MakeupRow) => {
    if (!window.confirm(`${m.date} "${m.content}" 보강을 지울까요? 부모님 화면에서도 사라집니다.`)) return;
    if (await track(apiRequest("DELETE", `${API}/makeups/${m.id}`))) refetch();
  };

  const upcoming = bundle.makeups.filter((m) => m.date >= today);
  const past = bundle.makeups.filter((m) => m.date < today).reverse();

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <Card className="min-w-0">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            잡힌 보강 <span className="ml-1 text-xs font-normal text-muted-foreground">이 반 · 앞뒤 한 달</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {bundle.makeups.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">아직 잡힌 보강이 없습니다.</p>}
          {[...upcoming, ...past].map((m) => {
            const { m: mm, d, dow } = dateParts(m.date);
            const isPast = m.date < today;
            const dday = daysBetween(today, m.date);
            const noshow = m.students.filter((s) => s.status === "noshow").length;
            const allDone = m.students.length > 0 && m.students.every((s) => s.status === "done");
            return (
              <div key={m.id} className={`flex items-center gap-3 border-b py-2.5 ${isPast ? "opacity-70" : ""}`} data-testid={`row-makeup-${m.id}`}>
                <div className="flex w-12 shrink-0 flex-col items-center rounded-lg bg-muted py-1">
                  <span className="text-[10px] font-semibold text-muted-foreground">
                    {mm}월 · {dow}
                  </span>
                  <span className="text-lg font-extrabold leading-tight">{d}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <b className="truncate text-sm">{m.content}</b>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${REASON_CLASS[m.reason] ?? REASON_CLASS.other}`}>
                      {REASON_LABEL[m.reason as MakeupReason] ?? m.reason}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {timeLabel(m.startTime)}
                    {m.minutes ? ` · ${m.minutes}분` : ""}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {m.students.map((s) => (
                      <button
                        key={s.studentId}
                        type="button"
                        title="누르면 예정 → 완료 → 불참 순으로 바뀝니다"
                        onClick={() => cycleStatus(m, s.studentId, s.status)}
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          s.status === "done"
                            ? "bg-green-100 text-green-700"
                            : s.status === "noshow"
                              ? "bg-red-100 text-red-700 line-through"
                              : "bg-muted text-foreground"
                        }`}
                      >
                        {s.name}
                        {s.status === "done" ? " ✓" : s.status === "noshow" ? " 불참" : ""}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  {allDone ? (
                    <Badge className="bg-green-100 text-green-700 hover:bg-green-100">완료</Badge>
                  ) : noshow ? (
                    <Badge className="bg-red-100 text-red-700 hover:bg-red-100">불참 {noshow}</Badge>
                  ) : isPast ? (
                    <Badge variant="secondary">지남 · 상태 표시 필요</Badge>
                  ) : (
                    <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">{dday === 0 ? "오늘" : `예정 · D-${dday}`}</Badge>
                  )}
                </div>
                <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => remove(m)} aria-label="보강 삭제">
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            );
          })}
          {bundle.makeups.length > 0 && (
            <p className="pt-2 text-xs text-muted-foreground">
              보강이 끝나면 <b className="text-orange-600">학생 이름을 눌러</b> 완료 / 불참으로 바꿔 주세요. 불참은 부모님 화면에 따로 표시됩니다.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        {bundle.suggestions.length > 0 && (
          <Card className="border-orange-200 bg-orange-50/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-base text-orange-800">보강이 필요해 보이는 학생</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-2 text-xs text-muted-foreground">이번 주 숙제·시험 기록에서 찾았어요. 누르면 아래에서 선택됩니다.</p>
              <div className="flex flex-wrap gap-1.5">
                {bundle.suggestions.map((s) => (
                  <button
                    key={s.studentId}
                    type="button"
                    onClick={() => toggleStudent(s.studentId)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                      form.studentIds.includes(s.studentId) ? "border-orange-500 bg-orange-500 text-white" : "border-orange-300 bg-white text-orange-700"
                    }`}
                  >
                    {s.name} · {s.reasons.join(", ")}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">새 보강 잡기</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">학생 (여러 명 가능)</Label>
              <div className="flex flex-wrap gap-1.5">
                {bundle.students.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    data-testid={`pick-${s.id}`}
                    onClick={() => toggleStudent(s.id)}
                    className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                      form.studentIds.includes(s.id) ? "border-orange-500 bg-orange-500 text-white" : "bg-background text-muted-foreground"
                    }`}
                  >
                    {s.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">날짜</Label>
                <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">시간</Label>
                <Input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">사유</Label>
                <Select value={form.reason} onValueChange={(v) => setForm({ ...form, reason: v as MakeupReason })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MAKEUP_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {REASON_LABEL[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">소요</Label>
                <Select value={form.minutes} onValueChange={(v) => setForm({ ...form, minutes: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["30", "60", "90", "120"].map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}분
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">내용 (부모님께 그대로 보이는 문구)</Label>
              <Input
                data-testid="input-makeup-content"
                placeholder="예: 워크북 문법 보충 p.34–35"
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
              />
            </div>
            <Button
              data-testid="button-create-makeup"
              className="w-full bg-orange-500 hover:bg-orange-600"
              disabled={form.studentIds.length === 0 || !form.date || !form.content.trim()}
              onClick={create}
            >
              {form.studentIds.length ? `${form.studentIds.length}명 보강 잡기` : "학생을 골라 주세요"}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
