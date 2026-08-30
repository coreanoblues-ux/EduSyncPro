/**
 * 장부 반영(수기 대사) 500 오류 진단.
 *
 * ── 왜 이 스크립트가 있나 ──
 *   원장 화면에는 "500: 대사 처리 중 오류가 발생했습니다" 만 떴고, 나는 Railway
 *   로그를 못 본다. 추측으로 코드를 고치면 또 배포하고 또 눌러 보게 하는
 *   왕복이 반복된다. 그래서 실제 데이터를 직접 본다.
 *
 * ⚠️ 이 스크립트는 SELECT 만 한다. INSERT·UPDATE·DELETE 를 한 줄도 쓰지 않는다.
 *    운영 DB 에 붙는 스크립트이므로 이 규칙을 깨지 말 것.
 *
 * 실행: npx tsx scripts/diag-reconcile.ts
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function h(title: string) {
  console.log("\n" + "─".repeat(72));
  console.log(title);
  console.log("─".repeat(72));
}

async function main() {
  // 1. payments 에 외부결제 컬럼이 실제로 있는지 (마이그레이션 누락이면 전부 500)
  h("1. payments 테이블의 외부결제 컬럼");
  const cols = await pool.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'payments'
        AND column_name IN ('external_provider','external_payment_key',
                            'external_transaction_id','paid_via','enrollment_id','created_by')
      ORDER BY column_name`
  );
  if (cols.rowCount === 0) {
    console.log("❌ 외부결제 컬럼이 하나도 없습니다 — 마이그레이션 미실행!");
  } else {
    console.table(cols.rows);
  }

  // 2. 문제의 두 건 (269,000 / 1,000) 을 포함한 최근 intent
  h("2. 최근 payment_intents (금액 269000 · 1000 우선)");
  const intents = await pool.query(
    `SELECT id, payment_key, status, amount, payment_month,
            enrollment_id, student_id, created_at, approved_at, failure_reason
       FROM payment_intents
      ORDER BY (amount IN (269000, 1000)) DESC, created_at DESC
      LIMIT 12`
  );
  console.table(
    intents.rows.map((r) => ({
      amount: r.amount,
      status: r.status,
      month: r.payment_month,
      pk: String(r.payment_key).slice(0, 14) + "…",
      enrollment: r.enrollment_id ? String(r.enrollment_id).slice(0, 8) : "NULL",
      created: new Date(r.created_at).toISOString().slice(5, 16),
    }))
  );

  const targets = intents.rows.filter((r) => r.amount === 269000 || r.amount === 1000);
  if (targets.length === 0) {
    console.log("⚠️ 269,000 / 1,000 짜리 intent 를 못 찾았습니다.");
  }

  for (const t of targets) {
    h(`3. 상세 진단 — ${t.amount.toLocaleString()}원 (status=${t.status})`);

    // 3a. enrollment 가 살아 있는가 (payments.enrollment_id FK 대상)
    const enr = await pool.query(
      `SELECT id, tenant_id, student_id, class_id FROM enrollments WHERE id = $1`,
      [t.enrollment_id]
    );
    console.log(
      `enrollment 존재: ${enr.rowCount ? "✅ 있음" : "❌ 없음 (FK 위반 → 500 원인)"}`
    );

    // 3b. 이미 장부에 있는가
    const pay = await pool.query(
      `SELECT id, amount, type, paid_via, created_by, paid_date
         FROM payments WHERE external_payment_key = $1`,
      [t.payment_key]
    );
    console.log(`payments 행: ${pay.rowCount}건`);
    if (pay.rowCount) console.table(pay.rows);

    // 3c. 승인 원본이 있는가
    const txr = await pool.query(
      `SELECT id, intent_id, approval_number, payment_method
         FROM toss_payment_transactions WHERE payment_key = $1 OR intent_id = $2`,
      [t.payment_key, t.id]
    );
    console.log(`toss_payment_transactions 행: ${txr.rowCount}건`);
    if (txr.rowCount) console.table(txr.rows);
  }

  // 4. created_by FK — 로그인 사용자가 users 에 실존하는가
  h("4. owner/superadmin 계정이 users 테이블에 실존하는가");
  const users = await pool.query(
    `SELECT id, username, role, tenant_id FROM users
      WHERE role IN ('owner','superadmin') ORDER BY role LIMIT 10`
  );
  console.table(
    users.rows.map((u) => ({
      id: String(u.id).slice(0, 10) + "…",
      username: u.username,
      role: u.role,
      tenant: u.tenant_id ? String(u.tenant_id).slice(0, 8) : "NULL",
    }))
  );

  // 5. payments 에 걸린 제약 (중복 방지 인덱스가 실제로 있는지)
  h("5. payments 테이블 제약·인덱스");
  const idx = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'payments'`
  );
  idx.rows.forEach((r) => console.log(` · ${r.indexname}: ${r.indexdef.slice(0, 110)}`));

  // 6. payments 의 NOT NULL 컬럼 전체 — 삽입에서 빠뜨린 게 있는지
  h("6. payments 의 NOT NULL 컬럼 (기본값 없는 것만 = 반드시 넣어야 함)");
  const nn = await pool.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_name='payments' AND is_nullable='NO' AND column_default IS NULL
      ORDER BY ordinal_position`
  );
  console.table(nn.rows);
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error("진단 실패:", e.message);
    await pool.end();
    process.exit(1);
  });
