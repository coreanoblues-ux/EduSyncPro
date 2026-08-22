/**
 * 반 이름 앞에 담당 교사 표기를 붙이고, 교사별로 묶어 정렬한다.
 *
 * 원장이 반을 고르는 기준은 사실상 "누구 반이냐"다. 그런데 반 이름은 자유 입력이라
 * 어떤 건 `[정]월 수 심화A`처럼 교사 표기가 붙어 있고 어떤 건 `화 목 A`처럼 없다.
 * 표기가 없는 반은 목록 아무 데나 흩어져서 찾기가 어렵다.
 *
 * **DB의 이름은 건드리지 않는다.** 여기서 만드는 건 화면에 보여줄 이름뿐이다.
 * 그래야 원장이 반 이름을 자기 방식대로 계속 고칠 수 있고, 담당 교사를 바꾸면
 * 표기가 알아서 따라온다. 묶는 기준도 대괄호 글자가 아니라 teacherId다.
 */

export interface TeacherLike {
  id: string;
  name: string;
}

export interface ClassLike {
  id: string;
  name: string;
  teacherId: string;
  /** 스케줄 기반 정렬(월수 → 화목 → 주말 등)을 원할 때 있으면 참고한다. */
  schedule?: string;
}

/**
 * 드롭다운 정렬을 원장의 습관에 맞추는 옵션.
 *
 * 기본 동작은 "반이 많은 교사가 위, 묶음 안에서는 이름순"이라 대부분의 경우 충분하지만,
 * 원장이 특정 순서를 고집하는 화면(예: 상담→학생 전환 다이얼로그)에서는 이 옵션으로 덮는다.
 */
export interface OrderOptions {
  /**
   * 이 순서대로 교사를 앞에 배치한다. 여기에 없는 교사는 기존 규칙(개수순)으로 그 뒤에 붙는다.
   * 원장이 "이 사람 반을 제일 자주 고른다"고 정해 둔 경우에 쓴다.
   */
  teacherOrder?: string[];
  /**
   * 같은 교사의 반들 안에서 스케줄로 먼저 묶는 기준. 예: `["월수", "화목", "주말"]`.
   * 지정된 키워드에 걸리지 않는 반은 뒤로 밀린다. 지정 안 하면 기존처럼 이름순.
   */
  scheduleOrder?: string[];
}

/**
 * 반의 `schedule` 문자열이 키워드에 해당하는지 판정한다.
 *
 * DB에는 "월수", "월 수 금", "화목", "주말", "토일" 같은 표기가 섞여 있어서 단순
 * `includes`로는 부족하다. `월수`는 월과 수가 모두 있어야 하고, `주말`은 실제 "주말"
 * 표기나 토/일 요일이 들어 있어야 걸린다.
 */
function scheduleMatchesKeyword(schedule: string, kw: string): boolean {
  if (kw === "월수") return /월/.test(schedule) && /수/.test(schedule);
  if (kw === "화목") return /화/.test(schedule) && /목/.test(schedule);
  if (kw === "주말") return /주말/.test(schedule) || /[토일]/.test(schedule);
  return schedule.includes(kw);
}

function scheduleRank(schedule: string | undefined, order: string[]): number {
  const s = (schedule ?? "").trim();
  if (!s) return order.length;
  for (let i = 0; i < order.length; i++) {
    if (scheduleMatchesKeyword(s, order[i])) return i;
  }
  return order.length;
}

/** 이름 맨 앞의 `[...]` 표기를 떼어 낸다. 없으면 null. */
function leadingTag(className: string): string | null {
  const m = className.trim().match(/^\[([^\]]+)\]/);
  return m ? m[1] : null;
}

