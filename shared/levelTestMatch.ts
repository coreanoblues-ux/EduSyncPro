/**
 * 상담 기록과 레벨테스트 결과지를 이어 붙이는 규칙.
 *
 * ── 왜 "이름으로 맞춰 보는" 일이 필요한가 ──
 *   현실의 순서가 그렇기 때문이다. 레벨테스트를 받으러 온 학생은 대개
 *   테스트부터 보고, 상담 기록은 그 뒤에 만들어진다. 반대로 전화 문의로
 *   상담 기록이 먼저 생기고 나중에 테스트를 보기도 한다. 어느 쪽이든 두
 *   기록은 서로의 id 를 모른 채 따로 만들어진다.
 *
 *   그래서 level_tests.consultation_id 를 비워 둘 수 있게 만들어 뒀고,
 *   비어 있는 동안에는 사람이 알아보는 방식 — 이름 — 으로 맞춘다.
 *
 * ── 이름만으로 맞추면 위험하지 않은가 ──
 *   동명이인이 문제다. 그래서 연락처가 양쪽에 모두 있는데 서로 다르면
 *   같은 사람으로 보지 않는다. 한쪽만 있거나 둘 다 없으면 이름으로 잇는다.
 *   (연락처는 "010-1234-5678" / "01012345678" 처럼 표기가 제각각이라
 *    숫자만 남겨 뒤 8자리로 비교한다. 지역번호·국가번호 표기 차이를 피하려는 것이다.)
 *
 *   잘못 이어 붙이는 쪽과 못 이어 붙이는 쪽 중 어느 것이 더 나쁜가를 보면,
 *   **남의 성적이 다른 학생 상담 카드에 붙는 쪽**이 훨씬 나쁘다. 그래서
 *   확신이 서지 않으면 잇지 않고 "상담 기록 없는 레벨테스트" 로 남긴다.
 *   원장이 눈으로 보고 직접 연결하면 된다.
 *
 * 이 파일은 화면(client)과 테스트(scripts) 양쪽에서 쓰므로 shared 에 둔다.
 */

export interface LevelTestLike {
  id: string;
  consultationId?: string | null;
  studentName: string;
  parentPhone?: string | null;
  testDate: string; // YYYY-MM-DD
}

export interface ConsultationLike {
  id: string;
  studentName?: string | null;
  phone?: string | null;
}

/** 이름 비교용 정규화. 공백을 모두 없애고 소문자로 맞춘다 ("홍 길동" = "홍길동"). */
export function normalizeName(value?: string | null): string {
  return String(value ?? "").replace(/\s+/g, "").toLowerCase();
}

/** 연락처 비교용. 숫자만 남겨 뒤 8자리를 쓴다. 8자리가 안 되면 빈 문자열(비교 포기). */
export function phoneTail(value?: string | null): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-8) : "";
}

/**
 * 이 레벨테스트 기록이 이 상담 건의 것인가.
 *
 * 1) consultationId 가 박혀 있으면 그것이 정답이다 (나중에 앱이 채워 줄 값).
 * 2) 이름이 다르면 아니다. 한쪽이라도 이름이 비어 있으면 판단하지 않는다.
 * 3) 양쪽 다 연락처가 있는데 다르면 동명이인으로 본다.
 */
export function isSamePerson(consultation: ConsultationLike, row: LevelTestLike): boolean {
  if (row.consultationId) return row.consultationId === consultation.id;

  const a = normalizeName(consultation.studentName);
  const b = normalizeName(row.studentName);
  if (!a || !b || a !== b) return false;

  const pa = phoneTail(consultation.phone);
  const pb = phoneTail(row.parentPhone);
  if (pa && pb && pa !== pb) return false;

  return true;
}

/** 최근 시험이 위로. 같은 날이면 id 로 순서를 고정해 화면이 흔들리지 않게 한다. */
function recentFirst<R extends LevelTestLike>(a: R, b: R): number {
  return b.testDate.localeCompare(a.testDate) || a.id.localeCompare(b.id);
}

/**
 * 상담 목록과 레벨테스트 목록을 한 번에 맞춰 본다.
 *
 * 돌려주는 것:
 *   byConsultation — 상담 id → 그 학생의 레벨테스트 기록(최근 순)
 *   unmatched      — 어느 상담에도 붙지 않은 기록. 테스트만 보고 간 학생이다.
 *                    이 사람들이 상담 화면에서 아예 안 보이면 놓치게 된다.
 */
export function groupLevelTestsByConsultation<C extends ConsultationLike, R extends LevelTestLike>(
  consultations: readonly C[],
  rows: readonly R[]
): { byConsultation: Record<string, R[]>; unmatched: R[] } {
  const byConsultation: Record<string, R[]> = {};
  const matchedIds = new Set<string>();

  for (const c of consultations) {
    const mine = rows.filter((r) => isSamePerson(c, r));
    if (!mine.length) continue;
    byConsultation[c.id] = [...mine].sort(recentFirst);
    for (const r of mine) matchedIds.add(r.id);
  }

  const unmatched = rows.filter((r) => !matchedIds.has(r.id)).sort(recentFirst);
  return { byConsultation, unmatched };
}
