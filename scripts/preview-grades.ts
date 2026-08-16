/**
 * 다음 3월에 학년이 어떻게 바뀔지 미리 본다. `npm run grades:preview`
 *
 * **DB를 고치지 않는다.** 읽기만 한다. 실제 진급은 서버가 3월을 넘긴 걸 확인하고
 * 알아서 하며, 이 스크립트는 그때 무슨 일이 일어날지 지금 확인하는 용도다.
 * 특히 "보류" 목록 — 학년을 알 수 없어 그대로 두는 학생들 — 을 미리 손봐 두면
 * 3월에 놓치는 학생이 없다.
 */

import "dotenv/config";
import { db } from "../server/db";
import { tenants } from "@shared/schema";
import { planPromotion } from "../server/lib/gradePromotion";
import { todayKst } from "@shared/day";
import { schoolYearOf } from "@shared/gradePromotion";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL이 없습니다.");
    process.exit(1);
  }
  // 비밀번호는 찍지 않는다. 어느 DB를 보고 있는지만 알면 된다.
  console.log(`대상 DB: ${new URL(url).host}`);
  console.log(`오늘(KST): ${todayKst()} — ${schoolYearOf(todayKst())}학년도\n`);

  const all = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      lastYear: tenants.lastGradePromotionYear,
    })
    .from(tenants);

  for (const t of all) {
    const { changes, skipped } = await planPromotion(t.id, 1);
    if (changes.length === 0 && skipped.length === 0) continue;

    console.log(`━━━ ${t.name} (반영 학년도: ${t.lastYear ?? "미설정"})`);
    console.log(`\n  다음 3월에 바뀔 학생 ${changes.length}명`);
    for (const c of changes) {
      const mark = c.needsNewSchool ? "  ← 학교 정보도 새로 받아야 함" : "";
      console.log(`    ${c.name.padEnd(6)} ${c.from} → ${c.to}${mark}`);
    }

    if (skipped.length) {
      console.log(`\n  그대로 두는 학생 ${skipped.length}명`);
      for (const s of skipped) {
        console.log(
          `    ${s.name.padEnd(6)} "${s.grade}" — ${s.reason}`
        );
      }
    }
    console.log("");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