/**
 * 교사별 대괄호 표기를 정한다.
 *
 * **표기를 지어내기 전에 원장이 이미 쓰고 있는 표기를 먼저 읽는다.** 그 교사의
 * 반 이름에 가장 많이 붙어 있는 표기를 그대로 쓴다. 그래야 새로 붙는 표기가
 * 기존 표기와 어긋나지 않는다 — 정우석 선생님 반이 `[정]`과 `[정우석]`으로
 * 갈라지면 묶어 놓은 의미가 없다.
 *
 * 이 학원의 실제 규칙이 그렇다. 정우석=`[정]`, 정경란=`[란]`(성이 같아서 원장이
 * 이름 끝 글자를 골랐다), 이홍석=`[국어-이]`(과목까지 넣었다). 셋 다 성 한 글자로
 * 기계적으로 정했다면 하나도 맞지 않는다.
 *
 * 쓰던 표기가 없는 교사만 성 한 글자를 쓰고, 그 글자가 이미 임자가 있으면
 * 이름 전체를 쓴다.
 */
export function teacherPrefixes(
  teachers: TeacherLike[],
  classes: ClassLike[]
): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();

  // 1) 이미 쓰고 있는 표기를 그대로 물려받는다.
  for (const t of teachers) {
    const tally = new Map<string, number>();
    for (const c of classes) {
      if (c.teacherId !== t.id) continue;
      const tag = leadingTag(c.name);
      if (tag) tally.set(tag, (tally.get(tag) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    tally.forEach((n, tag) => {
      if (n > bestN) {
        best = tag;
        bestN = n;
      }
    });
    if (best) {
      out.set(t.id, best);
      taken.add(best);
    }
  }

  // 2) 남은 교사는 성 한 글자. 이미 임자가 있으면 이름 전체를 쓴다.
  const surnameCount = new Map<string, number>();
  for (const t of teachers) {
    if (out.has(t.id)) continue;
    const s = t.name.trim().charAt(0);
    if (s) surnameCount.set(s, (surnameCount.get(s) ?? 0) + 1);
  }
  for (const t of teachers) {
    if (out.has(t.id)) continue;
    const name = t.name.trim();
    const s = name.charAt(0);
    if (!s) continue;
    const clashes = taken.has(s) || (surnameCount.get(s) ?? 0) > 1;
    out.set(t.id, clashes ? name : s);
  }
  return out;
}

/**
 * 화면에 보여줄 반 이름. `화 목 A` → `[고]화 목 A`.
 *
 * 이름이 `[`로 시작하면 원장이 이미 정해 둔 표기라 손대지 않는다. `[국어-이]`처럼
 * 과목까지 담은 표기나 `[란]`처럼 성이 아닌 표기도 그 사람의 규칙이므로 존중한다.
 * `중1 심화반 [월수B]`는 대괄호가 뒤에 있는 일정 표기라 앞에 교사 표기가 붙는다.
 */
export function classLabel(className: string, prefix: string | undefined): string {
  const n = className.trim();
  if (n.startsWith("[")) return n;
  if (!prefix) return n;
  return `[${prefix}]${n}`;
}

/**
 * 시간표 칸처럼 자리가 좁을 때 쓸 짧은 이름. `[정]월 수 심화A` → `심화A`.
 *
 * 저녁 시간대는 한 요일에 대여섯 반이 겹쳐서 칸 하나가 40px도 안 된다. 거기에
 * 전체 이름을 넣으면 `[정]월…`만 보여 어느 반인지 알 수 없다. 교사는 칸 색으로,
 * 요일은 칸이 놓인 세로줄로 이미 드러나므로 둘 다 뗀다.
 *
 * 전체 이름은 칸에 마우스를 올리면 나온다. 여기서 떼는 건 화면 표시뿐이다.
 */
export function shortClassLabel(label: string): string {
  const withoutPrefix = label.trim().replace(/^\[[^\]]*\]\s*/, "");
  // 요일 뒤에 띄어쓰기가 있을 때만 뗀다. `토익반`의 '토'를 요일로 보고 떼면
  // `익반`이 되어 반 이름이 망가진다.
  const withoutDays = withoutPrefix.replace(/^(?:[월화수목금토일]\s+)+/, "").trim();
  // 요일 말고는 적힌 게 없는 이름(`월 수 금`)은 떼면 `금`만 남아 금요일 반처럼
  // 보인다. 남길 게 없으면 그냥 원래 이름을 쓴다.
  if (!withoutDays || !/[^월화수목금토일\s]/.test(withoutDays)) return withoutPrefix;
  return withoutDays;
}

/** 정렬용 키. 앞에 붙은 대괄호 표기를 떼고 남은 이름으로만 비교한다. */
function sortKey(className: string): string {
  return className.trim().replace(/^\[[^\]]*\]\s*/, "").replace(/\s/g, "");
}

