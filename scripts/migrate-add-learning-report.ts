/**
 * 학부모 학습 리포트 테이블 14개를 만든다
 * (2026-11-08 vocab_scores, student_clinic_levels · clinic_days · clinic_scores 추가).
 *
 * 실행: npx tsx scripts/migrate-add-learning-report.ts
 *       (= npm run db:migrate:learning-report)
 *
 * 설계와 "왜" 는 docs/PARENT_REPORT_PLAN.md §3.
 *
 * ── 왜 drizzle-kit push 가 아니라 이 스크립트인가 ──
 *   push 는 복합 유니크(반 × 주, 숙제 × 학생 …)와 부분 유니크(학생당 살아 있는 링크 하나)를
 *   표현하지 못한다. 그리고 이 저장소에서는 칼럼·테이블 추가를 push 에 맡기지 않는다
 *   (railway.toml 주석 5 — tenants.share_phone 사고).
 *
 * ── 안전성 ──
 *   · 여러 번 실행해도 안전하다 (CREATE … IF NOT EXISTS).
 *   · 새 테이블만 만든다. **기존 테이블은 ALTER 하지 않는다.** 기존 데이터를 읽지도 바꾸지도 않는다.
 *
 * ── 순서 ──
 *   외래키가 가리키는 쪽을 먼저 만든다: report_weeks → homework_items → homework_checks
 *   → exams → exam_scores → makeup_sessions → makeup_students → note_photos → note_photo_files
 *   → parent_links. 그 뒤에 유니크·조회 인덱스.
 */

import "dotenv/config";
import { Pool } from "pg";

// SSL 은 접속 주소로 정한다 (scripts/migrate-add-projects.ts 와 같은 이유).
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(process.env.DATABASE_URL ?? "");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

