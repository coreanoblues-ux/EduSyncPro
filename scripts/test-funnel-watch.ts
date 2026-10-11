/**
 * 놓친 자리를 스스로 찾아내는 규칙 검증. `npm run test:funnel`
 *
 * ── 이 테스트가 지키려는 것 ──
 *   이 기능은 매일 혼자 돌면서 할 일 목록에 줄을 적는다. 사람이 지켜보지 않는
 *   자동 동작이라, 틀리는 방향이 두 가지로 갈린다.
 *
 *     ① 적어야 할 것을 안 적는다 → 학생을 놓친다 (원래 있던 문제가 그대로)
 *     ② 적지 않아도 될 것을 적는다 → 목록이 소음이 되고, 원장이 목록을 안 본다
 *
 *   ②가 더 위험하다. 할 일 목록을 신뢰하지 않게 되면 ①까지 같이 돌아온다.
 *   그래서 "울려야 할 때 울리는가" 와 "조용해야 할 때 조용한가" 를 같은 비중으로
 *   확인한다. 특히 **같은 줄을 두 번 적지 않는지**(도장) 와 **처음 켠 날 옛
 *   기록이 쏟아지지 않는지**(포기 기한) 를 본다.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findFunnelAlerts,
  type WatchConsultation,
  type WatchLevelTest,
  type WatchClass,
  type WatchEnrollment,
  type WatchWaiter,
} from "../shared/funnelWatch";
import { addDays } from "../shared/day";
import { autoSourceText, parseAutoKey, pickNewAlerts } from "../shared/funnelWatchKeys";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${(err as Error).message}\n`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const TODAY = "2026-10-11";
const ago = (n: number) => addDays(TODAY, -n);
const later = (n: number) => addDays(TODAY, n);

// ─── 가짜 행 만들기 ─────────────────────────────────────────────────────

function con(over: Partial<WatchConsultation> = {}): WatchConsultation {
  return {
    id: "c1",
    studentName: "김민준",
    guardianName: null,
    studentGrade: "중2",
    phone: "010-1111-2222",
    status: "상담문의",
    classId: null,
    recommendedClassId: null,
    studentId: null,
    levelTestDate: null,
    createdAt: new Date(`${TODAY}T03:00:00Z`),
    updatedAt: new Date(`${TODAY}T03:00:00Z`),
    ...over,
  };
}

function lt(over: Partial<WatchLevelTest> = {}): WatchLevelTest {
  return {
    id: "t1",
    studentName: "김민준",
    grade: "중2",
    parentPhone: "010-1111-2222",
    consultationId: null,
    testDate: TODAY,
    examTitle: "중등종합",
    totalScore: 72,
    pendingCount: 0,
    ...over,
  };
}

function cls(over: Partial<WatchClass> = {}): WatchClass {
  return { id: "k1", name: "[정]월수 기본 A", maxStudents: 10, isActive: true, ...over };
}

function enr(classId: string, studentId: string, isActive = true): WatchEnrollment {
  return { classId, studentId, isActive };
}

function wait(over: Partial<WatchWaiter> = {}): WatchWaiter {
  return { id: "w1", classId: "k1", name: "박서연", phone: "010-3333-4444", ...over };
}

/** 기본값은 모두 빈 목록. 각 테스트는 보려는 것만 넣는다. */
function run(input: {
  consultations?: WatchConsultation[];
  levelTests?: WatchLevelTest[];
  classes?: WatchClass[];
  enrollments?: WatchEnrollment[];
  waiters?: WatchWaiter[];
  today?: string;
  options?: Parameters<typeof findFunnelAlerts>[0]["options"];
}) {
  return findFunnelAlerts({
    today: input.today ?? TODAY,
    consultations: input.consultations ?? [],
    levelTests: input.levelTests ?? [],
    classes: input.classes ?? [],
    enrollments: input.enrollments ?? [],
    waiters: input.waiters ?? [],
    options: input.options,
  });
}

const keys = (alerts: { key: string }[]) => alerts.map((a) => a.key);
const kinds = (alerts: { key: string }[]) => alerts.map((a) => a.key.split(":")[0]);

