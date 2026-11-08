/**
 * 단어시험 탭.
 *
 * 페이지원은 본수업·클리닉 상관없이 **올 때마다** 단어시험을 본다(주 2~3회). 그래서 입력이 가장 잦은 화면이다.
 * 선생님이 치는 것은 **틀린 개수 하나**뿐이다. 총 문항은 학생마다 조금씩 달라서 그 학생의 지난번 값을
 * 기본으로 채우고, 판정(통과 · 반복쓰기 · 재시험)은 shared/learningReport.ts 의 vocabResult 가 정한다.
 *
 * 칸이 비어 있으면 "그날 기록 없음" 이다 — 결석이나 클리닉을 안 듣는 학생의 금요일이 그렇다.
 * 부모님 화면에는 기록이 있는 날만 나가므로 "3회 중 2회" 처럼 억울하게 보이지 않는다.
 */

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { addDays } from "@shared/day";
import { VOCAB_PASS_PCT, VOCAB_REWRITE_PCT, dayOfWeekKo, vocabResult, type VocabResult } from "@shared/learningReport";
import { API, toIntOrNull, usePatchBundle, type Track, type VocabRow, type WeekBundle } from "./shared";
import LocalInput from "./LocalInput";

type Props = { bundle: WeekBundle; track: Track; schedule: (key: string, fn: () => void) => void };

/** 기록도 지난번 값도 없을 때의 총 문항. 첫 시험만 이 값이고 그다음부터는 학생별로 기억된다. */
const FALLBACK_TOTAL = 50;

const RESULT_BADGE: Record<VocabResult, string> = {
  pass: "bg-green-100 text-green-700 hover:bg-green-100",
  rewrite: "bg-orange-100 text-orange-700 hover:bg-orange-100",
  retest: "bg-red-100 text-red-700 hover:bg-red-100",
};
const RESULT_SHORT: Record<VocabResult, string> = { pass: "통과", rewrite: "반복쓰기", retest: "재시험" };