export interface TeacherGroup<T> {
  /** 교사가 지워졌거나 배정되지 않은 반들의 묶음은 null이다. */
  teacher: TeacherLike | null;
  prefix: string | null;
  classes: Array<T & { label: string }>;
}

/**
 * 교사별로 묶어서 돌려준다. 반이 많은 교사가 위로 온다.
 *
 * 정우석 선생님 반이 제일 많아서 `[정]`이 맨 위에 온다. 사람 이름을 코드에
 * 박아 넣는 대신 개수로 정한 건, 학원 사정이 바뀌어도 "제일 자주 고르는 반이
 * 맨 위"라는 성질이 그대로 유지되기 때문이다.
 */
export function groupClassesByTeacher<T extends ClassLike>(
  classes: T[],
  teachers: TeacherLike[],
  options: OrderOptions = {}
): Array<TeacherGroup<T>> {
  const prefixes = teacherPrefixes(teachers, classes);
  const byId = new Map(teachers.map((t) => [t.id, t]));
  const { teacherOrder, scheduleOrder } = options;

  const groups: Array<TeacherGroup<T>> = [];
  const indexOf = new Map<string, number>();
  for (const c of classes) {
    const teacher = byId.get(c.teacherId) ?? null;
    const key = teacher?.id ?? "";
    let i = indexOf.get(key);
    if (i === undefined) {
      i = groups.length;
      indexOf.set(key, i);
      groups.push({
        teacher,
        prefix: teacher ? prefixes.get(teacher.id) ?? null : null,
        classes: [],
      });
    }
    const g = groups[i];
    g.classes.push({ ...c, label: classLabel(c.name, g.prefix ?? undefined) });
  }

  for (const g of groups) {
    g.classes.sort((a, b) => {
      if (scheduleOrder && scheduleOrder.length > 0) {
        const ra = scheduleRank(a.schedule, scheduleOrder);
        const rb = scheduleRank(b.schedule, scheduleOrder);
        if (ra !== rb) return ra - rb;
      }
      return sortKey(a.label).localeCompare(sortKey(b.label), "ko");
    });
  }

  const teacherRank = (name: string | undefined): number => {
    if (!teacherOrder || !name) return teacherOrder ? teacherOrder.length : 0;
    const idx = teacherOrder.indexOf(name);
    return idx === -1 ? teacherOrder.length : idx;
  };

  return groups.sort((a, b) => {
    // 담당 교사가 없는 반은 늘 맨 아래. 개수가 많아도 먼저 보여줄 이유가 없다.
    if (!a.teacher !== !b.teacher) return a.teacher ? -1 : 1;
    if (teacherOrder && teacherOrder.length > 0) {
      const ra = teacherRank(a.teacher?.name);
      const rb = teacherRank(b.teacher?.name);
      if (ra !== rb) return ra - rb;
    }
    if (a.classes.length !== b.classes.length) return b.classes.length - a.classes.length;
    return (a.teacher?.name ?? "").localeCompare(b.teacher?.name ?? "", "ko");
  });
}

/** 드롭다운용 평평한 목록. 같은 교사의 반이 붙어서 나온다. */
export function labelClassesByTeacher<T extends ClassLike>(
  classes: T[],
  teachers: TeacherLike[],
  options: OrderOptions = {}
): Array<T & { label: string }> {
  return groupClassesByTeacher(classes, teachers, options).flatMap((g) => g.classes);
}
