/**
 * 단말기 카드 취소 큐 테이블을 만든다.
 *
 * 실행: npx tsx scripts/migrate-add-card-cancel.ts
 *
 * ── 무엇을 만드는가 ──
 *   1) enum  payment_cancel_dispatch_status
 *   2) table payment_cancel_dispatches
 *   3) 부분 유니크 인덱스 payment_cancel_dispatches_active_uniq
 *        ON (payment_key) WHERE status <> 'FAILED'
 *   4) 조회용 인덱스 (단말기별 대기 목록)
 *
 * ── (3) 이 이 마이그레이션의 핵심이다 ──
 *   취소는 중복되면 되돌릴 방법이 없다. 학부모 카드로 돈이 두 번 들어가고,
 *   우리에게는 그걸 다시 뒤집을 API 가 없다 (Open API 시크릿 키가 없다).
 *
 *   결제 중복은 우리가 환불하면 되지만 취소 중복은 못 되돌린다. 비대칭이다.
 *   그래서 애플리케이션 판정(cardCancel.ts classifyCardCancel)에만 맡기지 않고
 *   DB 가 마지막으로 막게 한다.
 *
 *   FAILED 만 제외하는 이유:
 *     FAILED = 단말기가 "카드를 건드리지 못했다"고 명시적으로 알린 상태.
 *              이때만 다시 걸어도 안전하다.
 *     TIMEOUT = 응답이 없었을 뿐 카드는 취소됐을 수 있다. **모르는 상태다.**
 *              그래서 인덱스에 포함시켜 재시도를 DB 가 거부하게 만든다.
 *              푸는 것은 사람이 사장님 앱에서 실물을 확인한 뒤에 한다.
 *
 * 기존 데이터를 지우거나 바꾸지 않는다. 여러 번 실행해도 안전하다.
 * 기존 결제 흐름(payment_dispatches)은 전혀 건드리지 않는다.
 */

import "dotenv/config";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const ENUM_NAME = "payment_cancel_dispatch_status";
const TABLE_NAME = "payment_cancel_dispatches";
const ACTIVE_UNIQ = "payment_cancel_dispatches_active_uniq";
const DEVICE_IDX = "payment_cancel_dispatches_device_status_idx";

async function main() {
  const client = await pool.connect();
  const done: string[] = [];
  const skipped: string[] = [];

  try {
    // ── 1) enum ────────────────────────────────────────────────────────
    const enumExists = await client.query(`SELECT 1 FROM pg_type WHERE typname = $1`, [ENUM_NAME]);
    if (enumExists.rowCount) {
      skipped.push(`enum ${ENUM_NAME}`);
    } else {
      await client.query(`
        CREATE TYPE ${ENUM_NAME} AS ENUM (
          'PENDING', 'DELIVERED', 'SUCCEEDED', 'FAILED', 'TIMEOUT'
        )
      `);
      done.push(`enum ${ENUM_NAME}`);
    }

    // ── 2) table ───────────────────────────────────────────────────────
    // 전제 테이블이 없으면 여기서 멈춘다. 잘못된 DB 에 연결했을 가능성이 크고,
    // 그 상태로 CREATE 를 밀어붙이면 엉뚱한 곳에 반쪽짜리 스키마가 생긴다.
    for (const required of ["payment_intents", "toss_front_devices", "users", "tenants"]) {
      const t = await client.query(`SELECT to_regclass($1) AS oid`, [required]);
      if (!t.rows[0]?.oid) {
        console.error(
          `\n❌ 전제 테이블 '${required}' 이 없습니다. DATABASE_URL 이 올바른 DB 를 가리키는지 확인하세요.\n` +
            `   아무것도 만들지 않고 중단합니다.\n`
        );
        process.exitCode = 1;
        return;
      }
    }

    const tableExists = await client.query(`SELECT to_regclass($1) AS oid`, [TABLE_NAME]);
    if (tableExists.rows[0]?.oid) {
      skipped.push(`table ${TABLE_NAME}`);
    } else {
      await client.query(`
        CREATE TABLE ${TABLE_NAME} (
          id                     VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id              VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          payment_key            TEXT    NOT NULL,
          intent_id              VARCHAR NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
          toss_device_id         VARCHAR NOT NULL REFERENCES toss_front_devices(id) ON DELETE SET NULL,
          cancel_amount          INTEGER NOT NULL,
          ledger_amount          INTEGER NOT NULL,
          status                 ${ENUM_NAME} NOT NULL DEFAULT 'PENDING',
          requested_by           VARCHAR REFERENCES users(id) ON DELETE SET NULL,
          reason                 TEXT,
          delivered_at           TIMESTAMP,
          responded_at           TIMESTAMP,
          expires_at             TIMESTAMP NOT NULL,
          cancel_approval_number TEXT,
          cancel_tid             TEXT,
          failure_reason         TEXT,
          raw_response_json      TEXT,
          created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      done.push(`table ${TABLE_NAME}`);
    }

    // ── 3) 부분 유니크 인덱스 (중복 취소 방어) ──────────────────────────
    const uniqExists = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [
      ACTIVE_UNIQ,
    ]);
    if (uniqExists.rowCount) {
      skipped.push(`index ${ACTIVE_UNIQ}`);
    } else {
      // 새 테이블이라 중복이 있을 수 없지만, 재실행 상황을 위해 확인은 한다.
      const dupes = await client.query(`
        SELECT payment_key, count(*) AS n
          FROM ${TABLE_NAME}
         WHERE status <> 'FAILED'
         GROUP BY payment_key
        HAVING count(*) > 1
      `);
      if (dupes.rowCount) {
        console.error(
          `\n❌ 같은 결제키에 진행중/성공 취소가 여러 건 있습니다 (${dupes.rowCount}건).\n` +
            `   돈이 걸린 행이라 자동으로 지우지 않습니다. 사람이 확인해야 합니다.\n`
        );
        for (const r of dupes.rows) console.error(`   · ${r.payment_key} — ${r.n}건`);
        process.exitCode = 1;
        return;
      }

      await client.query(`
        CREATE UNIQUE INDEX ${ACTIVE_UNIQ}
            ON ${TABLE_NAME} (payment_key)
         WHERE status <> 'FAILED'
      `);
      done.push(`index ${ACTIVE_UNIQ} (중복 취소 방어)`);
    }

    // ── 4) 단말기별 대기 목록 조회 인덱스 ───────────────────────────────
    const devIdxExists = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [
      DEVICE_IDX,
    ]);
    if (devIdxExists.rowCount) {
      skipped.push(`index ${DEVICE_IDX}`);
    } else {
      await client.query(`
        CREATE INDEX ${DEVICE_IDX}
            ON ${TABLE_NAME} (toss_device_id, status, created_at)
      `);
      done.push(`index ${DEVICE_IDX}`);
    }

    // ── 결과 ───────────────────────────────────────────────────────────
    if (done.length === 0) {
      console.log("✅ 이미 모두 적용되어 있습니다 — 변경 없음");
    } else {
      console.log("✅ 생성 완료:");
      for (const d of done) console.log(`   + ${d}`);
    }
    if (skipped.length > 0) {
      console.log("↩️  이미 있어 건너뜀:");
      for (const s of skipped) console.log(`   · ${s}`);
    }
    console.log(
      "\n이 마이그레이션은 기존 결제 흐름(payment_dispatches)을 건드리지 않았습니다.\n" +
        "취소 기능은 아직 단말기에 연결되지 않았습니다 (2단계에서 연결)."
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("마이그레이션 실패:", err);
  process.exit(1);
});
