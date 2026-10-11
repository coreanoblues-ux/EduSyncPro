/**
 * 학원이 놓치는 자리를 하루 한 번 스스로 찾아낸다.
 *
 * ── 왜 필요한가 ──
 *   이 프로그램은 지금까지 "사람이 화면을 열면 그때 계산해서 보여 주는" 방식만
 *   가지고 있었다(미납 계산, 출결 집계 모두 그렇다). 그래서 **아무도 그 화면을
 *   열지 않으면 아무 일도 일어나지 않는다.** 레벨테스트를 보고 간 학생이
 *   3주 동안 아무 연락 없이 잊히는 사고가 바로 이 구조에서 나온다.
 *
 *   사람을 더 쓰지 않고 이 구멍을 메우는 방법은 두 가지뿐이다. (1) 원장이 매일
 *   빠짐없이 모든 화면을 훑는다 — 현실적이지 않다. (2) 시스템이 매일 한 번
 *   훑어보고 **할 일 목록에 한 줄 적어 둔다.** 이 파일은 (2)의 "무엇을 적을지"다.
 *
 * ── 이 파일이 지키는 선 ──
 *   · DB도 시각도 모른다. 받은 값만 보고 "적을 줄 목록"을 돌려주는 순수 함수다.
 *     그래서 테스트가 날짜를 마음대로 고정할 수 있다.
 *   · 아무것도 보내지 않는다. 문자·알림톡을 자동 발송하지 않는다. 자동 발송은
 *     한 번 잘못 나가면 되돌릴 수 없어서, 사람이 보고 누르는 자리를 남긴다.
 *   · **조용한 쪽으로 기운다.** 애매하면 적지 않는다. 할 일 목록이 쓸모없는
 *     줄로 가득 차면 원장이 목록 자체를 안 보게 되고, 그러면 이 기능은 있으나
 *     마나가 아니라 오히려 해롭다. 그래서 날짜 문턱(며칠 지나면 알릴지)과
 *     상한(한 번에 몇 줄까지)을 두고, 너무 오래된 건은 포기한다.
 */

import { daysBetween, addDays } from "./day";
import { isSamePerson } from "./levelTestMatch";

// ─── 받는 값 ────────────────────────────────────────────────────────────
//
// Drizzle 의 전체 행 타입을 받지 않고 필요한 칸만 적는다. 테스트에서 가짜 행을
// 만들 때 쓰지도 않는 칸 20개를 채우지 않아도 되고, 나중에 표에 칸이 늘어도
// 이 파일은 그대로 돈다.

