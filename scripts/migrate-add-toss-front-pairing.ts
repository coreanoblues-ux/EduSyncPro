/**
 * Toss Front 단말기 페어링 UX 개선 (0.3.2) — 짧은 매장코드 + PIN 페어링.
 *
 * 실행: npx tsx scripts/migrate-add-toss-front-pairing.ts
 *
 * 배경:
 *   0.3.1 까지 단말기 온보딩은 44자 base64url raw deviceKey 를 태블릿에 손으로
 *   붙여넣는 방식이었다. 현장에서 오타·개행 문자 삽입 등 실수가 잦아 6자 매장코드
 *   + 4자리 PIN 을 발급하고 단말기가 exchange 하는 흐름으로 바꾼다.
 *
 * 이 스크립트가 하는 일:
 *   toss_front_devices 테이블에 다음 5개 컬럼을 additive 하게 추가한다.
 *     - pairing_code (TEXT UNIQUE) — 발급된 6자 매장코드
 *     - pairing_pin_hash (TEXT) — PIN 의 SHA-256 hex
 *     - pairing_raw_key_encrypted (TEXT) — AES-256-GCM 으로 감싼 raw deviceKey
 *     - pairing_expires_at (TIMESTAMP) — 페어링 유효기간 (24h)
 *     - serial_number (TEXT) — 최초 exchange 때 바인딩되는 단말기 시리얼
 *
 * 롤백: 새로 추가된 컬럼만 지우면 기존 흐름(raw deviceKey 직접 입력) 이 그대로 동작한다.
 *   기존 컬럼·데이터를 삭제·변경하지 않는다.
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const NEW_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "pairing_code", ddl: "TEXT" },
  { name: "pairing_pin_hash", ddl: "TEXT" },
  { name: "pairing_raw_key_encrypted", ddl: "TEXT" },
  { name: "pairing_expires_at", ddl: "TIMESTAMP" },
  { name: "serial_number", ddl: "TEXT" },
];

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return (r.rowCount ?? 0) > 0;
}

async function indexExists(name: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM pg_indexes WHERE indexname = $1`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function main() {
  console.log("▶ toss_front_devices 페어링 컬럼 추가");

  let added = 0;
  for (const c of NEW_COLUMNS) {
    if (await columnExists("toss_front_devices", c.name)) {
      console.log(`  ${c.name}: 이미 존재`);
      continue;
    }
    await pool.query(
      `ALTER TABLE toss_front_devices ADD COLUMN IF NOT EXISTS "${c.name}" ${c.ddl}`,
    );
    console.log(`  ${c.name}: 추가됨`);
    added++;
  }

  // pairing_code 는 unique 여야 한다. 컬럼 추가 자체에 UNIQUE 를 붙이지 않은 이유:
  // 기존 행이 NULL 로 채워질 때 partial index 를 명시적으로 만들어야 나중에 NULL 여럿을 허용하면서도
  // 발급된 코드끼리는 중복이 안 되게 만들 수 있다.
  const idxName = "idx_toss_front_devices_pairing_code";
  if (!(await indexExists(idxName))) {
    await pool.query(
      `CREATE UNIQUE INDEX ${idxName}
         ON toss_front_devices (pairing_code)
        WHERE pairing_code IS NOT NULL`,
    );
    console.log(`  index ${idxName}: 생성됨`);
  } else {
    console.log(`  index ${idxName}: 이미 존재`);
  }

  console.log(`✔ 완료 — 컬럼 ${added}개 새로 추가`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ 마이그레이션 실패:", err);
  await pool.end();
  process.exit(1);
});
