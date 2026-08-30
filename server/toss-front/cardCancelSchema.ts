/**
 * 카드 취소 테이블을 서버가 부팅할 때 스스로 만든다.
 *
 * ── 왜 부팅 때 하는가 ──
 *   운영 DB 는 Railway 안에 있고, 개발 PC 의 .env 는 localhost 를 가리킨다.
 *   그래서 scripts/migrate-add-card-cancel.ts 를 아무리 돌려도 운영에는 닿지 않는다.
 *   실제로 payment-idempotency 마이그레이션이 "나중에 손으로 돌리기"로 남았다가
 *   몇 주째 안 돌아간 채로 있었다. 사람이 기억해야 하는 배포 절차는 언젠가 빠진다.
 *
 *   서버는 이미 DATABASE_URL 을 들고 운영 DB 에 붙어 있다. 붙어 있는 쪽이 하는 게 맞다.
 *
 * ── 안전 장치 ──
 *   1. 전부 IF NOT EXISTS — 여러 번 돌아도 같은 결과다.
 *   2. 어드바이저리 잠금 — 인스턴스가 둘 이상 동시에 뜨면 CREATE 가 겹친다.
 *      IF NOT EXISTS 도 완전한 동시성 방어는 아니라서(둘 다 "없음"을 보고 진입)
 *      잠금으로 한 줄로 세운다.
 *   3. 실패해도 절대 죽지 않는다. DDL 이 안 되는 것보다 서버가 안 뜨는 게 훨씬 나쁘다.
 *      결제는 이 테이블 없이도 멀쩡히 돌아간다.
 *   4. 기존 테이블을 건드리는 문장이 하나도 없다. 새로 만들기만 한다.
 *      ALTER 도 DROP 도 없다 — 이 파일에 그런 문장을 추가하지 말 것.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";

/** 이 마이그레이션 전용 잠금 번호. 다른 잠금과 겹치지 않게 고정값을 쓴다. */
const LOCK_KEY = 8_140_231;

export async function ensureCardCancelSchema(): Promise<void> {
  try {
    // 전제 테이블이 없으면 아무것도 하지 않는다. 엉뚱한 DB 에 반쪽짜리 스키마를
    // 만드는 것이 아무것도 안 하는 것보다 나쁘다.
    const pre = await db.execute(sql`
      SELECT to_regclass('payment_intents')     AS intents,
             to_regclass('toss_front_devices')  AS devices,
             to_regclass('tenants')             AS tenants,
             to_regclass('users')               AS users
    `);
    const row: any = (pre as any).rows?.[0] ?? {};
    if (!row.intents || !row.devices || !row.tenants || !row.users) {
      console.warn(
        "⚠️  카드취소 테이블 준비를 건너뜁니다 — 전제 테이블이 아직 없습니다. " +
          "기본 스키마가 만들어진 뒤 다음 부팅에서 다시 시도합니다."
      );
      return;
    }

    await db.execute(sql`SELECT pg_advisory_lock(${LOCK_KEY}::bigint)`);
    try {
      const before = await db.execute(
        sql`SELECT to_regclass('payment_cancel_dispatches') AS t`
      );
      const existed = !!(before as any).rows?.[0]?.t;

      await db.execute(sql`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_cancel_dispatch_status') THEN
            CREATE TYPE payment_cancel_dispatch_status AS ENUM (
              'PENDING', 'DELIVERED', 'SUCCEEDED', 'FAILED', 'TIMEOUT'
            );
          END IF;
        END $$;
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS payment_cancel_dispatches (
          id                     VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id              VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          payment_key            TEXT    NOT NULL,
          intent_id              VARCHAR NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
          toss_device_id         VARCHAR NOT NULL REFERENCES toss_front_devices(id) ON DELETE SET NULL,
          cancel_amount          INTEGER NOT NULL,
          ledger_amount          INTEGER NOT NULL,
          status                 payment_cancel_dispatch_status NOT NULL DEFAULT 'PENDING',
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

      // ★ 이중 취소를 DB 가 마지막으로 막는 인덱스.
      //   FAILED 만 빠진다 — 단말기가 "카드를 못 건드렸다"고 명시한 상태라서
      //   다시 걸어도 안전한 유일한 경우다. TIMEOUT 은 모르는 상태라 포함시킨다.
      await db.execute(sql`
        CREATE UNIQUE INDEX IF NOT EXISTS payment_cancel_dispatches_active_uniq
            ON payment_cancel_dispatches (payment_key)
         WHERE status <> 'FAILED'
      `);

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS payment_cancel_dispatches_device_status_idx
            ON payment_cancel_dispatches (toss_device_id, status, created_at)
      `);

      if (existed) {
        console.log("✅ 카드취소 테이블 확인됨 (변경 없음)");
      } else {
        console.log(
          "✅ 카드취소 테이블을 새로 만들었습니다 " +
            "(payment_cancel_dispatches + 이중취소 방어 인덱스)"
        );
      }
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${LOCK_KEY}::bigint)`);
    }
  } catch (err: any) {
    // 여기서 죽으면 안 된다. 이 테이블이 없어도 결제·장부는 전부 정상이고,
    // 카드취소 버튼만 오류를 낸다. 서버가 안 뜨는 쪽이 비교할 수 없이 나쁘다.
    console.error(
      "❌ 카드취소 테이블 준비 실패 (서버는 정상 기동합니다). " +
        "카드 취소 기능만 동작하지 않습니다: " +
        (err?.message ?? err)
    );
  }
}
