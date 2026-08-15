/**
 * 날짜를 "YYYY-MM-DD" 문자열로만 다루는 유틸.
 *
 * 퇴근전 할 일은 하루 단위 기능이라 시각이 필요 없다. Date 객체로 들고 다니면
 * 서버(UTC)와 브라우저(KST)가 자정 근처에서 서로 다른 "오늘"을 갖게 되어,
 * 밤 10시에 적은 할 일이 전날 목록에 들어가는 일이 생긴다.
 * 문자열은 사전순 비교가 곧 날짜순 비교라 정렬·대소 비교도 그냥 된다.
 */

/** 어느 시각이 한국에서는 며칠인가. 테스트가 시각을 고정할 수 있도록 분리했다. */
export function ymdKst(d: Date): string {
  return toYmd(new Date(d.getTime() + 9 * 60 * 60 * 1000), true);
}

/** 한국 시각 기준 오늘. 서버가 어느 지역에서 돌든 학원의 하루에 맞춘다. */
export function todayKst(): string {
  return ymdKst(new Date());
}

/** Date를 YYYY-MM-DD로. utc=true면 이미 KST만큼 밀어 둔 값이라는 뜻이다. */
export function toYmd(d: Date, utc = false): string {
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const m = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = utc ? d.getUTCDate() : d.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "2026-08-31" + 1 → "2026-09-01". 월말·윤년은 Date에게 맡긴다. */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return toYmd(new Date(Date.UTC(y, m - 1, d + n)), true);
}

/** from에서 to까지 며칠인가. 밀린 날수를 셀 때 쓴다. */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000
  );
}
