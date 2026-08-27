/**
 * Toss "결제 단말기 모드" 확장 마이그레이션.
 *
 * 기존 migrate-add-toss-front.ts가 만든 자산은 건드리지 않는다.
 * 이 스크립트는 태블릿(학생 키오스크 웹) ↔ 서버 ↔ 프론트 사이 라우팅에 필요한
 * 두 테이블만 추가한다:
 *   1. kiosk_devices        - 태블릿 웹앱 인증용 장기키
 *   2. payment_dispatches   - 태블릿에서 만든 결제요청의 프론트 라우팅 큐
 *
 * enum 하나(payment_dispatch_status)도 함께 만든다.
 *
 * 실행: npx tsx scripts/migrate-add-toss-kiosk.ts (여러 번 실행 안전)
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const NEW_ENUMS: Array<{ name: string; values: string[] }> = [
  {
    name: "payment_dispatch_status",
    values: ["PENDING", "DELIVERED", "APPROVED", "CANCELED", "TIMEOUT", "FAILED"],
  },
];

const NEW_TABLES: Array<{ name: string; ddl: string }> = [
  {
    name: "kiosk_devices",
    ddl: `
      CREATE TABLE IF NOT EXISTS kiosk_devices (
        id                       VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        kiosk_key_hash           TEXT NOT NULL UNIQUE,
        display_name             TEXT NOT NULL,
        paired_front_device_id   VARCHAR REFERENCES toss_front_devices(id) ON DELETE SET NULL,
        is_active                BOOLEAN NOT NULL DEFAULT TRUE,
        last_seen_at             TIMESTAMP,
        created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "payment_dispatches",
    ddl: `
      CREATE TABLE IF NOT EXISTS payment_dispatches (
        id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        payment_key       TEXT NOT NULL UNIQUE,
        intent_id         VARCHAR NOT NULL UNIQUE REFERENCES payment_intents(id) ON DELETE CASCADE,
        kiosk_device_id   VARCHAR REFERENCES kiosk_devices(id) ON DELETE SET NULL,
        toss_device_id    VARCHAR NOT NULL REFERENCES toss_front_devices(id) ON DELETE SET NULL,
        amount            INTEGER NOT NULL,
        order_id          TEXT NOT NULL DEFAULT '',
        order_name        TEXT NOT NULL DEFAULT '',
        status            payment_dispatch_status NOT NULL DEFAULT 'PENDING',
        delivered_at      TIMESTAMP,
        responded_at      TIMESTAMP,
        expires_at        TIMESTAMP NOT NULL,
        failure_reason    TEXT,
        created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
];

// 기존 payment_dispatches 테이블이 이미 만들어졌을 수 있으므로 컬럼 추가는 별도로 idempotent 처리.
const COLUMN_ADDS: string[] = [
  `ALTER TABLE payment_dispatches ADD COLUMN IF NOT EXISTS order_id   TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE payment_dispatches ADD COLUMN IF NOT EXISTS order_name TEXT NOT NULL DEFAULT ''`,
];

const INDEXES: string[] = [
  // 특정 프론트의 대기 dispatch 조회 (SSE·폴백 폴링)
  `CREATE INDEX IF NOT EXISTS idx_dispatches_front_pending
     ON payment_dispatches (toss_device_id, status, created_at DESC)`,
  // 태블릿이 자기 dispatch 상태 폴링
  `CREATE INDEX IF NOT EXISTS idx_dispatches_kiosk
     ON payment_dispatches (kiosk_device_id, created_at DESC)`,
  // 관리자 모니터링
  `CREATE INDEX IF NOT EXISTS idx_dispatches_tenant_status
     ON payment_dispatches (tenant_id, status, created_at DESC)`,
  // 만료 배치용
  `CREATE INDEX IF NOT EXISTS idx_dispatches_expiry
     ON payment_dispatches (expires_at) WHERE status IN ('PENDING','DELIVERED')`,
  // 태블릿 활성 여부 조회
  `CREATE INDEX IF NOT EXISTS idx_kiosk_tenant_active
     ON kiosk_devices (tenant_id, is_active)`,
];

async function enumExists(name: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM pg_type WHERE typname = $1 AND typtype = 'e'`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function enumValueExists(enumName: string, value: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = $1 AND e.enumlabel = $2`,
    [enumName, value],
  );
  return (r.rowCount ?? 0) > 0;
}

async function ensureEnum(name: string, values: string[]): Promise<boolean> {
  const exists = await enumExists(name);
  if (!exists) {
    const list = values.map((v) => `'${v}'`).join(", ");
    await pool.query(`CREATE TYPE ${name} AS ENUM (${list})`);
    return true;
  }
  for (const v of values) {
    if (!(await enumValueExists(name, v))) {
      await pool.query(`ALTER TYPE ${name} ADD VALUE IF NOT EXISTS '${v}'`);
    }
  }
  return false;
}

async function tableExists(name: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1`,
    [name],
  );
  return (r.rowCount ?? 0) > 0;
}

async function main() {
  console.log("▶ Toss 결제 단말기 모드 마이그레이션 시작");

  let enumsCreated = 0;
  for (const e of NEW_ENUMS) {
    const created = await ensureEnum(e.name, e.values);
    console.log(`  enum ${e.name}: ${created ? "생성됨" : "확인됨/값 병합"}`);
    if (created) enumsCreated++;
  }

  let tablesCreated = 0;
  for (const t of NEW_TABLES) {
    const existedBefore = await tableExists(t.name);
    await pool.query(t.ddl);
    const existsNow = await tableExists(t.name);
    if (!existedBefore && existsNow) {
      tablesCreated++;
      console.log(`  table ${t.name}: 생성됨`);
    } else {
      console.log(`  table ${t.name}: 이미 존재`);
    }
  }

  for (const stmt of COLUMN_ADDS) {
    await pool.query(stmt);
  }
  console.log(`  columns: ${COLUMN_ADDS.length}개 실행 (ADD COLUMN IF NOT EXISTS)`);

  for (const idx of INDEXES) {
    await pool.query(idx);
  }
  console.log(`  indexes: ${INDEXES.length}개 실행 (IF NOT EXISTS)`);

  console.log(
    `✔ 완료 — enum ${enumsCreated}개, table ${tablesCreated}개 새로 추가`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ 마이그레이션 실패:", err);
  await pool.end();
  process.exit(1);
});