function dateLabel(ymd: string) {
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))} (${dayOfWeekKo(ymd)})`;
}

export default function VocabTab({ bundle, track, schedule }: Props) {
  const classId = bundle.class.id;
  const weekStart = bundle.weekStart;
  const weekPath = `${API}/classes/${classId}/weeks/${weekStart}`;
  const patchBundle = usePatchBundle(classId, weekStart);

  // 수업 요일에 없는 날(클리닉 날 등)을 선생님이 더한 칸. 기록이 하나라도 생기면 서버 목록에도 들어간다.
  const [extraDates, setExtraDates] = useState<string[]>([]);
  // 아직 기록이 없는 칸에 미리 바꿔 둔 총 문항 ("학생|날짜" → 총 문항)
  const [draftTotals, setDraftTotals] = useState<Record<string, number>>({});

  const dates = useMemo(() => Array.from(new Set([...bundle.vocab.dates, ...extraDates])).sort(), [bundle.vocab.dates, extraDates]);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const addable = weekDays.filter((d) => !dates.includes(d));

  const rowOf = (studentId: string, date: string): VocabRow | undefined =>
    bundle.vocab.scores.find((v) => v.studentId === studentId && v.testDate === date);

  /** 칸의 총 문항: 기록 → 미리 바꿔 둔 값 → 그 학생 지난번 값 → 이 날짜 다른 학생 값 → 50 */
  const totalFor = (studentId: string, date: string): number => {
    const r = rowOf(studentId, date);
    if (r) return r.total;
    const draft = draftTotals[`${studentId}|${date}`];
    if (draft) return draft;
    const last = bundle.vocab.lastTotals[studentId];
    if (last) return last;
    const sameDay = bundle.vocab.scores.find((v) => v.testDate === date);
    return sameDay?.total ?? FALLBACK_TOTAL;
  };

  const save = (studentId: string, date: string, total: number, wrong: number | null, retestPassed?: boolean | null, immediate = false) => {
    patchBundle((b) => {
      const others = b.vocab.scores.filter((v) => !(v.studentId === studentId && v.testDate === date));
      const prev = b.vocab.scores.find((v) => v.studentId === studentId && v.testDate === date);
      const scores =
        wrong == null
          ? others
          : [
              ...others,
              {
                studentId,
                testDate: date,
                total,
                wrong,
                retestPassed: vocabResult(total, wrong) === "retest" ? (retestPassed !== undefined ? retestPassed : prev?.retestPassed ?? null) : null,
              },
            ];
      return { ...b, vocab: { ...b.vocab, scores } };
    });
    const send = () =>
      track(apiRequest("PUT", `${weekPath}/vocab`, { entries: [{ studentId, testDate: date, total, wrong, ...(retestPassed !== undefined ? { retestPassed } : {}) }] }));
    if (immediate) send();
    else schedule(`vocab:${classId}:${studentId}:${date}`, send);
  };

  const setWrong = (studentId: string, date: string, v: string) => {
    const total = totalFor(studentId, date);
    const n = toIntOrNull(v);
    save(studentId, date, total, n == null ? null : Math.max(0, Math.min(total, n)));
  };

  // 총 문항 칸은 **칸을 떠날 때만** 반영한다. 칠 때마다 반영하면 "40" 을 치는 도중의 "4" 에서
  // 틀린 개수가 4 로 깎여 기록이 망가진다.
  const setTotal = (studentId: string, date: string, v: string) => {
    const t = toIntOrNull(v);
    if (!t || t < 1) return;
    const r = rowOf(studentId, date);
    if (r && r.total === t) return;
    // 같은 칸의 저장 이름으로 보낸다 — 방금 친 틀린 개수가 아직 대기 중이면 하나로 합쳐져 옛 총 문항이 뒤늦게 덮어쓰지 않는다.
    if (r) save(studentId, date, t, Math.min(r.wrong, t));
    else setDraftTotals((d) => ({ ...d, [`${studentId}|${date}`]: t }));
  };

  /** 한 날짜의 총 문항을 그 반 전체에 맞춘다. 기록이 있는 칸은 저장까지, 빈 칸은 기본값만 바꾼다. */
  const setColumnTotal = (date: string, v: string) => {
    const t = toIntOrNull(v);
    if (!t || t < 1) return;
    const entries = bundle.students
      .map((s) => rowOf(s.id, date))
      .filter((r): r is VocabRow => !!r)
      .map((r) => ({ studentId: r.studentId, testDate: date, total: t, wrong: Math.min(r.wrong, t) }));
    setDraftTotals((d) => ({ ...d, ...Object.fromEntries(bundle.students.map((s) => [`${s.id}|${date}`, t])) }));
    patchBundle((b) => ({
      ...b,
      vocab: { ...b.vocab, scores: b.vocab.scores.map((x) => (x.testDate === date ? { ...x, total: t, wrong: Math.min(x.wrong, t) } : x)) },
    }));
    if (entries.length) track(apiRequest("PUT", `${weekPath}/vocab`, { entries }));
  };

  if (bundle.students.length === 0) {
    return <p className="py-16 text-center text-sm text-muted-foreground">이 반에 수강 중인 학생이 없습니다.</p>;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">단어시험</CardTitle>
          <span className="text-xs text-muted-foreground">
            <b className="text-foreground">틀린 개수만</b> 넣으세요 · 틀린 비율 {VOCAB_PASS_PCT}% 이하 <b className="text-green-700">통과</b> · {VOCAB_REWRITE_PCT}% 이하{" "}
            <b className="text-orange-600">반복쓰기</b> · 그 이상 <b className="text-red-700">재시험</b>
          </span>
          {addable.length > 0 && (
            <div className="ml-auto">
              <Select value="" onValueChange={(d) => setExtraDates((x) => [...x, d])}>
                <SelectTrigger className="h-8 w-40 text-xs" data-testid="select-add-vocab-date">
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  <SelectValue placeholder="날짜 추가 (클리닉 등)" />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((d) => (
                    <SelectItem key={d} value={d}>
                      {dateLabel(d)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {bundle.vocab.classDays.length === 0 && (
          <p className="text-xs text-amber-700">이 반 수업 시간에서 요일을 읽지 못했습니다. 오른쪽 "날짜 추가" 로 시험 날짜를 넣어 주세요.</p>
        )}
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {dates.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">"날짜 추가" 로 이번 주 단어시험 날짜를 넣어 주세요.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-2 py-2 font-semibold">학생</th>
                {dates.map((d) => (
                  <th key={d} className="px-2 py-2 font-semibold">
                    <div className="whitespace-nowrap">{dateLabel(d)}</div>
                    <div className="mt-1 flex items-center gap-1 font-normal">
                      <span className="text-[10px]">전원 총 문항</span>
                      <LocalInput
                        className="h-6 w-12 px-1 text-center text-[11px]"
                        inputMode="numeric"
                        placeholder="-"
                        value={null}
                        onValueChange={() => {}}
                        onBlur={(e) => setColumnTotal(d, e.currentTarget.value)}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                        data-testid={`input-col-total-${d}`}
                      />
                    </div>
                  </th>
                ))}
                <th className="px-2 py-2 font-semibold">이번 주</th>
              </tr>
            </thead>
            <tbody>
              {bundle.students.map((s) => {
                const rows = dates.map((d) => rowOf(s.id, d)).filter((r): r is VocabRow => !!r);
                const counts = { pass: 0, rewrite: 0, retest: 0 } as Record<VocabResult, number>;
                for (const r of rows) counts[vocabResult(r.total, r.wrong)]++;
                const flagged = counts.retest > 0 || counts.rewrite > 0;
                return (
                  <tr key={s.id} className={`border-b ${flagged ? "bg-orange-50/60" : ""}`} data-testid={`row-vocab-${s.id}`}>
                    <td className="whitespace-nowrap px-2 py-1.5 font-bold">{s.name}</td>
                    {dates.map((d) => {
                      const r = rowOf(s.id, d);
                      const result = r ? vocabResult(r.total, r.wrong) : null;
                      return (
                        <td key={d} className="px-2 py-1.5">
                          <div className="flex items-center gap-1">
                            <LocalInput
                              className="h-8 w-12 text-center font-bold"
                              inputMode="numeric"
                              placeholder="-"
                              value={r?.wrong}
                              onValueChange={(v) => setWrong(s.id, d, v)}
                              data-testid={`input-vocab-${s.id}-${d}`}
                            />
                            <span className="text-[11px] text-muted-foreground">/</span>
                            <LocalInput
                              className="h-6 w-10 border-dashed px-1 text-center text-[11px] text-muted-foreground"
                              inputMode="numeric"
                              title="총 문항 (이 학생만)"
                              value={totalFor(s.id, d)}
                              onValueChange={() => {}}
                              onBlur={(e) => setTotal(s.id, d, e.currentTarget.value)}
                              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                            />
                            {result && <Badge className={`ml-0.5 whitespace-nowrap px-1.5 text-[10px] ${RESULT_BADGE[result]}`}>{RESULT_SHORT[result]}</Badge>}
                          </div>
                          {result === "retest" && (
                            <label className="mt-1 flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground">
                              <Checkbox
                                checked={r?.retestPassed === true}
                                onCheckedChange={(c) => save(s.id, d, r!.total, r!.wrong, c === true ? true : null, true)}
                              />
                              재시 통과
                            </label>
                          )}
                        </td>
                      );
                    })}
                    <td className="whitespace-nowrap px-2 py-1.5 text-xs">
                      {rows.length === 0 ? (
                        <span className="text-muted-foreground/60">기록 없음</span>
                      ) : (
                        <span>
                          {counts.pass > 0 && <b className="text-green-700">통과 {counts.pass}</b>}
                          {counts.rewrite > 0 && <b className="ml-1.5 text-orange-600">반복쓰기 {counts.rewrite}</b>}
                          {counts.retest > 0 && <b className="ml-1.5 text-red-700">재시험 {counts.retest}</b>}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          빈칸은 "그날 기록 없음" 입니다(결석, 클리닉 안 듣는 날 등). 부모님 화면에는 기록이 있는 날만 보입니다. 총 문항은 학생마다 지난번 값이 기본으로 들어갑니다.
        </p>
      </CardContent>
    </Card>
  );
}
