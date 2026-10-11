/**
 * 자동으로 적힐 할 일을 미리 본다. `npm run funnel:preview`
 *
 * **DB를 고치지 않는다.** 읽기만 한다. 실제로 적는 일은 서버가 알아서 하고,
 * 이 스크립트는 "지금 돌면 무엇이 적힐지" 를 눈으로 확인하는 용도다.
 *
 * 사람 없이 도는 기능은 켜기 전에 확인할 길이 있어야 한다. 처음 켜는 날
 * 옛 상담 기록 수백 건이 할 일로 쏟아지는 사고를 이걸로 먼저 걸러 낸다.
 * (규칙에 45일 포기 기한과 하루 12줄 상한이 있지만, 눈으로 보는 것이 제일 확실하다.)
 */

import "dotenv/config";
import { db } from "../server/db";
import { tenants } from "@shared/schema";
import { planFunnelAlerts } from "../server/lib/funnelWatch";
import { todayKst } from "@shared/day";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL이 없습니다.");
    process.exit(1);
  }
  // 비밀번호는 찍지 않는다. 어느 DB를 보고 있는지만 알면 된다.
  console.log(`대상 DB: ${new URL(url).host}`);
  const today = todayKst();
  console.log(`오늘(KST): ${today}\n`);

  const all = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);

  for (const t of all) {
    const { alerts, fresh } = await planFunnelAlerts(t.id, today);
    if (!alerts.length) {
      console.log(`━━━ ${t.name} — 놓친 자리 없음\n`);
      continue;
    }

    const already = alerts.length - fresh.length;
    console.log(
      `━━━ ${t.name} — 찾은 자리 ${alerts.length}건` +
        (already ? ` (이미 적어 둔 것 ${already}건 제외)` : "")
    );
    if (!fresh.length) {
      console.log("  새로 적을 것 없음 (모두 이미 할 일에 있습니다)\n");
      continue;
    }
    console.log(`\n  지금 돌면 적힐 할 일 ${fresh.length}건`);
    for (const a of fresh) {
      console.log(`    · ${a.title}`);
      console.log(`      ${a.notes}`);
    }
    console.log("");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