function main() {
  console.log("─── 놓친 자리 찾기 (규칙) ───");

  // ── 아무 일도 없을 때는 조용하다 ──────────────────────────────────
  test("할 일이 없으면 아무것도 적지 않는다", () => {
    assert.deepEqual(run({}), []);
  });

  test("오늘 채점을 끝낸 결과지는 알리지 않는다", () => {
    const alerts = run({ levelTests: [lt()], consultations: [con({ status: "레벨테스트완료" })] });
    assert.deepEqual(keys(alerts), [], JSON.stringify(alerts, null, 1));
  });

  // ── 규칙 1: 채점 미완 ──────────────────────────────────────────────
  test("총점이 없는 어제 결과지는 채점 마무리를 알린다", () => {
    const alerts = run({ levelTests: [lt({ testDate: ago(1), totalScore: null })] });
    assert.deepEqual(kinds(alerts), ["lt-pending"]);
    assert.ok(alerts[0].title.includes("김민준"), alerts[0].title);
    assert.ok(alerts[0].notes.includes("010-1111-2222"), "연락처가 메모에 있어야 바로 전화할 수 있다");
  });

  test("미채점 문항이 남은 결과지도 알린다", () => {
    const alerts = run({ levelTests: [lt({ testDate: ago(2), pendingCount: 3 })] });
    assert.deepEqual(kinds(alerts), ["lt-pending"]);
    assert.ok(alerts[0].notes.includes("미채점 3문항"), alerts[0].notes);
  });

  test("오늘 본 시험은 아직 채점 중일 수 있으니 알리지 않는다", () => {
    const alerts = run({ levelTests: [lt({ testDate: TODAY, totalScore: null })] });
    assert.deepEqual(keys(alerts), []);
  });

  // ── 규칙 2: 내일 테스트 확인 연락 ─────────────────────────────────
  test("내일 레벨테스트가 잡혀 있으면 오늘 확인 연락을 알린다", () => {
    const alerts = run({
      consultations: [
        con({ status: "레벨테스트예정", levelTestDate: new Date(`${later(1)}T07:00:00Z`) }),
      ],
    });
    assert.deepEqual(kinds(alerts), ["lt-remind"]);
    assert.ok(alerts[0].key.endsWith(later(1)), "도장에 날짜가 들어가야 일정 변경을 따라간다");
  });

  test("모레 테스트는 아직 알리지 않는다 (하루 전에만)", () => {
    const alerts = run({
      consultations: [
        con({ status: "레벨테스트예정", levelTestDate: new Date(`${later(2)}T07:00:00Z`) }),
      ],
    });
    assert.deepEqual(keys(alerts), []);
  });

  // ── 규칙 3: 예정일이 지났는데 결과가 없다 ────────────────────────
  test("예정일이 지났는데 결과지가 없으면 알린다", () => {
    const alerts = run({
      consultations: [
        con({ status: "레벨테스트예정", levelTestDate: new Date(`${ago(2)}T07:00:00Z`) }),
      ],
    });
    assert.deepEqual(kinds(alerts), ["lt-overdue"]);
  });

  test("예정일이 지났지만 결과지가 있으면 알리지 않는다", () => {
    const alerts = run({
      consultations: [
        con({ status: "레벨테스트예정", levelTestDate: new Date(`${ago(2)}T07:00:00Z`) }),
      ],
      levelTests: [lt({ testDate: ago(2) })],
    });
    assert.deepEqual(keys(alerts), []);
  });

  // ── 규칙 4: 결과는 나왔는데 반 얘기가 없다 (가장 급한 자리) ──────
  test("결과가 나온 지 이틀이면 반배정 상담을 알린다", () => {
    const alerts = run({
      consultations: [con({ status: "레벨테스트완료", updatedAt: new Date(`${ago(2)}T07:00:00Z`) })],
      levelTests: [lt({ testDate: ago(2) })],
    });
    assert.deepEqual(kinds(alerts), ["lt-done-no-class"]);
    assert.equal(alerts[0].priority, 1, "등록이 가장 많이 깨지는 자리라 1순위여야 한다");
    assert.ok(alerts[0].notes.includes("72점"), alerts[0].notes);
  });

  test("추천반이 이미 정해져 있으면 알리지 않는다", () => {
    const alerts = run({
      consultations: [
        con({
          status: "레벨테스트완료",
          recommendedClassId: "k1",
          updatedAt: new Date(`${ago(5)}T07:00:00Z`),
        }),
      ],
      levelTests: [lt({ testDate: ago(5) })],
    });
    assert.deepEqual(keys(alerts), []);
  });

  test("이미 학생으로 등록된 건은 알리지 않는다", () => {
    const alerts = run({
      consultations: [
        con({ status: "레벨테스트완료", studentId: "s1", updatedAt: new Date(`${ago(9)}T07:00:00Z`) }),
      ],
      levelTests: [lt({ testDate: ago(9) })],
    });
    assert.deepEqual(keys(alerts), []);
  });

  test("결과가 나온 당일에는 재촉하지 않는다", () => {
    const alerts = run({
      consultations: [con({ status: "레벨테스트완료", updatedAt: new Date(`${TODAY}T07:00:00Z`) })],
      levelTests: [lt({ testDate: TODAY })],
    });
    assert.deepEqual(keys(alerts), []);
  });

  // ── 규칙 5: 문의만 받고 멈췄다 ────────────────────────────────────
  test("문의만 받은 채 사흘이 지나면 테스트 일정을 알린다", () => {
    const alerts = run({
      consultations: [con({ createdAt: new Date(`${ago(3)}T07:00:00Z`) })],
    });
    assert.deepEqual(kinds(alerts), ["inquiry-stale"]);
    assert.ok(alerts[0].notes.includes("중2"), "학년이 있으면 메모에 넣는다");
  });

  test("문의 이틀째는 아직 알리지 않는다", () => {
    const alerts = run({ consultations: [con({ createdAt: new Date(`${ago(2)}T07:00:00Z`) })] });
    assert.deepEqual(keys(alerts), []);
  });

  test("문의 건이라도 테스트를 이미 봤으면 알리지 않는다", () => {
    const alerts = run({
      consultations: [con({ createdAt: new Date(`${ago(8)}T07:00:00Z`) })],
      levelTests: [lt({ testDate: ago(1) })],
    });
    assert.deepEqual(keys(alerts), []);
  });

  // ── 규칙 6: 테스트만 보고 간 학생 ────────────────────────────────
  test("상담 기록이 없는 결과지는 상담 기록 만들기를 알린다", () => {
    const alerts = run({ levelTests: [lt({ testDate: ago(1) })] });
    assert.deepEqual(kinds(alerts), ["lt-orphan"]);
  });

  test("이름·연락처가 같은 상담 건이 있으면 워크인으로 보지 않는다", () => {
    const alerts = run({
      consultations: [con({ status: "반배정상담" })],
      levelTests: [lt({ testDate: ago(3) })],
    });
    assert.deepEqual(keys(alerts), []);
  });

  test("동명이인이라 연락처가 다르면 워크인으로 남는다", () => {
    const alerts = run({
      consultations: [con({ status: "반배정상담", phone: "010-9999-0000" })],
      levelTests: [lt({ testDate: ago(3), parentPhone: "010-1111-2222" })],
    });
    assert.deepEqual(kinds(alerts), ["lt-orphan"], "남의 상담 건에 붙여 조용해지면 더 위험하다");
  });

  // ── 규칙 7: 자리가 났다 ──────────────────────────────────────────
  test("대기자가 있는 반에 자리가 나면 알린다", () => {
    const alerts = run({
      classes: [cls({ maxStudents: 2 })],
      enrollments: [enr("k1", "s1")],
      waiters: [wait()],
    });
    assert.deepEqual(kinds(alerts), ["seat-open"]);
    assert.ok(alerts[0].notes.includes("1자리"), alerts[0].notes);
  });

  test("정원이 꽉 찬 반은 알리지 않는다", () => {
    const alerts = run({
      classes: [cls({ maxStudents: 2 })],
      enrollments: [enr("k1", "s1"), enr("k1", "s2")],
      waiters: [wait()],
    });
    assert.deepEqual(keys(alerts), []);
  });

  test("퇴원생(비활성 수강)은 자리를 차지하지 않는다", () => {
    const alerts = run({
      classes: [cls({ maxStudents: 2 })],
      enrollments: [enr("k1", "s1"), enr("k1", "s2", false)],
      waiters: [wait()],
    });
    assert.deepEqual(kinds(alerts), ["seat-open"], "퇴원 처리한 자리를 못 보면 대기자가 계속 기다린다");
  });

  test("정원을 정하지 않은 반은 판단하지 않는다", () => {
    const alerts = run({
      classes: [cls({ maxStudents: null })],
      enrollments: [],
      waiters: [wait()],
    });
    assert.deepEqual(keys(alerts), [], "모르는 것을 안다고 말하지 않는다");
  });

  test("닫힌 반은 자리가 비어도 알리지 않는다", () => {
    const alerts = run({
      classes: [cls({ isActive: false })],
      waiters: [wait()],
    });
    assert.deepEqual(keys(alerts), []);
  });

  test("대기자 표에 없어도 상담 상태가 대기등록이면 알린다", () => {
    const alerts = run({
      consultations: [con({ status: "대기등록", classId: "k1" })],
      classes: [cls({ maxStudents: 3 })],
      enrollments: [enr("k1", "s1")],
    });
    assert.deepEqual(kinds(alerts), ["seat-open-consult"]);
  });

  test("다른 반 수강생은 이 반 정원과 무관하다", () => {
    const alerts = run({
      classes: [cls({ id: "k1", maxStudents: 1 }), cls({ id: "k2", name: "다른반" })],
      enrollments: [enr("k2", "s1"), enr("k2", "s2")],
      waiters: [wait({ classId: "k1" })],
    });
    assert.deepEqual(kinds(alerts), ["seat-open"]);
  });

  // ── 소음 막기: 포기 기한과 상한 ──────────────────────────────────
  test("45일이 지난 건은 포기한다 (처음 켠 날 옛 기록이 쏟아지지 않게)", () => {
    const alerts = run({
      consultations: [
        con({ id: "old", createdAt: new Date(`${ago(60)}T07:00:00Z`) }),
        con({ id: "oldDone", status: "레벨테스트완료", updatedAt: new Date(`${ago(90)}T07:00:00Z`) }),
      ],
      levelTests: [lt({ id: "oldT", testDate: ago(80), totalScore: null })],
    });
    assert.deepEqual(keys(alerts), [], JSON.stringify(alerts.map((a) => a.title)));
  });

  test("한 번에 적는 줄 수에 상한이 있다", () => {
    const many: WatchConsultation[] = [];
    for (let i = 0; i < 40; i++) {
      many.push(
        con({
          id: `c${i}`,
          studentName: `학생${i}`,
          phone: `010-0000-${String(1000 + i)}`,
          createdAt: new Date(`${ago(10)}T07:00:00Z`),
        })
      );
    }
    const alerts = run({ consultations: many });
    assert.equal(alerts.length, 12, "소음을 막는 상한이 없다");
  });

  test("급한 것이 상한에 남는다", () => {
    const many: WatchConsultation[] = [];
    for (let i = 0; i < 20; i++) {
      many.push(
        con({
          id: `c${i}`,
          studentName: `학생${i}`,
          phone: `010-0000-${String(1000 + i)}`,
          createdAt: new Date(`${ago(10)}T07:00:00Z`),
        })
      );
    }
    // 가장 급한 건(반배정 상담) 하나를 섞어 둔다.
    many.push(
      con({
        id: "urgent",
        studentName: "급한학생",
        phone: "010-7777-7777",
        status: "레벨테스트완료",
        updatedAt: new Date(`${ago(3)}T07:00:00Z`),
      })
    );
    const alerts = run({ consultations: many, options: { maxAlerts: 3 } });
    assert.equal(alerts.length, 3);
    assert.ok(
      alerts[0].key.startsWith("lt-done-no-class"),
      "상한에 걸릴 때 가장 급한 줄이 잘려 나가면 안 된다: " + alerts[0].key
    );
  });

  test("같은 입력이면 순서까지 같다 (매일 같은 줄이 같은 자리에)", () => {
    const input = {
      consultations: [
        con({ id: "a", studentName: "가", phone: "010-1-0001", createdAt: new Date(`${ago(5)}T07:00:00Z`) }),
        con({ id: "b", studentName: "나", phone: "010-1-0002", createdAt: new Date(`${ago(5)}T07:00:00Z`) }),
      ],
    };
    assert.deepEqual(keys(run(input)), keys(run(input)));
  });

  // ── 도장(중복 방지) ─────────────────────────────────────────────
  console.log("\n─── 같은 줄을 두 번 적지 않는다 (도장) ───");

  test("도장은 auto: 로 시작한다", () => {
    assert.equal(autoSourceText("lt-pending:abc"), "auto:lt-pending:abc");
    assert.equal(parseAutoKey("auto:lt-pending:abc"), "lt-pending:abc");
    assert.equal(parseAutoKey("010-1234-5678 김민준 중2 영어 문의"), null, "사람이 적은 건 도장이 아니다");
    assert.equal(parseAutoKey(null), null);
  });

  test("이미 적은 줄은 다시 적지 않는다", () => {
    const alerts = [
      { key: "lt-pending:t1", title: "a", notes: "", priority: 1 },
      { key: "lt-orphan:t2", title: "b", notes: "", priority: 2 },
    ];
    const fresh = pickNewAlerts(alerts, ["auto:lt-pending:t1"]);
    assert.deepEqual(keys(fresh), ["lt-orphan:t2"]);
  });

  test("원장이 완료한 줄도 다시 적지 않는다", () => {
    // 완료·미완료를 구분하지 않는다. 완료한 일을 내일 또 적으면 가장 짜증나는
    // 종류의 소음이 되고, 원장이 자동 할 일 자체를 불신하게 된다.
    const alerts = [{ key: "lt-orphan:t2", title: "b", notes: "", priority: 2 }];
    assert.deepEqual(pickNewAlerts(alerts, ["auto:lt-orphan:t2"]), []);
  });

  test("사람이 손으로 적은 할 일은 도장 비교에 끼어들지 않는다", () => {
    const alerts = [{ key: "lt-orphan:t2", title: "b", notes: "", priority: 2 }];
    const fresh = pickNewAlerts(alerts, [null, "내일 학부모 상담 전화", "auto:다른키"]);
    assert.deepEqual(keys(fresh), ["lt-orphan:t2"]);
  });

  // ── 일꾼이 선을 넘지 않는지 (코드 검사) ─────────────────────────
  //
  // 사람이 지켜보지 않는 자동 동작이라, "무엇을 하지 않는가" 가 무엇을 하는가보다
  // 중요하다. 아래는 나중에 누가 이 파일을 고칠 때 선을 넘으면 테스트가 먼저
  // 깨지게 두는 장치다.
  console.log("\n─── 자동 일꾼이 선을 넘지 않는다 ───");

  const jobSource = readFileSync(
    path.resolve(here, "..", "server", "lib", "funnelWatch.ts"),
    "utf8"
  );

  test("할 일 표에 넣기만 하고 고치거나 지우지 않는다", () => {
    assert.ok(/db\.insert\(tasks\)/.test(jobSource), "할 일을 적지 않는다");
    assert.ok(!/db\.update\(/.test(jobSource), "자동 일꾼이 기존 자료를 고치면 안 된다");
    assert.ok(!/db\.delete\(/.test(jobSource), "자동 일꾼이 자료를 지우면 안 된다");
  });

  test("결제·수납 표를 건드리지 않는다", () => {
    for (const table of ["payments", "paymentIntents", "tossPaymentTransactions", "students"]) {
      assert.ok(
        !new RegExp(`(insert|update|delete)\\(${table}\\)`).test(jobSource),
        `${table} 를 건드린다`
      );
    }
  });

  test("문자·알림톡을 자동 발송하지 않는다", () => {
    for (const word of ["solapi", "aligo", "twilio", "sendMessage", "nodemailer", "sms"]) {
      assert.ok(
        !new RegExp(word, "i").test(jobSource),
        `발송 코드가 들어왔다: ${word} — 자동 발송은 되돌릴 수 없어 사람이 눌러야 한다`
      );
    }
  });

  test("도장을 찍어 중복을 막는다", () => {
    assert.ok(/autoSourceText\(/.test(jobSource) && /pickNewAlerts\(/.test(jobSource));
  });

  test("무거운 결과지 원본(raw_state)을 읽지 않는다", () => {
    assert.ok(!/rawState/.test(jobSource), "한 건에 수십 KB 라 전부 읽으면 서버가 무거워진다");
  });

  test("서버가 뜰 때 일꾼을 걸어 둔다", () => {
    const index = readFileSync(path.resolve(here, "..", "server", "index.ts"), "utf8");
    assert.ok(/startFunnelWatchScheduler\(\)/.test(index), "걸어 두지 않으면 아무 일도 안 일어난다");
  });

  console.log(`\n통과 ${passed} · 실패 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
