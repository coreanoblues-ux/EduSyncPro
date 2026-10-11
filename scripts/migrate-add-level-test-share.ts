/**
 * level_tests 에 "학부모용 결과지 링크" 칼럼을 더한다.
 *
 * 실행: npx tsx scripts/migrate-add-level-test-share.ts
 *       (= npm run db:migrate:level-test-share)
 *
 * ── 왜 drizzle-kit push 가 아니라 이 스크립트인가 ──
 *   push 는 스키마 전체를 비교해서 "지워야 할 것" 까지 제안한다. 이 DB 에는
 *   push 가 모르는 제약(결제 부분 유니크, 레벨테스트 복합 유니크)이 여럿 있어서
 *   운영 DB 에 거는 것이 위험하다. 칼럼을 더하는 일은 ADD COLUMN IF NOT EXISTS
 *   한 줄이면 되므로, 이 스크립트가 필요한 것만 한다.
 *
 * ── 안전성 ──
 *   · 여러 번 실행해도 안전하다 (IF NOT EXISTS).
 *   · 기존 데이터를 지우거나 바꾸지 않는다. 더하는 칼럼은 모두 NULL 허용이고,
 *     횟수만 기본값 0 이다.
 *   · 기존 결과지는 링크가 없는 상태(share_token IS NULL)로 남는다. 원장이
 *     필요한 건에서 버튼을 누를 때 생긴다 — 과거 기록 전체에 링크가 자동으로
 *     생기는 일은 없다.
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const TABLE = "level_tests";

/** 칼럼 이름 → 타입. shared/schema.ts 의 levelTests 와 반드시 같아야 한다. */
const COLUMNS: [string, string][] = [
  ["share_token", "TEXT"],
  ["share_created_at", "TIMESTAMP"],
  ["share_expires_at", "TIMESTAMP"],
  ["share_revoked_at", "TIMESTAMP"],
  ["share_view_count", "INTEGER NOT NULL DEFAULT 0"],
  ["share_last_viewed_at", "TIMESTAMP"],
];

/**
 * 토큰 조회용 유니크 인덱스.
 *
 * ── 왜 유니크인가 ──
 *   같은 토큰이 두 행에 있으면 공개 주소가 어느 결과지를 보여 줄지 알 수 없다.
 *   난수 32바이트가 겹칠 일은 사실상 없지만, "사실상 없다" 를 DB 가 보장하게 둔다.
 *
 * ── 왜 WHERE 가 붙은 부분 인덱스인가 ──
 *   링크를 만들지 않은 기록은 share_token 이 NULL 이고, 그런 행이 대부분이다.
 *   NULL 을 인덱스에 넣지 않으면 인덱스가 작게 유지된다. (Postgres 는 NULL 을
 *   서로 다른 값으로 보므로 유니크 자체에는 지장이 없지만, 부분 인덱스로
 *   의도를 분명히 적어 둔다.)
 *
 * ── 왜 인덱스가 필요한가 ──
 *   학부모가 링크를 누를 때마다 share_token 으로 조회한다. 인덱스가 없으면
 *   전체 테이블을 훑는다. 지금은 기록이 적어 체감이 없지만, 몇 년 뒤
 *   수천 건에서 느려지는 것을 미리 막아 둔다.
 */
const INDEX_NAME = "level_tests_share_token_uniq";

async function tableExists(name: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [name]
  );
  return !!(r.rowCount && r.rowCount > 0);
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return !!(r.rowCount && r.rowCount > 0);
}

async function indexExists(name: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [name]);
  return !!(r.rowCount && r.rowCount > 0);
}

async function main() {
  console.log("▶ 학부모용 결과지 링크 칼럼 마이그레이션 시작");

  if (!(await tableExists(TABLE))) {
    throw new Error(
      `"${TABLE}" 테이블이 없습니다. 먼저 npm run db:migrate:level-test-records 를 실행하세요.`
    );
  }

  for (const [name, type] of COLUMNS) {
    if (await columnExists(TABLE, name)) {
      console.log(`  column "${name}": 이미 존재`);
      continue;
    }
    await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    console.log(`  column "${name}": 추가됨 (${type})`);
  }

  if (await indexExists(INDEX_NAME)) {
    console.log(`  index "${INDEX_NAME}": 이미 존재`);
  } else {
    await pool.query(
      `CREATE UNIQUE INDEX ${INDEX_NAME} ON ${TABLE} (share_token) WHERE share_token IS NOT NULL`
    );
    console.log(`  index "${INDEX_NAME}": 생성됨`);
  }

  // 확인: 링크가 달린 기록이 몇 건인가. 처음 실행하면 당연히 0 이어야 한다.
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM ${TABLE} WHERE share_token IS NOT NULL`
  );
  console.log(`\n  현재 링크가 발급된 결과지: ${r.rows[0].n}건`);

  console.log("✔ 완료 — 상담·레벨테스트 화면에서 결과지 링크를 만들 수 있습니다.");
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ 마이그레이션 실패:", err);
  await pool.end();
  process.exit(1);
});
