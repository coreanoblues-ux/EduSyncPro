/**
 * tenants 에 "학부모 결과지에 찍히는 학원 전화번호" 칼럼을 더한다.
 *
 * 실행: npx tsx scripts/migrate-add-tenant-share-phone.ts
 *       (= npm run db:migrate:tenant-share-phone)
 *
 * ── 왜 이 스크립트가 따로 필요한가 (사고 기록) ──
 *   share_phone 은 NULL 을 허용하는 칼럼이라, 처음에는 railway.toml 안에 이미
 *   들어 있던 `drizzle-kit push` 가 알아서 더해 줄 것이라고 보고 전용
 *   마이그레이션을 만들지 않았다. **그 판단이 틀렸다.**
 *
 *   결과: 배포는 초록색으로 끝났는데 **로그인이 안 됐다.** 이유는 이렇다.
 *     1. shared/schema.ts 의 tenants 에 sharePhone 이 생겼다.
 *     2. Drizzle 은 `select * ` 가 아니라 **칼럼 이름을 하나하나 적어서**
 *        SELECT 를 만든다. 그래서 목록에 share_phone 이 들어간다.
 *     3. 로그인은 비밀번호 확인 뒤 storage.getTenant() 로 학원 정보를 읽는다.
 *     4. 실제 DB 에 칼럼이 없으니 거기서 터지고, 500 "로그인 중 오류" 가 된다.
 *   즉 **칼럼 하나가 비어 있으면 로그인 전체가 멈춘다.** 코드가 아무리 맞아도
 *   DB 가 안 따라오면 화면은 죽는다. 이 저장소에 칼럼 추가 스크립트가 종류별로
 *   쌓여 있는 이유가 바로 이것이고, 나는 그 선례를 따랐어야 했다.
 *
 *   (migrate-add-level-test-share.ts 머리말 참고: push 는 이 DB 가 모르는
 *    제약들 때문에 운영에 그대로 걸기 위험하다고 이미 적혀 있다.)
 *
 * ── 안전성 ──
 *   · 여러 번 실행해도 안전하다 (ADD COLUMN IF NOT EXISTS).
 *   · 기존 데이터를 지우거나 바꾸지 않는다. NULL 허용이라 기존 학원 행은
 *     그대로 NULL 이 되고, 결과지는 가입할 때 적은 번호로 돌아간다.
 *   · 학원 이름(name)은 처음부터 있던 칼럼이라 손대지 않는다.
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const TABLE = "tenants";

/** 칼럼 이름 → 타입. shared/schema.ts 의 tenants 와 반드시 같아야 한다. */
const COLUMNS: [string, string][] = [["share_phone", "TEXT"]];

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

async function main() {
  console.log("▶ 학원 전화번호(share_phone) 칼럼 마이그레이션 시작");

  if (!(await tableExists(TABLE))) {
    throw new Error(`"${TABLE}" 테이블이 없습니다. 기본 스키마가 먼저 올라가야 합니다.`);
  }

  for (const [name, type] of COLUMNS) {
    if (await columnExists(TABLE, name)) {
      console.log(`  column "${name}": 이미 존재`);
      continue;
    }
    await pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    console.log(`  column "${name}": 추가됨 (${type})`);
  }

  /*
    확인 한 줄 더 — 이 마이그레이션이 고치려는 사고가 "로그인 불가" 였으므로,
    로그인이 실제로 읽는 모양 그대로 한 번 읽어 본다. 여기서 터지면 배포가
    중단되고 옛 버전이 계속 서비스한다 (railway.toml preDeployCommand).
  */
  const check = await pool.query(
    `SELECT id, name, share_phone, owner_phone FROM ${TABLE} LIMIT 1`
  );
  console.log(`  로그인이 읽는 칼럼들 조회 확인: 정상 (${check.rowCount}행 샘플)`);

  console.log("✔ 완료 — 로그인과 학원 정보 저장이 정상 동작합니다.");
  await pool.end();
}

main().catch(async (err) => {
  console.error("❌ 마이그레이션 실패:", err);
  await pool.end();
  process.exit(1);
});
