/**
 * 설명회·광고 프로젝트 3개 테이블과 tasks.project_id 한 칸을 더한다.
 *
 * 실행: npx tsx scripts/migrate-add-projects.ts
 *       (= npm run db:migrate:projects)
 *
 * ── 왜 drizzle-kit push 가 아니라 이 스크립트인가 ──
 *   push 는 스키마 전체를 비교해서 "지워야 할 것" 까지 제안한다. 이 DB 에는
 *   push 가 모르는 제약(결제 부분 유니크 등)이 여럿 있어 운영 DB 에 걸기 위험하다.
 *   그리고 과거 tenants.share_phone 한 칸을 push 에 맡겼다가 로그인이 통째로 죽었다
 *   (railway.toml 주석 5번). 이 저장소에서 칼럼 추가는 전용 스크립트가 맡는다.
 *
 * ── 안전성 ──
 *   · 여러 번 실행해도 안전하다 (IF NOT EXISTS / duplicate_object 무시).
 *   · 기존 데이터를 지우거나 바꾸지 않는다. tasks.project_id 는 NULL 허용이라
 *     지금까지 손으로 적은 할 일은 전부 그대로 NULL 이다.
 *
 * ── 순서 ──
 *   projects 를 먼저 만든다. tasks 의 외래키가 이 테이블을 가리키므로
 *   없는 상태에서 제약을 걸면 실패한다.
 */

import "dotenv/config";
import { Pool } from "pg";

/*
  SSL 은 NODE_ENV 가 아니라 **접속 주소**로 정한다.
  Neon 은 TLS 가 필수인데, 로컬에서 NODE_ENV=development 로 Neon 브랜치에 붙으면
  기존 스크립트들의 `NODE_ENV === "production"` 조건이 ssl:false 로 떨어져 연결이 막힌다.
  localhost 가 아니면 원격이고, 원격이면 TLS 다 — 이 편이 헷갈릴 구석이 없다.
*/
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(process.env.DATABASE_URL ?? "");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

/** shared/schema.ts 의 정의와 반드시 같아야 한다. */
const STATEMENTS: [string, string][] = [
  [
    "projects 테이블",
    `CREATE TABLE IF NOT EXISTS projects (
       id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       name        TEXT NOT NULL,
       kind        TEXT NOT NULL,
       d_day       TEXT NOT NULL,
       place       TEXT,
       partner     TEXT,
       budget      INTEGER,
       notes       TEXT,
       created_by  VARCHAR NOT NULL REFERENCES users(id),
       created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "project_templates 테이블",
    `CREATE TABLE IF NOT EXISTS project_templates (
       id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       kind        TEXT NOT NULL,
       name        TEXT NOT NULL,
       items       JSONB NOT NULL,
       created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "project_attendees 테이블",
    `CREATE TABLE IF NOT EXISTS project_attendees (
       id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id       VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       project_id      VARCHAR NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
       name            TEXT NOT NULL,
       phone           TEXT,
       notes           TEXT,
       consultation_id VARCHAR REFERENCES consultations(id) ON DELETE SET NULL,
       created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "tasks.project_id 칼럼",
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id VARCHAR`,
  ],
  [
    "tasks.project_id 외래키",
    // ADD CONSTRAINT 에는 IF NOT EXISTS 가 없다. 두 번째 실행에서 duplicate_object 가
    // 나는 것이 정상이므로 그것만 삼킨다.
    `DO $$ BEGIN
       ALTER TABLE tasks
         ADD CONSTRAINT tasks_project_id_fkey
         FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $$`,
  ],
  // 조회 경로에 맞춘 인덱스. 프로젝트 화면은 "이 프로젝트의 할 일"을 매번 긁는다.
  ["projects 인덱스", `CREATE INDEX IF NOT EXISTS projects_tenant_idx ON projects (tenant_id, d_day)`],
  ["project_templates 인덱스", `CREATE INDEX IF NOT EXISTS project_templates_tenant_idx ON project_templates (tenant_id, kind)`],
  ["project_attendees 인덱스", `CREATE INDEX IF NOT EXISTS project_attendees_project_idx ON project_attendees (project_id)`],
  ["tasks.project_id 인덱스", `CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id)`],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL 이 없습니다. Railway Variables 의 값을 환경변수로 넣고 실행하세요.");
    process.exit(1);
  }
  for (const [label, sql] of STATEMENTS) {
    await pool.query(sql);
    console.log(`✔ ${label}`);
  }
  await pool.end();
  console.log("완료");
}

main().catch((e) => {
  console.error("마이그레이션 실패:", e);
  process.exit(1);
});
