/**
 * payments 에 "같은 카드 승인은 장부에 딱 한 줄" 을 DB 차원에서 못 박는다.
 *
 * 실행: npx tsx scripts/migrate-add-payment-idempotency.ts
 *
 * ── 왜 필요한가 ──
 *   shared/schema.ts 199행에는 이렇게 적혀 있었다:
 *
 *     externalPaymentKey: text("external_payment_key"), // Toss paymentKey (unique index로 중복 승인 차단)
 *
 *   그런데 **그 unique index 는 만들어진 적이 없다.** 컬럼 정의에도 .unique() 가
 *   없고, migrate-add-toss-front.ts 도 그냥 TEXT 로만 추가했다. 주석만 있고
 *   제약은 없는 상태로 운영돼 온 것이다.
 *
 *   지금까지 중복이 안 난 이유는 toss_payment_transactions.payment_key 의
 *   UNIQUE 덕분이다. 승인·웹훅·수기대사 세 경로가 모두 그 행을 먼저 넣고,
 *   성공했을 때만 payments 에 넣는다. 즉 방어는 실재하지만 **애플리케이션 코드
 *   안에만** 있다. 경로가 하나만 더 생기거나 누가 순서를 바꾸면 조용히 뚫린다.
 *
 *   돈이 두 번 적히는 사고는 되돌리기 어렵다. 코드의 선의가 아니라 DB 가
 *   막게 만든다.
 *
 * ── 왜 "부분" 유니크인가 (WHERE amount > 0) ──
 *   환불은 같은 external_payment_key 에 **음수** 행으로 들어간다
 *   (webhooks.ts 취소 경로, admin.ts 환불). 그냥 UNIQUE 를 걸면 환불이 통째로
 *   막혀서, 중복을 막으려다 환불을 못 하게 되는 더 나쁜 상황이 된다.
 *
 *   그래서 "수입 행(amount > 0)은 결제키당 하나" 만 강제한다. 환불 행은 제약
 *   밖이라 자유롭게 들어가고, 부분환불이 여러 번이어도 문제없다.
 *
 * ── 부분결제와 충돌하지 않는 이유 ──
 *   원장이 한 달 수강료를 카드 세 장으로 나눠 받으면 dispatch 가 세 번 생기고
 *   paymentKey 도 세 개다 (payments.ts generatePaymentKey). 그래서 payments 에
 *   세 줄이 들어가고 이 인덱스에 전혀 걸리지 않는다. 이 인덱스가 막는 것은
 *   "같은 승인 한 건이 두 줄이 되는 것" 뿐이다.
 *
 * 여러 번 실행해도 안전하다. 기존 데이터를 지우거나 바꾸지 않는다.
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const INDEX_NAME = "payments_external_payment_key_income_uniq";

async function main() {
  const client = await pool.connect();
  try {
    // 1) 이미 있으면 아무것도 하지 않는다.
    const existing = await client.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
      [INDEX_NAME]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      console.log(`✅ 이미 존재합니다: ${INDEX_NAME} — 변경 없음`);
      return;
    }

    // 2) ⚠️ 먼저 기존 중복을 조사한다.
    //
    //    유니크 인덱스는 위반 데이터가 있으면 생성 자체가 실패한다. 그때
    //    "duplicate key value violates unique constraint" 만 던지고 끝내면
    //    원장은 무엇을 어떻게 고쳐야 하는지 알 수 없다. 돈이 걸린 행이므로
    //    이 스크립트가 임의로 지우는 것은 절대 하지 않는다 — 무엇이 겹쳤는지
    //    사람이 읽을 수 있게 보여 주고 멈춘다.
    const dupes = await client.query(`
      SELECT external_payment_key,
             count(*)        AS rows,
             sum(amount)     AS total,
             min(created_at) AS first_at,
             max(created_at) AS last_at
        FROM payments
       WHERE external_payment_key IS NOT NULL
         AND amount > 0
       GROUP BY external_payment_key
      HAVING count(*) > 1
       ORDER BY count(*) DESC
       LIMIT 50
    `);

    if (dupes.rowCount && dupes.rowCount > 0) {
      console.error(
        `\n❌ 같은 결제키로 수입이 두 번 이상 적힌 건이 ${dupes.rowCount}개 있습니다.\n` +
          `   인덱스를 만들기 전에 사람이 판단해야 합니다. 자동으로 지우지 않습니다.\n`
      );
      for (const r of dupes.rows) {
        console.error(
          `   · ${r.external_payment_key}  ${r.rows}줄 · 합계 ${r.total}원 · ${r.first_at} ~ ${r.last_at}`
        );
      }
      console.error(
        `\n   확인용 SQL:\n` +
          `     SELECT id, enrollment_id, amount, payment_month, paid_date, notes\n` +
          `       FROM payments WHERE external_payment_key = '<키>' ORDER BY created_at;\n\n` +
          `   중복이 맞다면 나중에 들어온 행을 지운 뒤 이 스크립트를 다시 실행하세요.\n`
      );
      process.exitCode = 1;
      return;
    }

    // 3) 생성. CONCURRENTLY 는 트랜잭션 밖에서만 되고 실패 시 INVALID 인덱스를
    //    남긴다. payments 는 학원 규모상 작아서 짧은 잠금으로 충분하다.
    console.log(`⏳ 인덱스 생성 중: ${INDEX_NAME} ...`);
    await client.query(`
      CREATE UNIQUE INDEX ${INDEX_NAME}
          ON payments (external_payment_key)
       WHERE external_payment_key IS NOT NULL AND amount > 0
    `);
    console.log(
      `✅ 생성 완료: ${INDEX_NAME}\n` +
        `   이제 같은 Toss 결제키로 수입 행이 두 번 들어가면 DB 가 거부합니다.\n` +
        `   (환불 음수 행과 부분결제는 영향 없음)`
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("마이그레이션 실패:", err);
  process.exit(1);
});
