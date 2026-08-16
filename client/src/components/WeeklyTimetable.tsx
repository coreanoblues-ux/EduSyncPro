/**
 * 학원 전체 주간 시간표. 반 관리 페이지 맨 아래에 붙는다.
 *
 * 세로가 시간, 가로가 요일이다. 색은 선생님별로 다르게 준다 — 원장이 시간표를
 * 볼 때 궁금한 건 "이 시간에 누가 수업하나"이지 "무슨 반인가"가 아니기 때문이다.
 *
 * 일정 칸이 자유 입력이라 시각을 못 읽는 반이 있다. 그런 반은 격자에 그리지 않고
 * 아래에 따로 모아 둔다. 아무 데나 그려 넣으면 시간표를 믿을 수 없게 된다.
 *
 * 범례의 선생님을 누르면 그 선생님 시간표만 남는다. 제목을 누르면 다시 전체로
 * 돌아온다. 기본값은 늘 전체다.
 */

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CalendarDays, AlertTriangle } from "lucide-react";
import {
  DAYS,
  type Day,
  type Slot,
  parseSchedule,
  formatMinutes,
} from "@shared/timetable";
import { groupClassesByTeacher, shortClassLabel, type TeacherLike } from "@shared/classLabel";

interface ClassRow {
  id: string;
  name: string;
  teacherId: string;
  schedule: string;
  isActive: boolean;
}

interface Props {
  classes: ClassRow[];
  teachers: TeacherLike[];
}

/**
 * 선생님별 색. 배경은 옅게, 글씨와 왼쪽 띠는 진하게 간다.
 *
 * 색이 강하면 격자가 시끄러워서 오히려 못 읽는다. 칸을 구별할 만큼만 쓴다.
 * 담당 선생님이 여덟 분을 넘으면 색이 돌아 겹치는데, 그때는 칸에 적힌 [표기]로
 * 구별된다.
 */
const PALETTE = [
  { block: "bg-blue-100 text-blue-900 border-l-blue-500", dot: "bg-blue-500" },
  { block: "bg-emerald-100 text-emerald-900 border-l-emerald-500", dot: "bg-emerald-500" },
  { block: "bg-amber-100 text-amber-900 border-l-amber-500", dot: "bg-amber-500" },
  { block: "bg-violet-100 text-violet-900 border-l-violet-500", dot: "bg-violet-500" },
  { block: "bg-rose-100 text-rose-900 border-l-rose-500", dot: "bg-rose-500" },
  { block: "bg-cyan-100 text-cyan-900 border-l-cyan-500", dot: "bg-cyan-500" },
  { block: "bg-lime-100 text-lime-900 border-l-lime-500", dot: "bg-lime-500" },
  { block: "bg-orange-100 text-orange-900 border-l-orange-500", dot: "bg-orange-500" },
];
const NO_TEACHER = { block: "bg-muted text-muted-foreground border-l-muted-foreground", dot: "bg-muted-foreground" };

interface Block extends Slot {
  classId: string;
  label: string;
  /** 칸 안에 적는 짧은 이름. 앞의 [표기]는 색이 이미 말해 주므로 뗀다. */
  short: string;
  /** 범례에서 고른 선생님과 맞춰 보는 값. 담당이 없으면 빈 문자열. */
  teacherKey: string;
  teacherName: string;
  color: (typeof PALETTE)[number];
  /** 같은 시간에 겹친 수업 중 몇 번째인가. 나란히 놓으려고 쓴다. */
  lane: number;
  lanes: number;
}

/** 한 시간 칸의 높이(px). 30분이면 절반이 된다. */
const HOUR_PX = 56;

/**
 * 같은 요일에 시간이 겹치는 수업을 나란히 놓는다.
 *
 * 겹친 걸 위아래로 쌓으면 뒤엣것이 완전히 가려져 시간표에서 사라진 것처럼 보인다.
 * 서로 겹치는 것끼리 한 무리로 묶고, 그 무리 안에서만 자리를 나눈다 — 하루치를
 * 통째로 나누면 겹치지도 않는 수업까지 얇아진다.
 *
 * 한 선생님만 남겨 놓고 보면 겹치는 수업이 줄어드니 자리도 다시 나눈다. 그래야
 * 칸이 넓어져 반 이름이 다 보인다.
 */
function assignLanes(blocks: Block[]): Block[] {
  const out = blocks.map((b) => ({ ...b }));
  for (const day of DAYS) {
    const sameDay = out
      .filter((b) => b.day === day)
      .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

    let cluster: Block[] = [];
    let clusterEnd = -1;
    const flush = () => {
      if (cluster.length === 0) return;
      const laneEnds: number[] = [];
      for (const b of cluster) {
        let lane = laneEnds.findIndex((end) => end <= b.startMin);
        if (lane === -1) {
          lane = laneEnds.length;
          laneEnds.push(0);
        }
        laneEnds[lane] = b.endMin;
        b.lane = lane;
      }
      for (const b of cluster) b.lanes = laneEnds.length;
      cluster = [];
    };
    for (const b of sameDay) {
      if (cluster.length > 0 && b.startMin >= clusterEnd) flush();
      cluster.push(b);
      clusterEnd = Math.max(clusterEnd, b.endMin);
    }
    flush();
  }
  return out;
}

