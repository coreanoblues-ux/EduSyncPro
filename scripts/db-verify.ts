/**
 * DB 이관 전후 대조용 스크립트.
 *
 *   npm run db:verify                    # .env의 DATABASE_URL을 본다
 *   DATABASE_URL="postgres://..." npm run db:verify   # 특정 DB를 본다
 *
 * DB를 옮길 때 "잘 된 것 같다"는 느낌으로 넘어가면 나중에 결제 기록 몇 줄이
 * 조용히 비어 있는 걸 몇 달 뒤에 발견하게 된다. 옮기기 전 한 번, 옮긴 뒤 한 번
 * 돌려서 두 출력이 글자 그대로 같은지 확인하는 용도다.
 *
 * 건수뿐 아니라 금액 합계와 가장 최근 기록 시각까지 찍는다. 건수만 맞고
 * 내용이 깨진 경우를 잡기 위해서다.
 */

import "dotenv/config";
import pg from "pg";

const TABLES = [
  "tenants",
  "users",
  "teachers",
  "classes",
  "students",
  "enrollments",
  "payments",
  "consultations",
  "lesson_logs",
  "waiters",
  "tasks",
] as const;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ DATABASE_URL이 없습니다. .env에 넣거나 앞에 붙여서 실행하세요.");
    process.exit(1);
  }

  // 호스트만 찍는다. 연결 문자열에는 비밀번호가 들어 있어 통째로 로그에 남기면 안 된다.
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "(파싱 실패)";
    }
  })();
  console.log(`🗄️  대상 DB: ${host}`);
  console.log(`🕒 확인 시각: ${new Date().toISOString()}\n`);

  const pool = new pg.Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(host) ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  let missing = 0;
  console.log("테이블".padEnd(16) + "건수".padStart(10));
  console.log("-".repeat(26));

  for (const table of TABLES) {
    try {
      // 테이블 이름은 위 상수 배열에서만 오므로 문자열 결합이 안전하다.
      // (식별자는 파라미터 바인딩으로 넣을 수 없다.)
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
      console.log(table.padEnd(16) + String(rows[0].n).padStart(10));
    } catch (err: any) {
      missing++;
      console.log(table.padEnd(16) + "  없음/오류".padStart(10) + `  ← ${err.message}`);
    }
  }

  // 돈이 걸린 테이블은 합계까지 본다. 건수만 같고 금액이 0이 된 이관을 잡는다.
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS total,
              MAX(paid_date) AS last_paid
         FROM payments`
    );
    console.log(`\n💰 결제 금액 합계: ${Number(rows[0].total).toLocaleString("ko-KR")}원`);
    console.log(`🧾 마지막 결제일: ${rows[0].last_paid ?? "(없음)"}`);
  } catch (err: any) {
    console.log(`\n💰 결제 합계 확인 실패: ${err.message}`);
  }

  try {
    const { rows } = await pool.query(
      `SELECT (COUNT(*) FILTER (WHERE is_active))::int AS active,
              COUNT(*)::int AS total
         FROM students`
    );
    console.log(`👨‍🎓 학생: 전체 ${rows[0].total}명 (재원 ${rows[0].active}명)`);
  } catch (err: any) {
    console.log(`👨‍🎓 학생 확인 실패: ${err.message}`);
  }

  await pool.end();

  if (missing > 0) {
    console.log(`\n⚠️  ${missing}개 테이블을 읽지 못했습니다. 이관 직후라면 npm run db:push를 먼저 돌리세요.`);
    process.exit(1);
  }
  console.log("\n✅ 모든 테이블을 읽었습니다. 옮기기 전 출력과 한 줄씩 비교하세요.");
}

main().catch((err) => {
  console.error("❌ 실행 실패:", err.message);
  process.exit(1);
});
