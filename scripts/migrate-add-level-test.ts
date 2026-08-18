/**
 * 상담 → 레벨테스트 흐름 도입에 필요한 스키마 변경을 멱등하게 적용한다.
 *
 * 실행: npx tsx scripts/migrate-add-level-test.ts
 *
 * drizzle-kit push는 pgEnum에 값을 추가하려 할 때 (혹시 있을 수 있는) 데이터
 * 손실을 이유로 대화형 확인을 요구할 수 있고, Railway의 preDeploy에서는
 * 대화가 불가능해 배포가 통째로 멈춘다. 이 스크립트는 그 위험 구간만 미리
 * 처리한 뒤 drizzle-kit push가 나머지 (컬럼 추가) 만 안전하게 처리하도록 한다.
 *
 * 여러 번 실행해도 안전하다 (IF NOT EXISTS 사용).
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// 상담 흐름 확장에 새로 추가되는 상태값
const NEW_STATUS_VALUES = ["레벨테스트예정", "레벨테스트완료", "반배정상담"];

// 상담 테이블에 새로 추가되는 컬럼 (drizzle-kit push가 처리해줘도 되지만,
// 배포 순서 사고를 방지하기 위해 여기서도 한 번 더 보장한다.)
const NEW_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "level_test_date",     ddl: "TIMESTAMP" },
  { name: "level_test_score",    ddl: "TEXT" },
  { name: "level_test_notes",    ddl: "TEXT" },
  { name: "recommended_class_id", ddl: "VARCHAR REFERENCES classes(id) ON DELETE SET NULL" },
];

async function ensureEnumValue(value: string): Promise<boolean> {
  const existing = await pool.query(
    `SELECT 1
       FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'consultation_status'
        AND e.enumlabel = $1`,
    [value],
  );
  if (existing.rowCount && existing.rowCount > 0) return false;

  // ALTER TYPE ... ADD VALUE는 트랜잭션 안에서 실행할 수 없다.
  // pool.query는 자동 커밋 모드로 개별 SQL을 실행하므로 OK.
  await pool.query(`ALTER TYPE consultation_status ADD VALUE IF NOT EXISTS '${value}'`);
  return true;
}

async function ensureColumn(column: { name: string; ddl: string }): Promise<boolean> {
  const existing = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'consultations' AND column_name = $1`,
    [column.name],
  );
  if (existing.rowCount && existing.rowCount > 0) return false;

  await pool.query(
    `ALTER TABLE consultations ADD COLUMN IF NOT EXISTS "${column.name}" ${column.ddl}`,
  );
  return true;
}

async function main() {
  console.log("▶ 상담 레벨테스트 마이그레이션 시작");

  let addedValues = 0;
  for (const v of NEW_STATUS_VALUES) {
    const added = await ensureEnumValue(v);
    console.log(`  enum "${v}": ${added ? "추가됨" : "이미 존재"}`);
    if (added) addedValues++;
  }

  let addedColumns = 0;
  for (const c of NEW_COLUMNS) {
    const added = await ensureColumn(c);
    console.log(`  column "${c.name}": ${added ? "추가됨" : "이미 존재"}`);
    if (added) addedColumns++;
  }

  console.log(`✔ 완료 — enum ${addedValues}개, column ${addedColumns}개 새로 추가`);
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ 마이그레이션 실패:", err);
  await pool.end();
  process.exit(1);
});
