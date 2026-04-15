import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // 연결 안정성 설정
  max: 10,                  // 최대 연결 수
  idleTimeoutMillis: 30000, // 30초 idle 후 연결 종료
  connectionTimeoutMillis: 10000, // 10초 연결 타임아웃
});

// 연결 오류 핸들링 (프로세스 crash 방지)
pool.on('error', (err) => {
  console.error('DB pool error:', err.message);
});

export const db = drizzle(pool, { schema });
