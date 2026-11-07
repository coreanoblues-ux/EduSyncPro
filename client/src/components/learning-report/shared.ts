/**
 * 학습 기록 입력 화면의 공용 타입과 자동 저장 장치.
 *
 * 저장 버튼이 없다. 칸을 고치면 잠깐 뒤 저장되고, 화면 아래에 "자동 저장됨 · 시각" 이 뜬다.
 * 저장 버튼을 두면 강사가 누르는 걸 잊고 다른 반으로 넘어가 입력이 통째로 사라진다 —
 * 하루에 반 여러 개를 연달아 입력하는 일이라 그 사고가 반드시 난다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HomeworkStatus } from "@shared/schema";
import type { ExamStats } from "@shared/learningReport";

// ─── 서버가 주는 한 주 묶음 (server/learning-report/routes.ts weekBundle) ───

export type CheckCell = { status: HomeworkStatus; doneCount: number | null };

export type HomeworkRow = {
  id: string;
  title: string;
  totalCount: number | null;
  countUnit: string | null;
  dueDate: string | null;
  sortOrder: number;
  checks: Record<string, CheckCell>;
};

export type ScoreRow = {
  studentId: string;
  areaScores: Record<string, number>;
  total: number | null;
  absent: boolean;
  comment: string | null;
};

export type ExamRow = {
  id: string;
  name: string;
  kind: string;
  examDate: string;
  passScore: number | null;
  areas: string[];
  scores: ScoreRow[];
  stats: ExamStats;
};

export type MakeupRow = {
  id: string;
  date: string;
  startTime: string | null;
  minutes: number | null;
  reason: string;
  content: string;
  examId: string | null;
  students: { studentId: string; status: string; name: string }[];
};

export type PhotoRow = {
  id: string;
  title: string;
  takenDate: string;
  studentId: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  /** 보관 기간(6개월)이 지나 원본이 지워졌다. 제목·날짜만 남는다. */
  purged: boolean;
};

export type WeekBundle = {
  class: { id: string; name: string; subject: string };
  weekStart: string;
  label: string;
  week: {
    id: string;
    textbook: string | null;
    unit: string | null;
    topic: string | null;
    progressPct: number | null;
    publishedAt: string | null;
  } | null;
  students: { id: string; name: string; grade: string | null }[];
  defaultAreas: string[];
  homework: HomeworkRow[];
  exams: ExamRow[];
  photos: PhotoRow[];
  makeups: MakeupRow[];
  suggestions: { studentId: string; name: string; reasons: string[] }[];
};

export const bundleKey = (classId: string, weekStart: string) =>
  ["/api/learning-report/classes", classId, "weeks", weekStart] as const;

export const API = "/api/learning-report";

/** 묶음 캐시를 그 자리에서 고친다. 칸 하나 고칠 때마다 서버에서 다시 받으면 입력 중인 칸이 깜빡인다. */
export function usePatchBundle(classId: string, weekStart: string) {
  const qc = useQueryClient();
  return useCallback(
    (fn: (b: WeekBundle) => WeekBundle) => {
      qc.setQueryData<WeekBundle>(bundleKey(classId, weekStart), (old) => (old ? fn(old) : old));
    },
    [qc, classId, weekStart]
  );
}

// ─── 저장 상태 ────────────────────────────────────────────────────────────

export type SaveState = { pending: number; lastSavedAt: Date | null; error: string | null };

export type Track = <T>(p: Promise<T>) => Promise<T | undefined>;

/** 진행 중인 저장 수·마지막 저장 시각·마지막 오류. 화면 아래 줄이 이것만 본다. */
export function useSaveTracker(): [SaveState, Track] {
  const [state, setState] = useState<SaveState>({ pending: 0, lastSavedAt: null, error: null });
  const track: Track = useCallback(async (p) => {
    setState((s) => ({ ...s, pending: s.pending + 1 }));
    try {
      const v = await p;
      setState((s) => ({ pending: s.pending - 1, lastSavedAt: new Date(), error: null }));
      return v;
    } catch (e) {
      const msg = (e as Error).message.replace(/^\d{3}: /, "");
      setState((s) => ({ ...s, pending: s.pending - 1, error: msg }));
      return undefined;
    }
  }, []);
  return [state, track];
}

/**
 * 같은 칸(key)을 연달아 고치면 마지막 것만 잠시 뒤 보낸다. "1" → "14" 를 치는 동안 두 번 저장하지 않는다.
 * 화면을 떠날 때(반·주 바꾸기, 다른 메뉴) 기다리던 저장은 **즉시 보낸다** — 버리면 마지막 칸이 사라진다.
 */
export function useDebounced(delay = 700) {
  const timers = useRef(new Map<string, { t: ReturnType<typeof setTimeout>; fn: () => void }>());
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const { t, fn } of Array.from(map.values())) {
        clearTimeout(t);
        fn();
      }
      map.clear();
    };
  }, []);
  return useCallback(
    (key: string, fn: () => void) => {
      const prev = timers.current.get(key);
      if (prev) clearTimeout(prev.t);
      const t = setTimeout(() => {
        timers.current.delete(key);
        fn();
      }, delay);
      timers.current.set(key, { t, fn });
    },
    [delay]
  );
}

/** 빈 칸은 null. 숫자가 아니면 null. */
export function toIntOrNull(s: string): number | null {
  const v = s.trim();
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function orNull(s: string): string | null {
  const v = s.trim();
  return v === "" ? null : v;
}