/** shared/schema.ts 의 정의와 반드시 같아야 한다. */
const STATEMENTS: [string, string][] = [
  [
    "report_weeks 테이블",
    `CREATE TABLE IF NOT EXISTS report_weeks (
       id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id     VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       class_id      VARCHAR NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
       week_start    TEXT NOT NULL,
       textbook      TEXT,
       unit          TEXT,
       topic         TEXT,
       progress_pct  INTEGER,
       published_at  TIMESTAMP,
       published_by  VARCHAR REFERENCES users(id),
       created_by    VARCHAR NOT NULL REFERENCES users(id),
       created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "homework_items 테이블",
    `CREATE TABLE IF NOT EXISTS homework_items (
       id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id       VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       report_week_id  VARCHAR NOT NULL REFERENCES report_weeks(id) ON DELETE CASCADE,
       title           TEXT NOT NULL,
       total_count     INTEGER,
       count_unit      TEXT,
       due_date        TEXT,
       sort_order      INTEGER NOT NULL DEFAULT 0,
       created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "homework_checks 테이블",
    `CREATE TABLE IF NOT EXISTS homework_checks (
       id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id         VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       homework_item_id  VARCHAR NOT NULL REFERENCES homework_items(id) ON DELETE CASCADE,
       student_id        VARCHAR NOT NULL REFERENCES students(id) ON DELETE CASCADE,
       status            TEXT NOT NULL DEFAULT 'pending',
       done_count        INTEGER,
       updated_by        VARCHAR REFERENCES users(id),
       updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "exams 테이블",
    `CREATE TABLE IF NOT EXISTS exams (
       id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id       VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       class_id        VARCHAR NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
       report_week_id  VARCHAR NOT NULL REFERENCES report_weeks(id) ON DELETE CASCADE,
       name            TEXT NOT NULL,
       kind            TEXT NOT NULL DEFAULT 'weekly',
       exam_date       TEXT NOT NULL,
       pass_score      INTEGER,
       areas           JSONB NOT NULL,
       retest_of       VARCHAR,
       created_by      VARCHAR NOT NULL REFERENCES users(id),
       created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "exam_scores 테이블",
    `CREATE TABLE IF NOT EXISTS exam_scores (
       id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id    VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       exam_id      VARCHAR NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
       student_id   VARCHAR NOT NULL REFERENCES students(id) ON DELETE CASCADE,
       area_scores  JSONB NOT NULL,
       total        INTEGER,
       absent       BOOLEAN NOT NULL DEFAULT false,
       comment      TEXT,
       updated_by   VARCHAR REFERENCES users(id),
       updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "makeup_sessions 테이블",
    `CREATE TABLE IF NOT EXISTS makeup_sessions (
       id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       class_id    VARCHAR REFERENCES classes(id) ON DELETE SET NULL,
       date        TEXT NOT NULL,
       start_time  TEXT,
       minutes     INTEGER,
       reason      TEXT NOT NULL DEFAULT 'other',
       content     TEXT NOT NULL,
       exam_id     VARCHAR REFERENCES exams(id) ON DELETE SET NULL,
       created_by  VARCHAR NOT NULL REFERENCES users(id),
       created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "makeup_students 테이블",
    `CREATE TABLE IF NOT EXISTS makeup_students (
       id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       makeup_id   VARCHAR NOT NULL REFERENCES makeup_sessions(id) ON DELETE CASCADE,
       student_id  VARCHAR NOT NULL REFERENCES students(id) ON DELETE CASCADE,
       status      TEXT NOT NULL DEFAULT 'scheduled',
       updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "note_photos 테이블",
    `CREATE TABLE IF NOT EXISTS note_photos (
       id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id       VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       report_week_id  VARCHAR NOT NULL REFERENCES report_weeks(id) ON DELETE CASCADE,
       student_id      VARCHAR REFERENCES students(id) ON DELETE CASCADE,
       title           TEXT NOT NULL,
       taken_date      TEXT NOT NULL,
       width           INTEGER,
       height          INTEGER,
       bytes           INTEGER,
       purged_at       TIMESTAMP,
       created_by      VARCHAR NOT NULL REFERENCES users(id),
       created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "note_photo_files 테이블",
    `CREATE TABLE IF NOT EXISTS note_photo_files (
       photo_id  VARCHAR PRIMARY KEY REFERENCES note_photos(id) ON DELETE CASCADE,
       mime      TEXT NOT NULL,
       data      BYTEA NOT NULL
     )`,
  ],
  [
    "parent_links 테이블",
    `CREATE TABLE IF NOT EXISTS parent_links (
       id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id        VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       student_id       VARCHAR NOT NULL REFERENCES students(id) ON DELETE CASCADE,
       token            TEXT NOT NULL,
       revoked_at       TIMESTAMP,
       failed_attempts  INTEGER NOT NULL DEFAULT 0,
       locked_until     TIMESTAMP,
       last_viewed_at   TIMESTAMP,
       view_count       INTEGER NOT NULL DEFAULT 0,
       created_by       VARCHAR NOT NULL REFERENCES users(id),
       created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],

  // 2026-11-08 추가: 단어시험(매 수업). 기존 테이블은 여전히 건드리지 않는다.
  [
    "vocab_scores 테이블",
    `CREATE TABLE IF NOT EXISTS vocab_scores (
       id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id       VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       report_week_id  VARCHAR NOT NULL REFERENCES report_weeks(id) ON DELETE CASCADE,
       class_id        VARCHAR NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
       student_id      VARCHAR NOT NULL REFERENCES students(id) ON DELETE CASCADE,
       test_date       TEXT NOT NULL,
       total           INTEGER NOT NULL,
       wrong           INTEGER NOT NULL,
       retest_passed   BOOLEAN,
       updated_by      VARCHAR REFERENCES users(id),
       updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],

  // 2026-11-08 추가: 주간 클리닉(단계별 주간 시험). 반이 섞이므로 학생 단위.
  [
    "student_clinic_levels 테이블",
    `CREATE TABLE IF NOT EXISTS student_clinic_levels (
       id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id   VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       student_id  VARCHAR NOT NULL REFERENCES students(id) ON DELETE CASCADE,
       level       TEXT NOT NULL,
       updated_by  VARCHAR REFERENCES users(id),
       updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "clinic_days 테이블",
    `CREATE TABLE IF NOT EXISTS clinic_days (
       id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id     VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       date          TEXT NOT NULL,
       papers        JSONB NOT NULL DEFAULT '{}'::jsonb,
       published_at  TIMESTAMP,
       published_by  VARCHAR REFERENCES users(id),
       created_by    VARCHAR NOT NULL REFERENCES users(id),
       created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],
  [
    "clinic_scores 테이블",
    `CREATE TABLE IF NOT EXISTS clinic_scores (
       id             VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id      VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       clinic_day_id  VARCHAR NOT NULL REFERENCES clinic_days(id) ON DELETE CASCADE,
       student_id     VARCHAR NOT NULL REFERENCES students(id) ON DELETE CASCADE,
       level          TEXT NOT NULL,
       score          INTEGER,
       correct        INTEGER,
       total          INTEGER,
       review_done    BOOLEAN NOT NULL DEFAULT false,
       updated_by     VARCHAR REFERENCES users(id),
       updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  ],

  // ── 유니크: 같은 것이 두 번 생기는 것을 DB 가 막는다 (화면이 두 번 눌려도) ──
  ["학생당 클리닉 단계 하나", `CREATE UNIQUE INDEX IF NOT EXISTS student_clinic_levels_student_uniq ON student_clinic_levels (student_id)`],
  ["학원 × 날짜 클리닉 하루", `CREATE UNIQUE INDEX IF NOT EXISTS clinic_days_tenant_date_uniq ON clinic_days (tenant_id, date)`],
  ["클리닉 날 × 학생 점수 하나", `CREATE UNIQUE INDEX IF NOT EXISTS clinic_scores_day_student_uniq ON clinic_scores (clinic_day_id, student_id)`],
  ["반 × 학생 × 날짜 단어시험 유니크", `CREATE UNIQUE INDEX IF NOT EXISTS vocab_scores_class_student_date_uniq ON vocab_scores (class_id, student_id, test_date)`],
  ["반 × 주 유니크", `CREATE UNIQUE INDEX IF NOT EXISTS report_weeks_class_week_uniq ON report_weeks (class_id, week_start)`],
  ["숙제 × 학생 유니크", `CREATE UNIQUE INDEX IF NOT EXISTS homework_checks_item_student_uniq ON homework_checks (homework_item_id, student_id)`],
  ["시험 × 학생 유니크", `CREATE UNIQUE INDEX IF NOT EXISTS exam_scores_exam_student_uniq ON exam_scores (exam_id, student_id)`],
  ["보강 × 학생 유니크", `CREATE UNIQUE INDEX IF NOT EXISTS makeup_students_makeup_student_uniq ON makeup_students (makeup_id, student_id)`],
  // 부모님이 링크를 누를 때마다 이 인덱스로 찾는다. 없으면 전체 테이블을 훑는다.
  ["링크 토큰 유니크", `CREATE UNIQUE INDEX IF NOT EXISTS parent_links_token_uniq ON parent_links (token)`],
  // 학생당 살아 있는 링크는 하나. 재발급은 기존 행에 revoked_at 을 찍고 새 행을 만든다.
  [
    "학생당 살아 있는 링크 하나",
    `CREATE UNIQUE INDEX IF NOT EXISTS parent_links_student_active_uniq ON parent_links (student_id) WHERE revoked_at IS NULL`,
  ],

  // ── 조회 경로에 맞춘 인덱스 ──
  ["report_weeks 조회", `CREATE INDEX IF NOT EXISTS report_weeks_tenant_week_idx ON report_weeks (tenant_id, week_start)`],
  ["homework_items 조회", `CREATE INDEX IF NOT EXISTS homework_items_week_idx ON homework_items (report_week_id)`],
  ["homework_checks 학생별", `CREATE INDEX IF NOT EXISTS homework_checks_student_idx ON homework_checks (student_id)`],
  ["exams 주별", `CREATE INDEX IF NOT EXISTS exams_week_idx ON exams (report_week_id)`],
  ["exams 반·날짜", `CREATE INDEX IF NOT EXISTS exams_class_date_idx ON exams (class_id, exam_date)`],
  ["exam_scores 학생별", `CREATE INDEX IF NOT EXISTS exam_scores_student_idx ON exam_scores (student_id)`],
  ["makeup_sessions 날짜", `CREATE INDEX IF NOT EXISTS makeup_sessions_tenant_date_idx ON makeup_sessions (tenant_id, date)`],
  ["makeup_students 학생별", `CREATE INDEX IF NOT EXISTS makeup_students_student_idx ON makeup_students (student_id)`],
  ["note_photos 주별", `CREATE INDEX IF NOT EXISTS note_photos_week_idx ON note_photos (report_week_id)`],
  // 6개월 지난 사진 지우기가 하루 한 번 이 순서로 훑는다.
  ["note_photos 보관기간", `CREATE INDEX IF NOT EXISTS note_photos_taken_idx ON note_photos (taken_date) WHERE purged_at IS NULL`],
  ["parent_links 학생별", `CREATE INDEX IF NOT EXISTS parent_links_student_idx ON parent_links (student_id)`],
  ["vocab_scores 주별", `CREATE INDEX IF NOT EXISTS vocab_scores_week_idx ON vocab_scores (report_week_id)`],
  // 학생별 "지난번 총 문항" 을 기본값으로 꺼낼 때 탄다.
  ["vocab_scores 학생·날짜", `CREATE INDEX IF NOT EXISTS vocab_scores_student_date_idx ON vocab_scores (student_id, test_date DESC)`],
  // 부모님 화면이 "이 학생의 최근 클리닉 5회" 를 꺼낼 때 탄다.
  ["clinic_scores 학생별", `CREATE INDEX IF NOT EXISTS clinic_scores_student_idx ON clinic_scores (student_id)`],
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
