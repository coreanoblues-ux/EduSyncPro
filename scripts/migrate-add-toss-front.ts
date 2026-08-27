/**
 * Toss Front 2 통합에 필요한 스키마 변경을 멱등하게 적용한다.
 *
 * 실행: npx tsx scripts/migrate-add-toss-front.ts
 *
 * drizzle-kit push가 새 enum·테이블·컬럼을 자동으로 만들어 줄 수도 있지만,
 * 결제·웹훅처럼 사고 시 복구가 어려운 스키마는 배포 순서를 손으로 잡는다.
 * 여러 번 실행해도 안전하다 (IF NOT EXISTS + pg_enum/information_schema 조회).
 *
 * 이 스크립트가 하는 일:
 *   1. 새 enum 6개 생성 (payment_intent_status, toss_webhook_status, toss_payment_method,
 *      external_provider, paid_via, attendance_source)
 *   2. payments 테이블에 external 연결 컬럼 4개 추가
 *   3. 새 테이블 5개 생성 (attendance, toss_front_devices, payment_intents,
 *      toss_payment_transactions, toss_webhook_events)
 *   4. 결제·출석 조회 인덱스 생성
 *
 * 마이그레이션은 additive다. 기존 컬럼·테이블을 삭제하거나 이름을 바꾸지 않는다.
 * 롤백이 필요하면 새로 만든 것만 지우면 되며, 기존 EduSyncPro 기능은 영향받지 않는다.
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ─── enum 정의 ──────────────────────────────────────────────────────────────
const NEW_ENUMS: Array<{ name: string; values: string[] }> = [
  {
    name: "payment_intent_status",
    values: ["CREATED", "PROCESSING", "APPROVED", "CANCELED", "TIMEOUT", "FAILED"],
  },
  { name: "toss_webhook_status", values: ["RECEIVED", "PROCESSED", "IGNORED", "FAILED"] },
  { name: "toss_payment_method", values: ["CARD", "CASH", "BARCODE"] },
  { name: "external_provider", values: ["TOSSPLACE"] },
  { name: "paid_via", values: ["MANUAL", "TOSS_FRONT"] },
  { name: "attendance_source", values: ["MANUAL", "KIOSK"] },
];

// ─── payments 테이블에 추가할 컬럼 ─────────────────────────────────────────
// paid_via는 기본값 'MANUAL'로 넣어야 기존 행이 NOT NULL 제약을 위반하지 않는다.
const PAYMENTS_NEW_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "external_provider", ddl: "external_provider" },
  { name: "external_payment_key", ddl: "TEXT" },
  { name: "external_transaction_id", ddl: "VARCHAR" },
  { name: "paid_via", ddl: "paid_via NOT NULL DEFAULT 'MANUAL'" },
];

// ─── 새 테이블 DDL ─────────────────────────────────────────────────────────
const NEW_TABLES: Array<{ name: string; ddl: string }> = [
  {
    name: "attendance",
    ddl: `
      CREATE TABLE IF NOT EXISTS attendance (
        id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        student_id      VARCHAR NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        class_id        VARCHAR NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        attended_date   TEXT    NOT NULL,
        checked_in_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        source          attendance_source NOT NULL DEFAULT 'MANUAL',
        device_id       VARCHAR,
        notes           TEXT,
        created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "toss_front_devices",
    ddl: `
      CREATE TABLE IF NOT EXISTS toss_front_devices (
        id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        merchant_id       TEXT NOT NULL,
        device_key_hash   TEXT NOT NULL UNIQUE,
        display_name      TEXT NOT NULL,
        is_active         BOOLEAN NOT NULL DEFAULT TRUE,
        last_seen_at      TIMESTAMP,
        created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "payment_intents",
    ddl: `
      CREATE TABLE IF NOT EXISTS payment_intents (
        id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        payment_key       TEXT NOT NULL UNIQUE,
        student_id        VARCHAR NOT NULL REFERENCES students(id) ON DELETE CASCADE,
        enrollment_id     VARCHAR NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
        payment_month     TEXT NOT NULL,
        device_id         VARCHAR REFERENCES toss_front_devices(id) ON DELETE SET NULL,
        amount            INTEGER NOT NULL,
        tax               INTEGER NOT NULL DEFAULT 0,
        supply_value      INTEGER NOT NULL DEFAULT 0,
        tax_exempt_value  INTEGER NOT NULL DEFAULT 0,
        status            payment_intent_status NOT NULL DEFAULT 'CREATED',
        expires_at        TIMESTAMP NOT NULL,
        approved_at       TIMESTAMP,
        cancelled_at      TIMESTAMP,
        failure_reason    TEXT,
        created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "toss_payment_transactions",
    ddl: `
      CREATE TABLE IF NOT EXISTS toss_payment_transactions (
        id                    VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id             VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        payment_key           TEXT NOT NULL UNIQUE,
        intent_id             VARCHAR NOT NULL UNIQUE REFERENCES payment_intents(id) ON DELETE CASCADE,
        payment_method        toss_payment_method NOT NULL,
        van                   TEXT,
        tid                   TEXT,
        van_transaction_key   TEXT,
        approval_number       TEXT NOT NULL,
        approved_timestamp    TEXT NOT NULL,
        masked_card_number    TEXT,
        issuer_name           TEXT,
        acquirer_name         TEXT,
        card_type             TEXT,
        installment           INTEGER NOT NULL DEFAULT 0,
        raw_response_json     TEXT,
        created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    name: "toss_webhook_events",
    ddl: `
      CREATE TABLE IF NOT EXISTS toss_webhook_events (
        webhook_id       TEXT PRIMARY KEY,
        tenant_id        VARCHAR REFERENCES tenants(id) ON DELETE CASCADE,
        event_id         TEXT,
        delivery_id      TEXT,
        event_type       TEXT,
        signature_valid  BOOLEAN NOT NULL DEFAULT FALSE,
        status           toss_webhook_status NOT NULL DEFAULT 'RECEIVED',
        payload_json     TEXT,
        error_message    TEXT,
        received_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        processed_at     TIMESTAMP
      )
    `,
  },
];

// ─── 인덱스 (조회 성능·중복 방지) ──────────────────────────────────────────
const INDEXES: string[] = [
  // 같은 학생·같은 수업의 하루 이중 출석 차단
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique_day
     ON attendance (student_id, class_id, attended_date)`,
  // 관리자 화면에서 "오늘 출석"을 자주 조회
  `CREATE INDEX IF NOT EXISTS idx_attendance_tenant_date
     ON attendance (tenant_id, attended_date DESC)`,
  // 미납 조회 시 (enrollment, month)를 자주 본다
  `CREATE INDEX IF NOT EXISTS idx_payment_intents_enrollment_month
     ON payment_intents (enrollment_id, payment_month)`,
  // 관리자 결제 모니터링 화면용
  `CREATE INDEX IF NOT EXISTS idx_payment_intents_tenant_status
     ON payment_intents (tenant_id, status, created_at DESC)`,
  // 웹훅으로 온 paymentKey로 원거래 조회
  `CREATE INDEX IF NOT EXISTS idx_toss_transactions_tenant
     ON toss_payment_transactions (tenant_id, created_at DESC)`,
  // 웹훅 상태 모니터링 (FAILED 큐 조회)
  `CREATE INDEX IF NOT EXISTS idx_webhook_status_received
     ON toss_webhook_events (status, received_at DESC)`,
  // 기기 인증 (deviceKeyHash로 매 요청 조회)
  `CREATE INDEX IF NOT EXISTS idx_devices_tenant_active
     ON toss_front_devices (tenant_id, is_active)`,
];

// ─── helper: 존재 여부 확인 후 생성 ────────────────────────────────────────
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
    // CREATE TYPE ... AS ENUM (...)는 트랜잭션 안에서 실행해도 되지만,
    // 여기서는 자동 커밋 모드로 단순하게 처리한다.
    const list = values.map((v) => `'${v}'`).join(", ");
    await pool.query(`CREATE TYPE ${name} AS ENUM (${list})`);
    return true;
  }
  // 이미 있으면 없는 값만 하나씩 추가 (트랜잭션 밖에서 실행 필수)
  for (const v of values) {
    if (!(await enumValueExists(name, v))) {
      await pool.query(`ALTER TYPE ${name} ADD VALUE IF NOT EXISTS '${v}'`);
    }
  }
  return false;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return (r.rowCount ?? 0) > 0;
}

async function ensureColumn(table: string, column: { name: string; ddl: string }): Promise<boolean> {
  if (await columnExists(table, column.name)) return false;
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "${column.name}" ${column.ddl}`);
  return true;
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
  console.log("▶ Toss Front 2 통합 마이그레이션 시작");

  // 1) enum
  let enumsCreated = 0;
  for (const e of NEW_ENUMS) {
    const created = await ensureEnum(e.name, e.values);
    console.log(`  enum ${e.name}: ${created ? "생성됨" : "확인됨/값 병합"}`);
    if (created) enumsCreated++;
  }

  // 2) payments 테이블 컬럼 확장
  let paymentsColumnsAdded = 0;
  for (const c of PAYMENTS_NEW_COLUMNS) {
    const added = await ensureColumn("payments", c);
    console.log(`  payments.${c.name}: ${added ? "추가됨" : "이미 존재"}`);
    if (added) paymentsColumnsAdded++;
  }

  // 3) 새 테이블
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

  // 4) 인덱스
  let indexesRun = 0;
  for (const idx of INDEXES) {
    await pool.query(idx);
    indexesRun++;
  }
  console.log(`  indexes: ${indexesRun}개 실행 (IF NOT EXISTS)`);

  console.log(
    `✔ 완료 — enum ${enumsCreated}개, payments 컬럼 ${paymentsColumnsAdded}개, table ${tablesCreated}개 새로 추가`,
  );
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ 마이그레이션 실패:", err);
  await pool.end();
  process.exit(1);
});