export interface WatchConsultation {
  id: string;
  studentName: string | null;
  guardianName: string | null;
  studentGrade: string | null;
  phone: string | null;
  status: string;
  classId: string | null;
  recommendedClassId: string | null;
  studentId: string | null;
  /** 레벨테스트 예정/완료 일시. timestamp 칸이라 Date 로 온다. */
  levelTestDate: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface WatchLevelTest {
  id: string;
  studentName: string;
  grade: string | null;
  parentPhone: string | null;
  consultationId: string | null;
  /** "YYYY-MM-DD" (timestamp 가 아니다 — 서버가 UTC 라서 일부러 문자열이다) */
  testDate: string;
  examTitle: string;
  totalScore: number | null;
  pendingCount: number | null;
}

export interface WatchClass {
  id: string;
  name: string;
  maxStudents: number | null;
  isActive: boolean;
}

export interface WatchEnrollment {
  classId: string;
  studentId: string;
  isActive: boolean;
}

export interface WatchWaiter {
  id: string;
  classId: string;
  name: string;
  phone: string | null;
}

/** 할 일 한 줄. key 는 같은 줄을 두 번 적지 않게 하는 도장이다. */
export interface FunnelAlert {
  /**
   * 중복 방지 도장. tasks.sourceText 에 "auto:<key>" 로 들어간다.
   * 이미 같은 도장이 찍힌 할 일이 있으면(완료된 것까지 포함) 다시 적지 않는다.
   * 그래서 매일 돌아도 같은 줄이 쌓이지 않고, 원장이 지운 줄이 되살아나지 않는다.
   */
  key: string;
  title: string;
  notes: string;
  /** 급한 순서. 숫자가 작을수록 먼저 (상한에 걸릴 때 뭘 남길지 결정한다) */
  priority: number;
}

export interface WatchOptions {
  /** 채점을 안 끝낸 결과지를 며칠 지나면 알릴지 */
  pendingGradingDays?: number;
  /** 레벨테스트 결과가 나왔는데 반배정을 안 잡은 상태를 며칠 지나면 알릴지 */
  afterTestDays?: number;
  /** 상담문의만 들어온 채로 며칠 지나면 알릴지 */
  inquiryDays?: number;
  /** 테스트만 보고 간 학생(상담 기록 없음)을 며칠 지나면 알릴지 */
  orphanTestDays?: number;
  /** 이보다 오래된 건은 포기한다 (처음 켠 날 옛날 기록이 쏟아지는 것을 막는다) */
  giveUpDays?: number;
  /** 한 번에 적을 수 있는 최대 줄 수 */
  maxAlerts?: number;
}

const DEFAULTS: Required<WatchOptions> = {
  // 채점은 보통 그날 끝낸다. 하루가 지나도 미채점이면 잊은 것이다.
  pendingGradingDays: 1,
  // 결과가 나오고 이틀이 지나도 반 얘기가 없으면 식는다. 학부모는 이때 다른 학원을 본다.
  afterTestDays: 2,
  // 문의만 받고 사흘이 지나면 대개 연락이 끊긴 것이다.
  inquiryDays: 3,
  // 워크인 테스트는 하루만 지나도 상담 흐름에 태워야 한다.
  orphanTestDays: 1,
  // 45일이 지난 건은 되살리는 게 아니라 정리할 일이다. 할 일 목록에 적지 않는다.
  giveUpDays: 45,
  // 하루에 12줄 넘게 적으면 목록이 아니라 소음이 된다.
  maxAlerts: 12,
};

// ─── 보조 ───────────────────────────────────────────────────────────────

/** timestamp/문자열을 "YYYY-MM-DD" 로. 한국 날짜 기준으로 맞춘다. */
function ymd(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  if (typeof v === "string") {
    // 이미 "YYYY-MM-DD" 면 그대로. ISO 문자열이면 앞 10자가 UTC 날짜라 Date 로 돌린다.
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : shiftToKstYmd(d);
  }
  return isNaN(v.getTime()) ? null : shiftToKstYmd(v);
}

function shiftToKstYmd(d: Date): string {
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const m = String(k.getUTCMonth() + 1).padStart(2, "0");
  const day = String(k.getUTCDate()).padStart(2, "0");
  return `${k.getUTCFullYear()}-${m}-${day}`;
}

/** 사람 이름 한 줄. 학생 이름이 없으면 보호자 이름, 그것도 없으면 연락처. */
function who(c: WatchConsultation): string {
  return (
    (c.studentName ?? "").trim() ||
    (c.guardianName ?? "").trim() ||
    (c.phone ?? "").trim() ||
    "이름 미기재"
  );
}

/** 할 일 메모 끝에 붙이는 연락처. 원장이 목록에서 바로 전화할 수 있게 둔다. */
function contact(phone: string | null | undefined): string {
  const p = (phone ?? "").trim();
  return p ? ` · ${p}` : "";
}

/**
 * 이 상담 건에 붙은 결과지들.
 *
 * 판단 규칙은 화면이 쓰는 것과 **같은 함수**(shared/levelTestMatch.ts)를 쓴다.
 * 규칙을 따로 쓰면 화면에는 붙어 보이는데 할 일은 "결과지가 없다"고 적는,
 * 설명할 수 없는 상태가 생긴다.
 */
function testsFor(c: WatchConsultation, tests: WatchLevelTest[]): WatchLevelTest[] {
  return tests.filter((t) =>
    isSamePerson({ id: c.id, studentName: c.studentName, phone: c.phone }, t)
  );
}

/** 채점이 안 끝난 결과지인가. 총점이 없거나 미채점 문항이 남아 있으면 그렇다. */
function isUnfinished(t: WatchLevelTest): boolean {
  return t.totalScore == null || (t.pendingCount ?? 0) > 0;
}

// ─── 본체 ───────────────────────────────────────────────────────────────

/**
 * 오늘 적어야 할 할 일 목록을 만든다.
 *
 * 규칙 하나하나는 "원장이 이걸 놓치면 돈과 신뢰를 잃는가" 를 기준으로 골랐다.
 * 학원의 등록 흐름은 문의 → 테스트 → 채점 → 반배정 → 등록인데, 사람이 떨어지는
 * 자리는 늘 **단계 사이의 빈칸**이다. 그 빈칸마다 규칙을 하나씩 뒀다.
 */
export function findFunnelAlerts(input: {
  today: string;
  consultations: WatchConsultation[];
  levelTests: WatchLevelTest[];
  classes: WatchClass[];
  enrollments: WatchEnrollment[];
  waiters: WatchWaiter[];
  options?: WatchOptions;
}): FunnelAlert[] {
  const o = { ...DEFAULTS, ...(input.options ?? {}) };
  const { today, consultations, levelTests, classes, enrollments, waiters } = input;
  const alerts: FunnelAlert[] = [];
  const tomorrow = addDays(today, 1);

  /** 날짜가 오늘로부터 며칠 전인가. 미래면 음수. 포기 범위를 넘으면 null. */
  const ageOf = (v: Date | string | null): number | null => {
    const d = ymd(v);
    if (!d) return null;
    const age = daysBetween(d, today);
    if (age > o.giveUpDays) return null;
    return age;
  };

  // ── 규칙 1. 채점을 안 끝낸 결과지 ────────────────────────────────────
  //
  // 선생님이 채점 중간에 다른 일로 자리를 떴을 때 생긴다. 총점이 없으면 결과지를
  // 뽑을 수도, 반을 정할 수도 없다. 흐름이 여기서 완전히 멈추므로 가장 급하다.
  for (const t of levelTests) {
    if (!isUnfinished(t)) continue;
    const age = ageOf(t.testDate);
    if (age === null || age < o.pendingGradingDays) continue;
    alerts.push({
      key: `lt-pending:${t.id}`,
      title: `채점 마무리: ${t.studentName} 레벨테스트`,
      notes:
        `${t.testDate} ${t.examTitle} — ` +
        (t.totalScore == null
          ? "총점이 아직 없습니다"
          : `미채점 ${t.pendingCount}문항 남음`) +
        `. ${age}일 지났습니다.` +
        contact(t.parentPhone),
      priority: 10,
    });
  }

  // ── 규칙 2. 내일 레벨테스트인데 확인 연락을 안 했다 ─────────────────
  //
  // 노쇼를 막는 자리다. 하루 전 확인 전화 한 통이 빈 자리를 가장 많이 줄인다.
  // 날짜를 도장에 넣어, 일정이 바뀌면 새 줄이 생기게 한다.
  for (const c of consultations) {
    if (c.status !== "레벨테스트예정") continue;
    if (ymd(c.levelTestDate) !== tomorrow) continue;
    alerts.push({
      key: `lt-remind:${c.id}:${tomorrow}`,
      title: `내일 레벨테스트 확인 연락: ${who(c)}`,
      notes: `${tomorrow} 예정. 시간·준비물을 한 번 더 알려 주세요.` + contact(c.phone),
      priority: 5,
    });
  }

  // ── 규칙 3. 예정일이 지났는데 결과가 없다 ───────────────────────────
  //
  // 왔는데 기록을 안 남겼거나(결과지가 엑셀에만 있거나), 안 왔는데 상태를 안 바꾼
  // 경우다. 둘 다 사람이 봐야 풀린다.
  for (const c of consultations) {
    if (c.status !== "레벨테스트예정") continue;
    const age = ageOf(c.levelTestDate);
    if (age === null || age < 1) continue;
    if (testsFor(c, levelTests).length > 0) continue;
    alerts.push({
      key: `lt-overdue:${c.id}`,
      title: `레벨테스트 결과 확인: ${who(c)}`,
      notes:
        `예정일(${ymd(c.levelTestDate)})이 ${age}일 지났는데 결과지가 없습니다. ` +
        `봤으면 결과를 기록하고, 안 왔으면 상태를 바꿔 주세요.` +
        contact(c.phone),
      priority: 20,
    });
  }

  // ── 규칙 4. 결과는 나왔는데 반 얘기가 없다 ──────────────────────────
  //
  // 등록이 가장 많이 깨지는 자리다. 결과를 받아 든 학부모는 이때 다른 학원을
  // 같이 알아본다. 상태가 레벨테스트완료인데 반이 안 정해진 건을 집어낸다.
  for (const c of consultations) {
    if (c.status !== "레벨테스트완료") continue;
    if (c.classId || c.recommendedClassId || c.studentId) continue;
    // 결과지가 있으면 그 시험 날짜, 없으면 상담 건이 갱신된 날을 기준으로 센다.
    const linked = testsFor(c, levelTests).filter((t) => !isUnfinished(t));
    const base = linked.length
      ? linked.map((t) => t.testDate).sort().slice(-1)[0]
      : ymd(c.updatedAt);
    const age = ageOf(base);
    if (age === null || age < o.afterTestDays) continue;
    alerts.push({
      key: `lt-done-no-class:${c.id}`,
      title: `반배정 상담 잡기: ${who(c)}`,
      notes:
        `레벨테스트 결과가 나온 지 ${age}일인데 반이 정해지지 않았습니다.` +
        (linked.length ? ` (${linked[0].examTitle} ${linked[0].totalScore}점)` : "") +
        contact(c.phone),
      priority: 1,
    });
  }

  // ── 규칙 5. 문의만 받고 테스트로 넘어가지 못했다 ────────────────────
  for (const c of consultations) {
    if (c.status !== "상담문의") continue;
    if (testsFor(c, levelTests).length > 0) continue;
    const age = ageOf(c.createdAt);
    if (age === null || age < o.inquiryDays) continue;
    alerts.push({
      key: `inquiry-stale:${c.id}`,
      title: `레벨테스트 일정 잡기: ${who(c)}`,
      notes:
        `문의가 들어온 지 ${age}일인데 아직 테스트 일정이 없습니다.` +
        (c.studentGrade ? ` (${c.studentGrade})` : "") +
        contact(c.phone),
      priority: 30,
    });
  }

  // ── 규칙 6. 테스트만 보고 간 학생 (상담 기록이 없다) ────────────────
  //
  // 등록 가능성이 가장 높은 사람인데 상담 목록에는 한 줄도 없어서 가장 안 보였다.
  const claimed = new Set<string>();
  for (const c of consultations) {
    for (const t of testsFor(c, levelTests)) claimed.add(t.id);
  }
  for (const t of levelTests) {
    if (claimed.has(t.id)) continue;
    if (isUnfinished(t)) continue; // 채점이 안 끝난 건은 규칙 1이 이미 집었다
    const age = ageOf(t.testDate);
    if (age === null || age < o.orphanTestDays) continue;
    alerts.push({
      key: `lt-orphan:${t.id}`,
      title: `상담 기록 만들기: ${t.studentName} (테스트만 보고 간 학생)`,
      notes:
        `${t.testDate} ${t.examTitle} ${t.totalScore}점. 상담 기록이 없어 흐름에서 빠져 있습니다.` +
        contact(t.parentPhone),
      priority: 15,
    });
  }

  // ── 규칙 7. 대기 중인데 자리가 났다 ─────────────────────────────────
  //
  // 지금까지 대기자 표는 적어 두기만 하고 아무도 다시 보지 않았다. 자리가 나는
  // 순간을 사람이 알아차리기는 어렵다 — 퇴원 처리하는 사람과 대기자를 기억하는
  // 사람이 다르기 때문이다. 이건 시스템이 훨씬 잘한다.
  const seatsLeft = (cls: WatchClass): number | null => {
    if (!cls.isActive) return null;
    if (cls.maxStudents == null) return null; // 정원을 안 정한 반은 판단하지 않는다
    const taken = enrollments.filter((e) => e.classId === cls.id && e.isActive).length;
    return cls.maxStudents - taken;
  };
  const classById = new Map(classes.map((c) => [c.id, c] as const));

  for (const w of waiters) {
    const cls = classById.get(w.classId);
    if (!cls) continue;
    const left = seatsLeft(cls);
    if (left === null || left <= 0) continue;
    alerts.push({
      key: `seat-open:${w.id}:${cls.id}`,
      title: `자리 났습니다 — ${w.name} 에게 연락 (${cls.name})`,
      notes:
        `${cls.name} 정원 ${cls.maxStudents}명 중 ${left}자리 비었습니다. ` +
        `대기 등록해 둔 학생입니다.` +
        contact(w.phone),
      priority: 2,
    });
  }

  // 상담 상태가 "대기등록"이고 반이 지정돼 있으면 대기자 표와 같게 취급한다.
  // (대기자 표에 따로 안 적어 두는 경우가 많다 — 둘 다 보지 않으면 놓친다)
  for (const c of consultations) {
    if (c.status !== "대기등록") continue;
    const cls = classById.get(c.classId ?? c.recommendedClassId ?? "");
    if (!cls) continue;
    const left = seatsLeft(cls);
    if (left === null || left <= 0) continue;
    if (ageOf(c.updatedAt) === null) continue; // 너무 오래된 건은 포기
    alerts.push({
      key: `seat-open-consult:${c.id}:${cls.id}`,
      title: `자리 났습니다 — ${who(c)} 에게 연락 (${cls.name})`,
      notes:
        `${cls.name} 정원 ${cls.maxStudents}명 중 ${left}자리 비었습니다. ` +
        `대기등록 상태인 상담 건입니다.` +
        contact(c.phone),
      priority: 2,
    });
  }

  // 급한 것부터. 같은 급함 안에서는 도장 순서로 — 매일 돌 때 순서가 흔들리면
  // 상한에 걸리는 줄이 날마다 바뀌어 "어제 있던 할 일이 사라졌다"가 된다.
  alerts.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
  return alerts.slice(0, o.maxAlerts);
}
