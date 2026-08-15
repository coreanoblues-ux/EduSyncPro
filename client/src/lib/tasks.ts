/**
 * 밀린 할 일의 경고 강도.
 *
 * 퇴근전 할 일 페이지와 대시보드가 같은 색을 써야 한다. 한쪽에서만 빨갛게 보이면
 * 원장이 "대시보드에는 급한 게 없네" 하고 넘어간다.
 */
export interface TaskSeverity {
  level: 0 | 1 | 2 | 3;
  /** 카드(줄) 테두리·배경 */
  card: string;
  /** "N일 밀림" 배지 */
  badge: string;
  /** 제목 글자색 */
  title: string;
}

export function taskSeverity(daysLate: number): TaskSeverity {
  if (daysLate >= 3) {
    return {
      level: 3,
      card: "border-red-500 bg-red-500/10 dark:bg-red-500/15",
      badge: "bg-red-600 text-white border-transparent",
      title: "text-red-700 dark:text-red-300",
    };
  }
  if (daysLate === 2) {
    return {
      level: 2,
      card: "border-orange-500 bg-orange-500/10 dark:bg-orange-500/15",
      badge: "bg-orange-500 text-white border-transparent",
      title: "text-orange-700 dark:text-orange-300",
    };
  }
  if (daysLate === 1) {
    return {
      level: 1,
      card: "border-amber-500 bg-amber-400/10 dark:bg-amber-500/15",
      badge: "bg-amber-500 text-white border-transparent",
      title: "text-amber-700 dark:text-amber-300",
    };
  }
  return { level: 0, card: "border-border bg-card", badge: "", title: "" };
}
