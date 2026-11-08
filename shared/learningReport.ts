/**
 * 학부모 학습 리포트의 계산 규칙. DB 를 모른다.
 *
 * 서버(저장할 때 상태·총점을 정함)와 선생님 화면(입력 중 미리 보여 줌), 부모님 화면이
 * **같은 함수**를 쓴다. 규칙이 두 곳에 있으면 선생님이 본 "6문항 부족" 과 부모님이 본
 * 숫자가 어긋나는 날이 온다.
 */

import { addDays } from "./day";
import type { HomeworkStatus } from "./schema";

// ─── 주 ──────────────────────────────────────────────────────────────────

/** 그 날짜가 속한 주의 월요일. 일요일은 앞 주로 친다(한국 학원의 한 주는 월~일). */
export function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=일
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}

export function isMonday(ymd: string): boolean {
  return mondayOf(ymd) === ymd;
}

/**
 * "11월 1주차". 그 주 월요일이 그 달의 몇 번째 월요일인가로 센다.
 * 달이 목요일에 시작하면 첫 주가 전달로 넘어가는데, 학원 달력도 보통 그렇게 센다.
 */
export function weekLabel(weekStart: string): string {
  const [, m, d] = weekStart.split("-").map(Number);
  return `${m}월 ${Math.floor((d - 1) / 7) + 1}주차`;
}

// ─── 숙제 ────────────────────────────────────────────────────────────────

/**
 * 해온 개수로 상태를 정한다. 개수를 모르면(완료·일부·안함만 고르는 숙제) 고른 값을 그대로 쓴다.
 *
 * 개수가 있는데도 선생님이 고른 상태를 믿지 않는 이유: "20개 중 14개" 를 넣고 "완료" 를 눌러 두면
 * 부모님 화면에 "완료 · 6문항 모자랍니다" 가 같이 뜬다. 숫자가 있으면 숫자가 이긴다.
 */
export function deriveHomeworkStatus(
  totalCount: number | null | undefined,
  doneCount: number | null | undefined,
  chosen: HomeworkStatus | null | undefined
): HomeworkStatus {
  if (totalCount != null && totalCount > 0 && doneCount != null) {
    if (doneCount >= totalCount) return "done";
    if (doneCount <= 0) return "none";
    return "partial";
  }
  return chosen ?? "pending";
}

/** 모자란 개수. 개수를 모르는 숙제면 null. */
export function homeworkShortfall(totalCount: number | null | undefined, doneCount: number | null | undefined): number | null {
  if (totalCount == null || doneCount == null) return null;
  return Math.max(0, totalCount - doneCount);
}

// ─── 시험 ────────────────────────────────────────────────────────────────

/**
 * 총점 = 입력된 영역 점수의 평균을 반올림. 영역이 하나도 없으면 null.
 * 88·76·90 → 84.67 → 85.
 */
export function examTotal(areas: string[], areaScores: Record<string, number>): number | null {
  const vals = areas.map((a) => areaScores[a]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
}

/**
 * 상위 % 를 보여 줄 최소 응시 인원.
 * 4명 반에서 "상위 25%" 는 곧 "2등" 이다. 소수 반에서 순위가 그대로 드러나는 것을 막는다.
 */
export const MIN_TAKERS_FOR_RANK = 5;

export type ScoreRow = { studentId: string; total: number | null; absent?: boolean };

export type ExamStats = {
  takers: number;
  average: number | null; // 소수 첫째 자리
  max: number | null;
  passCount: number | null; // 통과 기준이 없으면 null
  failStudentIds: string[];
  /** 학생별 상위 %. 응시 인원이 적으면 비어 있다. */
  topPct: Record<string, number>;
};

/**
 * 반 평균·최고점·통과 인원·상위 %. 저장하지 않고 읽을 때마다 계산한다 —
 * 점수 하나를 고치면 나머지 숫자가 저절로 맞아야 한다.
 *
 * 상위 % = (나보다 높은 사람 수 + 1) / 응시자 수, 올림. 85점이 10명 중 2등이면 20%.
 * 동점은 같은 등수다(나보다 "높은" 사람만 센다).
 */
export function examStats(rows: ScoreRow[], passScore: number | null | undefined): ExamStats {
  const taken = rows.filter((r): r is ScoreRow & { total: number } => !r.absent && r.total != null);
  const takers = taken.length;
  const totals = taken.map((r) => r.total);
  const average = takers ? Math.round((totals.reduce((s, v) => s + v, 0) / takers) * 10) / 10 : null;
  const max = takers ? Math.max(...totals) : null;
  const fails = passScore != null ? taken.filter((r) => r.total < passScore) : [];
  const topPct: Record<string, number> = {};
  if (takers >= MIN_TAKERS_FOR_RANK) {
    for (const r of taken) {
      const higher = totals.filter((t) => t > r.total).length;
      topPct[r.studentId] = Math.ceil(((higher + 1) / takers) * 100);
    }
  }
  return {
    takers,
    average,
    max,
    passCount: passScore != null ? takers - fails.length : null,
    failStudentIds: fails.map((r) => r.studentId),
    topPct,
  };
}

// ─── 단어시험 ────────────────────────────────────────────────────────────

/**
 * 단어시험 판정 (원장 기준, 2026-11-08):
 *   틀린 비율 10% 이하 → 통과
 *   10% 초과 ~ 15% 이하 → 남아서 틀린 단어 반복쓰기
 *   15% 초과 → 재시험
 * 경계는 "그 비율까지 포함" 이다. 50문항이면 5개 틀림 = 통과, 7개 = 반복쓰기(14%), 8개 = 재시험(16%).
 * 소수 오차로 경계가 뒤집히지 않게 비율이 아니라 정수로 비교한다(wrong*100 ≤ total*10).
 */
export const VOCAB_PASS_PCT = 10;
export const VOCAB_REWRITE_PCT = 15;
export type VocabResult = "pass" | "rewrite" | "retest";

export function vocabResult(total: number, wrong: number): VocabResult {
  if (wrong * 100 <= total * VOCAB_PASS_PCT) return "pass";
  if (wrong * 100 <= total * VOCAB_REWRITE_PCT) return "rewrite";
  return "retest";
}

export const VOCAB_RESULT_LABEL: Record<VocabResult, string> = { pass: "통과", rewrite: "반복쓰기", retest: "재시험" };

// ─── 수업 요일 ───────────────────────────────────────────────────────────

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

/** "2026-11-04" → "수" */
export function dayOfWeekKo(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return DOW_KO[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** 그 주(월요일 시작)에서 주어진 요일들의 날짜. ["월","수"] → ["2026-11-02","2026-11-04"] */
export function weekDatesFor(weekStart: string, days: readonly string[]): string[] {
  const order = ["월", "화", "수", "목", "금", "토", "일"];
  return order.map((d, i) => (days.includes(d) ? addDays(weekStart, i) : null)).filter((x): x is string => x != null);
}

// ─── 확인 번호 ───────────────────────────────────────────────────────────

/** 보호자 번호의 끝 4자리. 숫자가 4개 미만이면 null — 그 학생은 링크를 만들 수 없다. */
export function phoneLast4(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** 선생님 화면 표시용. ***-****-5678 (수납 태블릿과 같은 모양). 앞자리는 집 전화일 수도 있어 가린다. */
export function maskPhone(phone: string | null | undefined): string | null {
  const last4 = phoneLast4(phone);
  return last4 ? `***-****-${last4}` : null;
}
