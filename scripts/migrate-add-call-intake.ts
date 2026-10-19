/**
 * consultations 에 "통화 자동등록 확인 필요" 플래그를 더한다.
 *
 * 실행: npx tsx scripts/migrate-add-call-intake.ts
 *       (= npm run db:migrate:call-intake)
 *
 * ── 왜 drizzle-kit push 가 아니라 이 스크립트인가 ──
 *   push 는 스키마 전체를 비교해서 "지워야 할 것" 까지 제안한다. 이 DB 에는
 *   push 가 모르는 제약(결제 부분 유니크 등)이 여럿 있어 운영 DB 에 걸기
 *   위험하다. 칼럼 하나는 ADD COLUMN IF NOT EXISTS 한 줄이면 된다.
 *   (migrate-add-level-test-share.ts 와 같은 방식)
 *
 * ── 안전성 ──
 *   · 여러 번 실행해도 안전하다 (IF NOT EXISTS).
 *   · 기존 데이터를 지우거나 바꾸지 않는다. 기본값 FALSE 라서 기존 상담 건은
 *     전부 "확인 불필요" 상태 그대로다 — 통화 자동등록이 만든 건만 TRUE 로
 *     들어온다.
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

/** 칼럼 이름 → 타입. shared/schema.ts 의 consultations 와 반드시 같아야 한다. */
const COLUMNS: [string, string][] = [
  ["needs_review", "BOOLEAN NOT NULL DEFAULT FALSE"],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL 이 없습니다. Railway Variables 의 값을 환경변수로 넣고 실행하세요.");
    process.exit(1);
  }
  for (const [name, type] of COLUMNS) {
    await pool.query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    console.log(`✔ consultations.${name}`);
  }
  await pool.end();
  console.log("완료");
}

main().catch((e) => {
  console.error("마이그레이션 실패:", e);
  process.exit(1);
});
