/**
 * 놓친 자리를 찾아 "퇴근 전 할 일" 에 적어 두는 일꾼.
 *
 * 무엇을 적을지는 shared/funnelWatch.ts(순수 규칙)가 정한다. 이 파일은
 * 언제 돌릴지, DB 에서 무엇을 읽을지, 어떻게 적을지만 다룬다.
 * (학년 자동 진급 server/lib/gradePromotion.ts 과 같은 구조다 — 이 프로그램에서
 *  사람 없이 도는 일이 그 하나뿐이었고, 그 방식이 1년 넘게 문제없이 돌았다.)
 *
 * ── 설계에서 중요한 것 네 가지 ──
 *
 * 1. **같은 줄을 두 번 적지 않는다.** tasks.source_text 에 "auto:<도장>" 을
 *    남기고, 이미 그 도장이 있으면(완료·미완료 가리지 않고) 건너뛴다.
 *    Railway 는 배포마다 서버를 다시 켜므로 이 장치가 없으면 하루에 같은 할 일이
 *    여러 줄 생긴다. shared/funnelWatchKeys.ts 주석 참조.
 *
 * 2. **아무것도 보내지 않는다.** 문자·알림톡을 자동 발송하지 않는다. 적어 두는
 *    것까지만 한다. 자동 발송은 한 번 잘못 나가면 되돌릴 수 없다.
 *
 * 3. **실패해도 서비스를 멈추지 않는다.** 한 학원에서 오류가 나도 다음 학원으로
 *    넘어간다. 할 일을 못 적는 것보다 서버가 죽는 것이 훨씬 나쁘다.
 *
 * 4. **결제·수납 쪽을 건드리지 않는다.** 읽기만 한다. 쓰는 것은 tasks 표 한
 *    곳뿐이고, 그것도 새 줄을 넣는 것뿐이다(수정·삭제 없음).
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import {
  classes,
  consultations,
  enrollments,
  levelTests,
  tasks,
  tenants,
  users,
  waiters,
} from "@shared/schema";
import { todayKst } from "@shared/day";
import { findFunnelAlerts, type FunnelAlert } from "@shared/funnelWatch";
import { autoSourceText, pickNewAlerts } from "@shared/funnelWatchKeys";

export interface WatchRunResult {
  tenantId: string;
  tenantName: string;
  /** 규칙이 찾아낸 줄 (이미 적어 둔 것 포함) */
  found: number;
  /** 이번에 새로 적은 줄 */
  written: FunnelAlert[];
  /** 적지 못한 이유 (원장이 없는 학원 등). 비어 있으면 정상. */
  skippedReason?: string;
}

/**
 * 한 학원의 오늘 할 일을 계산한다. DB 는 읽기만 한다.
 *
 * 따로 뺀 이유: 미리보기 스크립트가 "실제로 무엇이 적힐지" 를 쓰기 전에 볼 수
 * 있어야 한다. 사람 없이 도는 기능은 켜기 전에 눈으로 확인할 길이 있어야 한다.
 */
export async function planFunnelAlerts(
  tenantId: string,
  today = todayKst()
): Promise<{ alerts: FunnelAlert[]; fresh: FunnelAlert[] }> {
  const [cons, tests, cls, enr, wai, existing] = await Promise.all([
    db
      .select({
        id: consultations.id,
        studentName: consultations.studentName,
        guardianName: consultations.guardianName,
        studentGrade: consultations.studentGrade,
        phone: consultations.phone,
        status: consultations.status,
        classId: consultations.classId,
        recommendedClassId: consultations.recommendedClassId,
        studentId: consultations.studentId,
        levelTestDate: consultations.levelTestDate,
        createdAt: consultations.createdAt,
        updatedAt: consultations.updatedAt,
      })
      .from(consultations)
      .where(eq(consultations.tenantId, tenantId)),
    // 결과지 원본(raw_state)은 읽지 않는다 — 한 건에 수십 KB 라 전부 읽으면 무겁다.
    db
      .select({
        id: levelTests.id,
        studentName: levelTests.studentName,
        grade: levelTests.grade,
        parentPhone: levelTests.parentPhone,
        consultationId: levelTests.consultationId,
        testDate: levelTests.testDate,
        examTitle: levelTests.examTitle,
        totalScore: levelTests.totalScore,
        pendingCount: levelTests.pendingCount,
      })
      .from(levelTests)
      .where(eq(levelTests.tenantId, tenantId)),
    db
      .select({
        id: classes.id,
        name: classes.name,
        maxStudents: classes.maxStudents,
        isActive: classes.isActive,
      })
      .from(classes)
      .where(eq(classes.tenantId, tenantId)),
    db
      .select({
        classId: enrollments.classId,
        studentId: enrollments.studentId,
        isActive: enrollments.isActive,
      })
      .from(enrollments)
      .where(eq(enrollments.tenantId, tenantId)),
    db
      .select({
        id: waiters.id,
        classId: waiters.classId,
        name: waiters.name,
        phone: waiters.phone,
      })
      .from(waiters)
      .where(eq(waiters.tenantId, tenantId)),
    db
      .select({ sourceText: tasks.sourceText })
      .from(tasks)
      .where(eq(tasks.tenantId, tenantId)),
  ]);

  const alerts = findFunnelAlerts({
    today,
    consultations: cons,
    levelTests: tests,
    classes: cls,
    enrollments: enr,
    waiters: wai,
  });

  const fresh = pickNewAlerts(
    alerts,
    existing.map((t) => t.sourceText)
  );
  return { alerts, fresh };
}

