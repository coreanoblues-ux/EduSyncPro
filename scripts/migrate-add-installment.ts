/**
 * 카드 할부: payment_intents 에 요청 할부개월 칸을 하나 더한다.
 *
 * 실행: npx tsx scripts/migrate-add-installment.ts
 *
 * ── 무엇을 하는가 ──
 *   payment_intents.requested_installment  INTEGER NULL  (컬럼 추가 하나뿐)
 *
 * ── 무엇을 하지 않는가 ──
 *   · 기존 행을 단 한 줄도 UPDATE 하지 않는다.
 *   · 컬럼을 지우거나 이름을 바꾸지 않는다.
 *   · toss_payment_transactions.installment 은 손대지 않는다 — 그건 이미 있고
 *     이미 잘 쓰이고 있다(승인된 개월수). 이번에 추가하는 건 "요청한 개월수" 다.
 *
 * ── 왜 NOT NULL DEFAULT 0 이 아닌가 ──
 *   기존 intent 는 할부 개념이 없던 시절에 만들어졌다. 그걸 전부 0 으로 채우면
 *   "일시불로 요청했다" 는 사실을 우리가 지어내는 것이 된다. 실제로는 요청 자체가
 *   없었다. 모르는 것은 NULL 로 두고, 읽는 쪽에서 0(일시불)으로 해석한다.
 *   덤으로 NOT NULL DEFAULT 를 붙이지 않으면 큰 테이블에서도 즉시 끝난다
 *   (Postgres 11+ 는 default 있는 추가도 빠르지만, 아예 안 쓰는 편이 더 확실하다).
 *
 * 여러 번 실행해도 안전하다. 기존 결제·취소 흐름을 건드리지 않는다.
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const TABLE = "payment_intents";
const COLUMN = "requested_installment";

async function main() {
  const client = await pool.connect();
  try {
    // 전제 테이블 확인. 없으면 아무것도 하지 않는다 — 엉뚱한 DB 일 가능성이 크고,
    // 그 상태로 ALTER 를 밀어붙이면 반쪽짜리 스키마가 남는다.
    const t = await client.query(`SELECT to_regclass($1) AS oid`, [TABLE]);
    if (!t.rows[0]?.oid) {
      console.error(
        `\n❌ 전제 테이블 '${TABLE}' 이 없습니다. DATABASE_URL 이 올바른 DB 를 가리키는지 확인하세요.\n` +
          `   아무것도 바꾸지 않고 중단합니다.\n`
      );
      process.exitCode = 1;
      return;
    }

    const exists = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [TABLE, COLUMN]
    );
    if (exists.rowCount) {
      console.log(`✅ 이미 적용되어 있습니다 — 변경 없음 (${TABLE}.${COLUMN})`);
      return;
    }

    await client.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INTEGER`);
    console.log(`✅ 추가 완료: ${TABLE}.${COLUMN} (INTEGER, NULL 허용)`);
    console.log(
      "\n기존 행은 한 줄도 바뀌지 않았습니다 (전부 NULL = 할부 요청 정보 없음).\n" +
        "승인된 할부개월은 예전처럼 toss_payment_transactions.installment 에 저장됩니다."
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
