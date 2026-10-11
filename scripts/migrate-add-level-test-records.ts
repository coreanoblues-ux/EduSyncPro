/**
 * 레벨테스트 결과지 기록 보관용 level_tests 테이블을 멱등하게 만든다.
 *
 * 실행: npx tsx scripts/migrate-add-level-test-records.ts
 *       (= npm run db:migrate:level-test-records)
 *
 * ── 이름이 비슷한 다른 스크립트와 혼동하지 말 것 ──
 *   scripts/migrate-add-level-test.ts (단수) 는 **상담 테이블**에 레벨테스트
 *   관련 칼럼과 상태값을 더하는 옛 스크립트다. 이 스크립트(복수, -records)는
 *   레벨테스트 앱이 회차별 결과지를 쌓는 **새 테이블**을 만든다. 둘 다 필요하고
 *   서로 건드리지 않는다.
 *
 * ── 왜 drizzle-kit push 에 맡기지 않는가 ──
 *   테이블 생성 자체는 push 가 해 준다. 하지만 아래 유니크 인덱스는
 *   (tenant_id, client_record_id) 복합이라 drizzle 스키마로 표현하면
 *   drizzle-kit 이 테넌트를 무시한 전역 유니크로 바꾸려 든다. 그러면 다른
 *   학원이 같은 기록 ID 를 쓰는 순간 저장이 거부된다. 그래서 제약은 이
 *   스크립트가 단독으로 소유한다 (payments 부분 유니크와 같은 방식).
 *
 * ── 이 유니크가 하는 일 ──
 *   레벨테스트 앱은 채점 중에도 몇 번이고 저장을 누른다. 그때마다 새 행이
 *   쌓이면 한 학생의 한 회차가 열 줄이 된다. 앱이 보내는 client_record_id
 *   (= 앱 내부 상담ID + ':' + 시험코드) 를 키로 삼아 **덮어쓰기(upsert)** 하게
 *   만들고, 그 upsert 가 DB 차원에서 보장되도록 인덱스를 둔다.
 *   엑셀 누적 저장이 하던 동작과 동일하다.
 *
 * 여러 번 실행해도 안전하다. 기존 데이터를 지우거나 바꾸지 않는다.
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const TABLE = "level_tests";
const INDEX_NAME = "level_tests_tenant_client_record_uniq";

/**
 * 테이블 정의.
 *
 * shared/schema.ts 의 levelTests 와 칼럼 이름·타입이 반드시 같아야 한다.
 * 한쪽만 바꾸면 런타임에 "column does not exist" 로 터진다.
 *
 * 외래키에 ON DELETE 를 명시하는 이유:
 *   · tenant → CASCADE: 학원이 삭제되면 그 학원 기록도 함께 사라져야 한다.
 *   · consultation / student → SET NULL: 상담 건이나 학생 행을 정리해도
 *     시험 기록 자체는 남아야 한다 (결과지 재출력 근거).
 *   · created_by → 제약 없음(NULL 허용): 직원이 퇴사해 계정이 지워져도
 *     기록은 남는다.
 */
const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    student_name     TEXT NOT NULL,
    school           TEXT,
    grade            TEXT,
    parent_phone     TEXT,

    consultation_id  VARCHAR REFERENCES consultations(id) ON DELETE SET NULL,
    student_id       VARCHAR REFERENCES students(id) ON DELETE SET NULL,

    test_date        TEXT NOT NULL,
    exam_code        TEXT NOT NULL,
    exam_title       TEXT NOT NULL,

    total_score      INTEGER,
    reading_score    INTEGER,
    grammar_score    INTEGER,
    vocab_score      INTEGER,
    writing_score    INTEGER,

    question_count   INTEGER,
    correct_count    INTEGER,
    pending_count    INTEGER,
    skipped_count    INTEGER,

    teacher_name     TEXT,
    notes            TEXT,
    raw_state        JSONB,

    client_record_id TEXT NOT NULL,

    created_by       VARCHAR REFERENCES users(id),
    created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

/** 목록 화면은 "최근 순"으로만 읽는다. 그 조회를 위한 보조 인덱스. */
const LIST_INDEX_NAME = "level_tests_tenant_date_idx";

async function tableExists(name: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return !!(r.rowCount && r.rowCount > 0);
}

async function indexExists(name: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [name]);
  return !!(r.rowCount && r.rowCount > 0);
}

async function main() {
  console.log("▶ 레벨테스트 기록 테이블 마이그레이션 시작");

  // 0) 선행 테이블 확인. 외래키가 가리키는 테이블이 없으면 CREATE 가 실패한다.
  //    먼저 확인해서 "왜 실패했는지"를 읽을 수 있게 한다.
  for (const dep of ["tenants", "consultations", "students", "users"]) {
    if (!(await tableExists(dep))) {
      throw new Error(
        `선행 테이블 "${dep}" 이 없습니다. 먼저 npm run db:push 를 실행하세요.`,
      );
    }
  }

  const had = await tableExists(TABLE);
  await pool.query(CREATE_TABLE_SQL);
  console.log(`  table "${TABLE}": ${had ? "이미 존재" : "생성됨"}`);

  // 1) upsert 키 유니크 인덱스.
  if (await indexExists(INDEX_NAME)) {
    console.log(`  index "${INDEX_NAME}": 이미 존재`);
  } else {
    // 혹시 이전 버전에서 중복이 쌓였다면 인덱스 생성이 실패한다.
    // 자동으로 지우지 않고 사람이 읽을 수 있게 보여 준 뒤 멈춘다.
    const dupes = await pool.query(`
      SELECT tenant_id, client_record_id, count(*) AS rows
        FROM ${TABLE}
       GROUP BY tenant_id, client_record_id
      HAVING count(*) > 1
       ORDER BY count(*) DESC
       LIMIT 50
    `);
    if (dupes.rowCount && dupes.rowCount > 0) {
      console.error(
        `\n❌ 같은 기록 ID 로 저장된 행이 ${dupes.rowCount}건 있습니다.\n` +
          `   유니크 인덱스를 만들기 전에 사람이 정리해야 합니다.\n`,
      );
      for (const r of dupes.rows) {
        console.error(`   · ${r.client_record_id} — ${r.rows}줄`);
      }
      console.error(
        `\n   확인용 SQL:\n` +
          `     SELECT id, student_name, exam_code, created_at FROM ${TABLE}\n` +
          `      WHERE client_record_id = '<기록ID>' ORDER BY created_at;\n`,
      );
      process.exitCode = 1;
      await pool.end();
      return;
    }

    await pool.query(
      `CREATE UNIQUE INDEX ${INDEX_NAME} ON ${TABLE} (tenant_id, client_record_id)`,
    );
    console.log(`  index "${INDEX_NAME}": 생성됨 (같은 회차 재저장 = 덮어쓰기)`);
  }

  // 2) 목록 조회용 보조 인덱스.
  if (await indexExists(LIST_INDEX_NAME)) {
    console.log(`  index "${LIST_INDEX_NAME}": 이미 존재`);
  } else {
    await pool.query(
      `CREATE INDEX ${LIST_INDEX_NAME} ON ${TABLE} (tenant_id, test_date DESC, created_at DESC)`,
    );
    console.log(`  index "${LIST_INDEX_NAME}": 생성됨`);
  }

  console.log("✔ 완료 — 레벨테스트 기록을 서버에 저장할 준비가 되었습니다.");
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ 마이그레이션 실패:", err);
  await pool.end();
  process.exit(1);
});