export default function WeeklyTimetable({ classes, teachers }: Props) {
  /** 범례에서 고른 선생님. null이면 전체를 본다(기본값). */
  const [only, setOnly] = useState<string | null>(null);

  const { allBlocks, allUnplaced, legend, startHour, endHour } = useMemo(() => {
    const groups = groupClassesByTeacher(
      classes.filter((c) => c.isActive),
      teachers
    );

    const legend: Array<{
      key: string;
      name: string;
      prefix: string | null;
      color: typeof PALETTE[number];
      count: number;
    }> = [];
    const raw: Block[] = [];
    const unplaced: Array<{ label: string; schedule: string; teacherKey: string; teacherName: string }> = [];

    groups.forEach((g, gi) => {
      const color = g.teacher ? PALETTE[gi % PALETTE.length] : NO_TEACHER;
      const teacherName = g.teacher?.name ?? "담당 미지정";
      const teacherKey = g.teacher?.id ?? "";
      legend.push({ key: teacherKey, name: teacherName, prefix: g.prefix, color, count: g.classes.length });

      for (const c of g.classes) {
        // 요일이 일정에 없으면 반 이름에서 찾는다("[정]주말 고1 오후" → 토·일)
        const slots = parseSchedule(c.schedule, c.label);
        if (slots.length === 0) {
          unplaced.push({
            label: c.label,
            schedule: c.schedule || "(비어 있음)",
            teacherKey,
            teacherName,
          });
          continue;
        }
        for (const s of slots) {
          raw.push({
            ...s,
            classId: c.id,
            label: c.label,
            short: shortClassLabel(c.label),
            teacherKey,
            teacherName,
            color,
            lane: 0,
            lanes: 1,
          });
        }
      }
    });

    // 격자 범위는 실제 수업에 맞춘다. 새벽 0시부터 그리면 빈 칸만 길어진다.
    // 한 선생님만 볼 때도 이 범위를 그대로 쓴다 — 선생님을 바꿔 누를 때마다
    // 눈금이 움직이면 같은 시각이 다른 높이에 그려져 견주어 볼 수가 없다.
    const startHour = raw.length ? Math.floor(Math.min(...raw.map((b) => b.startMin)) / 60) : 9;
    const endHour = raw.length ? Math.ceil(Math.max(...raw.map((b) => b.endMin)) / 60) : 22;

    return { allBlocks: raw, allUnplaced: unplaced, legend, startHour, endHour };
  }, [classes, teachers]);

  // 고른 선생님이 반을 다 잃으면(반 삭제·담당 변경) 아무것도 없는 시간표가 남는다.
  const selected = only !== null && legend.some((l) => l.key === only) ? only : null;

  const blocks = useMemo(
    () => assignLanes(selected === null ? allBlocks : allBlocks.filter((b) => b.teacherKey === selected)),
    [allBlocks, selected]
  );
  const unplaced =
    selected === null ? allUnplaced : allUnplaced.filter((u) => u.teacherKey === selected);
  const selectedName = legend.find((l) => l.key === selected)?.name ?? null;

  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const gridHeight = hours.length * HOUR_PX;
  const topOf = (min: number) => ((min - startHour * 60) / 60) * HOUR_PX;

  return (
    <Card data-testid="weekly-timetable">
      <CardHeader>
        <CardTitle className="text-base">
          <button
            type="button"
            onClick={() => setOnly(null)}
            className="flex items-center gap-2 rounded-sm hover-elevate active-elevate-2 -mx-1 px-1"
            title="전체 시간표로 돌아갑니다"
            data-testid="timetable-show-all"
          >
            <CalendarDays className="h-4 w-4" />
            학원 주간 시간표
            {selectedName && (
              <span className="text-xs font-normal text-muted-foreground">
                — {selectedName} 선생님만 보는 중 (누르면 전체)
              </span>
            )}
          </button>
        </CardTitle>
        <div className="flex flex-wrap gap-x-2 gap-y-1 pt-1">
          {legend.map((l) => {
            const dimmed = selected !== null && selected !== l.key;
            return (
              <button
                key={l.key || "none"}
                type="button"
                // 누른 선생님을 다시 누르면 전체로 돌아온다
                onClick={() => setOnly(selected === l.key ? null : l.key)}
                aria-pressed={selected === l.key}
                title={`${l.name} 선생님 수업만 봅니다`}
                className={`flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs hover-elevate active-elevate-2 ${
                  dimmed ? "text-muted-foreground/50" : "text-muted-foreground"
                } ${selected === l.key ? "bg-accent font-medium text-accent-foreground" : ""}`}
                data-testid={`timetable-legend-${l.key || "none"}`}
              >
                <span className={`h-2.5 w-2.5 rounded-sm ${l.color.dot} ${dimmed ? "opacity-40" : ""}`} />
                {l.name}
                {l.prefix && <span className="font-mono">[{l.prefix}]</span>}
              </button>
            );
          })}
        </div>
      </CardHeader>

      <CardContent>
        {blocks.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {selectedName
              ? `${selectedName} 선생님 반은 일정에 시각이 적혀 있지 않아 그릴 수 없습니다.`
              : "시간이 적힌 반이 없어 시간표를 그릴 수 없습니다."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[720px]">
              {/* 요일 머리 */}
              <div className="flex border-b">
                <div className="w-12 shrink-0" />
                {DAYS.map((d) => (
                  <div
                    key={d}
                    className={`flex-1 pb-2 text-center text-sm font-medium ${
                      d === "토" ? "text-blue-600" : d === "일" ? "text-rose-600" : ""
                    }`}
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* 격자 */}
              <div className="flex" style={{ height: gridHeight }}>
                {/* 시간 눈금 */}
                <div className="relative w-12 shrink-0">
                  {hours.map((h, i) => (
                    <div
                      key={h}
                      className="absolute right-2 -translate-y-1/2 text-xs tabular-nums text-muted-foreground"
                      style={{ top: i * HOUR_PX }}
                    >
                      {h}시
                    </div>
                  ))}
                </div>

                {DAYS.map((day) => (
                  <div key={day} className="relative flex-1 border-l">
                    {/* 한 시간마다 옅은 줄 */}
                    {hours.map((h, i) => (
                      <div
                        key={h}
                        className="absolute inset-x-0 border-t border-dashed border-muted"
                        style={{ top: i * HOUR_PX }}
                      />
                    ))}

                    {blocks
                      .filter((b) => b.day === day)
                      .map((b) => {
                        const top = topOf(b.startMin);
                        const height = ((b.endMin - b.startMin) / 60) * HOUR_PX;
                        // 40분이 안 되는 칸은 글씨 두 줄이 안 들어간다. 셋 이상
                        // 겹쳐 좁아진 칸도 시각을 넣으면 잘려서 오히려 지저분하다.
                        const tight = height < 38 || b.lanes >= 3;
                        return (
                          <div
                            key={`${b.classId}-${b.day}-${b.startMin}`}
                            className={`absolute overflow-hidden rounded-sm border-l-[3px] px-1.5 py-0.5 ${b.color.block}`}
                            style={{
                              top,
                              height: Math.max(height - 2, 16),
                              left: `${(b.lane / b.lanes) * 100}%`,
                              width: `calc(${100 / b.lanes}% - 3px)`,
                            }}
                            title={`${b.label} · ${b.teacherName} · ${formatMinutes(b.startMin)}-${formatMinutes(b.endMin)}${
                              b.guessedMeridiem ? " (오전/오후가 적혀 있지 않아 오후로 봤습니다)" : ""
                            }`}
                            data-testid={`timetable-block-${b.classId}-${b.day}`}
                          >
                            <div className="truncate text-[11px] font-medium leading-tight">
                              {b.short}
                              {b.guessedMeridiem && <span className="opacity-60"> ?</span>}
                            </div>
                            {!tight && (
                              <div className="truncate text-[10px] leading-tight opacity-75">
                                {formatMinutes(b.startMin)}-{formatMinutes(b.endMin)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {blocks.some((b) => b.guessedMeridiem) && (
          <p className="mt-3 text-xs text-muted-foreground">
            ? 표시는 일정에 오전·오후가 없어 오후로 본 수업입니다. 반 수정에서
            "19:00-21:00"처럼 적으면 추측하지 않습니다.
          </p>
        )}

        {unplaced.length > 0 && (
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-amber-900">
              <AlertTriangle className="h-4 w-4" />
              시간표에 넣지 못한 반 {unplaced.length}개
            </p>
            <p className="mt-1 text-xs text-amber-800">
              일정에서 요일이나 시각을 읽지 못했습니다. 반 수정에서 "월 수 금
              19:00-21:00"처럼 적으면 시간표에 올라갑니다.
            </p>
            <ul className="mt-2 space-y-0.5">
              {unplaced.map((u) => (
                <li key={u.label} className="text-xs text-amber-900">
                  <span className="font-medium">{u.label}</span>
                  <span className="opacity-70"> · {u.teacherName} · 현재 일정: "{u.schedule}"</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
