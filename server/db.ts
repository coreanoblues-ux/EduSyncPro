import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from "@shared/schema";

// ─── DATABASE_URL check ────────────────────────────────────────────────────
// Do NOT crash on startup if DATABASE_URL is missing.  Log a clear warning
// instead.  DB calls will fail at query time with a meaningful error message
// rather than crashing the entire process on startup.
if (!process.env.DATABASE_URL) {
  console.error(
    '❌ DATABASE_URL is not set! DB queries will fail. ' +
    'Set DATABASE_URL in Railway → Variables.'
  );
}

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://localhost/placeholder_will_fail',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // 연결 안정성 설정
  max: 10,                  // 최대 연결 수
  idleTimeoutMillis: 30000, // 30초 idle 후 연결 종료
  connectionTimeoutMillis: 10000, // 10초 연결 타임아웃
});

// 연결 오류 핸들링 (프로세스 crash 방지) — IMPORTANT: must NOT re-throw
pool.on('error', (err) => {
  console.error('❌ DB pool unexpected error (connection will be retried):', err.message);
});

export const db = drizzle(pool, { schema });

// ─── Startup DB connectivity test ─────────────────────────────────────────
// Run a trivial query so the Railway log immediately shows whether the DB
// is reachable.  Failure is logged but does NOT crash the process.
if (process.env.DATABASE_URL) {
  pool.query('SELECT 1')
    .then(() => console.log('✅ Database connection verified'))
    .catch((err: Error) => {
      console.error('❌ Database connection test FAILED:', err.message);
      console.error('   → Check DATABASE_URL in Railway Variables and ensure the DB allows Railway connections.');
    });
}