/**
 * 모든 학원을 돌면서 할 일을 적는다.
 *
 * `today` 는 테스트와 미리보기가 날짜를 고정할 수 있도록 주입받는다.
 */
export async function runFunnelWatch(today = todayKst()): Promise<WatchRunResult[]> {
  const shops = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants);

  const results: WatchRunResult[] = [];

  for (const shop of shops) {
    try {
      const { alerts, fresh } = await planFunnelAlerts(shop.id, today);
      if (!fresh.length) {
        results.push({ tenantId: shop.id, tenantName: shop.name, found: alerts.length, written: [] });
        continue;
      }

      /**
       * 할 일에는 "누가 만들었는지"가 반드시 들어가야 한다(NOT NULL). 자동으로
       * 만든 줄은 그 학원의 원장 계정으로 돌린다. 시스템 계정을 새로 만드는
       * 쪽이 깔끔해 보이지만, 그러면 users 표에 로그인할 수 없는 행이 생기고
       * 권한 검사·목록 화면마다 예외가 하나씩 늘어난다.
       */
      const [owner] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.tenantId, shop.id), eq(users.role, "owner"), eq(users.isActive, true)))
        .limit(1);

      if (!owner) {
        // 원장 계정이 없는 학원은 적을 수 없다. 조용히 넘기지 않고 남겨 둔다.
        results.push({
          tenantId: shop.id,
          tenantName: shop.name,
          found: alerts.length,
          written: [],
          skippedReason: "원장 계정이 없어 할 일을 적지 못했습니다",
        });
        continue;
      }

      await db.insert(tasks).values(
        fresh.map((a) => ({
          tenantId: shop.id,
          title: a.title,
          notes: a.notes,
          // 오늘 퇴근 전에 보는 목록에 넣는다. 전화해야 할 일이 대부분이라
          // 학원이 열려 있는 시간에 보이는 게 맞다.
          dueDate: today,
          slot: "퇴근전" as const,
          sourceText: autoSourceText(a.key),
          createdBy: owner.id,
        }))
      );

      console.log(
        `[놓친자리] ${shop.name}: ${alerts.length}건 중 ${fresh.length}건을 할 일에 적었습니다`
      );
      for (const a of fresh) console.log(`  · ${a.title}`);

      results.push({
        tenantId: shop.id,
        tenantName: shop.name,
        found: alerts.length,
        written: fresh,
      });
    } catch (err) {
      // 한 학원의 실패가 다른 학원을 막지 않게 한다.
      console.error(`❌ [놓친자리] ${shop.name} 처리 실패:`, err);
      results.push({
        tenantId: shop.id,
        tenantName: shop.name,
        found: 0,
        written: [],
        skippedReason: (err as Error).message,
      });
    }
  }

  return results;
}

/**
 * 부팅 직후 한 번, 그 뒤로 6시간마다 확인한다.
 *
 * 왜 "매일 자정 정각" 이 아닌가: Railway 는 배포·재시작이 잦아서 정각 한 번에
 * 걸어 두면 그 시각에 서버가 내려가 있으면 그날은 통째로 건너뛴다. 주기적으로
 * 보고 도장으로 중복을 막는 방식이, 돌다 말아도 스스로 따라잡는다.
 * (학년 자동 진급이 쓰는 방식과 같다.)
 */
export function startFunnelWatchScheduler() {
  const tick = () => {
    runFunnelWatch().catch((err) => {
      console.error("❌ 놓친 자리 찾기 실패:", err);
    });
  };
  tick();
  setInterval(tick, 6 * 60 * 60 * 1000);
}
