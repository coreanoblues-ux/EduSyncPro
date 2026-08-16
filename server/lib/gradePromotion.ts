/**
 * 3월이 되면 학생 학년을 한 칸씩 올린다.
 *
 * 순수 규칙은 shared/gradePromotion.ts에 있고, 여기서는 언제 돌릴지와 DB를 어떻게
 * 고칠지만 다룬다.
 *
 * 설계에서 중요한 것 두 가지:
 *
 * 1. **두 번 올리지 않는다.** tenants.lastGradePromotionYear에 "어느 학년도까지
 *    반영했는지"를 적어 둔다. Railway는 배포할 때마다 서버를 재시작하므로,
 *    이 표시가 없으면 3월에 배포 한 번 할 때마다 학년이 계속 올라간다.
 *
 * 2. **켠 날에는 아무도 올리지 않는다.** 표시가 NULL인 학원은 현재 학년도를 적어
 *    두기만 하고 끝낸다. 이 기능을 8월에 배포한다고 해서 전교생이 한 학년씩
 *    올라가면 안 된다.
 */

import { and, eq, isNull, or, lt } from "drizzle-orm";
import { db } from "../db";
import { students, tenants } from "@shared/schema";
import { todayKst } from "@shared/day";
import {
  changesSchoolLevel,
  parseGrade,
  promoteGrade,
  schoolYearOf,
} from "@shared/gradePromotion";

export interface PromotionChange {
  id: string;
  name: string;
  from: string;
  to: string;
  /** 학교급이 바뀌어 학교 정보가 낡게 된 학생. 원장이 새 학교를 채워야 한다. */
  needsNewSchool: boolean;
}

export interface PromotionSkip {
  id: string;
  name: string;
  grade: string;
  reason: string;
}

export interface PromotionResult {
  tenantId: string;
  tenantName: string;
  fromYear: number | null;
  toYear: number;
  steps: number;
  changes: PromotionChange[];
  skipped: PromotionSkip[];
}

/**
 * 한 학원의 재원 학생을 steps해 만큼 진급시킨 결과를 계산한다. DB는 건드리지 않는다.
 * 미리보기 스크립트와 실제 실행이 같은 코드를 쓰도록 분리했다.
 */
export async function planPromotion(
  tenantId: string,
  steps: number
): Promise<{ changes: PromotionChange[]; skipped: PromotionSkip[] }> {
  // 퇴원생(is_active=false)은 올리지 않는다. 그만둔 시점의 학년으로 남는 게 맞다.
  const rows = await db
    .select({
      id: students.id,
      name: students.name,
      grade: students.grade,
      school: students.school,
    })
    .from(students)
    .where(and(eq(students.tenantId, tenantId), eq(students.isActive, true)));

  const changes: PromotionChange[] = [];
  const skipped: PromotionSkip[] = [];

  for (const s of rows) {
    const parsed = parseGrade(s.grade, s.school);
    if (!parsed) {
      skipped.push({
        id: s.id,
        name: s.name,
        grade: s.grade ?? "",
        reason: !(s.grade ?? "").trim()
          ? "학년이 비어 있음"
          : "초·중·고를 알 수 없음",
      });
      continue;
    }
    const next = promoteGrade(s.grade, s.school, steps);
    if (next === null) {
      skipped.push({
        id: s.id,
        name: s.name,
        grade: s.grade ?? "",
        reason: "고3 — 졸업이라 더 올리지 않음",
      });
      continue;
    }
    changes.push({
      id: s.id,
      name: s.name,
      from: s.grade ?? "",
      to: next,
      needsNewSchool: changesSchoolLevel(parsed),
    });
  }

  return { changes, skipped };
}

/**
 * 밀린 학년도가 있는 학원을 찾아 진급시킨다. 이미 반영된 학원은 건너뛴다.
 * `today`는 테스트가 날짜를 고정할 수 있도록 주입받는다.
 */
export async function runGradePromotion(
  today = todayKst()
): Promise<PromotionResult[]> {
  const currentYear = schoolYearOf(today);

  // 아직 한 번도 안 돌았거나(NULL), 반영 학년도가 뒤처진 학원만 대상이다.
  const targets = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      lastYear: tenants.lastGradePromotionYear,
    })
    .from(tenants)
    .where(
      or(
        isNull(tenants.lastGradePromotionYear),
        lt(tenants.lastGradePromotionYear, currentYear)
      )
    );

  const results: PromotionResult[] = [];

  for (const t of targets) {
    // 처음 켠 학원은 기준점만 찍고 끝낸다. 여기서 올리면 배포한 날 전원이 진급한다.
    if (t.lastYear === null) {
      await db
        .update(tenants)
        .set({ lastGradePromotionYear: currentYear })
        .where(eq(tenants.id, t.id));
      console.log(
        `[학년진급] ${t.name}: 기준 학년도를 ${currentYear}로 설정 (진급 없음)`
      );
      continue;
    }

    const steps = currentYear - t.lastYear;
    const { changes, skipped } = await planPromotion(t.id, steps);

    await db.transaction(async (tx) => {
      for (const c of changes) {
        await tx
          .update(students)
          .set({ grade: c.to, updatedAt: new Date() })
          .where(eq(students.id, c.id));
      }
      await tx
        .update(tenants)
        .set({ lastGradePromotionYear: currentYear })
        .where(eq(tenants.id, t.id));
    });

    console.log(
      `[학년진급] ${t.name}: ${t.lastYear}→${currentYear}학년도 ` +
        `(${steps}년치) — ${changes.length}명 진급, ${skipped.length}명 보류`
    );
    // 보류된 학생은 원장이 손으로 고쳐야 하므로 로그에 남긴다.
    for (const s of skipped) {
      console.log(`  · 보류: ${s.name} ("${s.grade}") — ${s.reason}`);
    }

    results.push({
      tenantId: t.id,
      tenantName: t.name,
      fromYear: t.lastYear,
      toYear: currentYear,
      steps,
      changes,
      skipped,
    });
  }

  return results;
}

/**
 * 부팅 직후 한 번, 그 뒤로 6시간마다 확인한다.
 *
 * 3월 1일 정각에 맞춰 도는 게 아니라 "학년도가 넘어갔는지"를 주기적으로 보는
 * 방식이다. 서버가 며칠 꺼져 있어도 다시 켜지는 순간 따라잡는다.
 */
export function startGradePromotionScheduler() {
  const tick = () => {
    runGradePromotion().catch((err) => {
      // 진급에 실패해도 서비스는 계속 돌아야 한다.
      console.error("❌ 학년 자동 진급 실패:", err);
    });
  };
  tick();
  setInterval(tick, 6 * 60 * 60 * 1000);
}
