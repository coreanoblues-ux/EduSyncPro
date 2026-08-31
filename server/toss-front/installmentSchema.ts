/**
 * 할부 요청 칸(payment_intents.requested_installment)을 서버가 부팅할 때 스스로 만든다.
 *
 * ── 왜 스크립트가 아니라 부팅 때인가 ──
 *   cardCancelSchema.ts 헤더에 적힌 그대로다. 운영 DB 는 Railway 안에 있고 개발 PC 의
 *   .env 는 localhost 를 가리킨다. scripts/migrate-add-installment.ts 를 아무리 돌려도
 *   운영에는 닿지 않는다. 실제로 payment-idempotency 마이그레이션이 "나중에 손으로"
 *   로 남았다가 몇 주째 안 돌아간 적이 있다.
 *
 * ── 이번엔 그냥 잊고 넘어갈 수 없는 이유 ──
 *   dispatch.ts 가 결제요청을 만들 때 이 컬럼에 값을 넣는다. 컬럼이 없으면 INSERT 가
 *   통째로 실패하고 **카드결제 자체가 안 된다**. 다른 마이그레이션은 빠뜨려도 새 기능만
 *   못 쓰는 정도였지만, 이건 빠뜨리면 멀쩡히 돌던 수납이 멈춘다. 사람이 기억해야 하는
 *   절차로 남겨 둘 수 없다.
 *
 * ── 안전 장치 ──
 *   1. ADD COLUMN IF NOT EXISTS — 여러 번 돌아도 같은 결과다.
 *   2. 어드바이저리 잠금 — 인스턴스가 둘 이상 동시에 떠도 한 줄로 세운다.
 *   3. 전제 테이블이 없으면 아무것도 하지 않는다.
 *   4. 실패해도 서버를 죽이지 않는다.
 *
 * ── 이 파일에 넣지 말아야 할 것 ──
 *   NULL 허용 컬럼 추가 말고는 아무것도. UPDATE·DROP·RENAME·타입 변경 금지.
 *   기존 행은 전부 NULL 로 남는다. NULL 은 "일시불로 요청했다" 가 아니라
 *   "요청 정보가 없다" 는 뜻이고, 읽는 쪽에서 0(일시불)으로 해석한다. 그 둘은
 *   다른 사실이라서 DB 에서는 구분해 둔다.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";

/** 이 마이그레이션 전용 잠금 번호. cardCancelSchema(8140231) 와 겹치지 않는 고정값. */
const LOCK_KEY = 8_140_232;

export async function ensureInstallmentSchema(): Promise<void> {
  try {
    const pre = await db.execute(sql`SELECT to_regclass('payment_intents') AS t`);
    if (!(pre as any).rows?.[0]?.t) {
      console.warn(
        "⚠️  할부 컬럼 준비를 건너뜁니다 — payment_intents 가 아직 없습니다. " +
          "기본 스키마가 만들어진 뒤 다음 부팅에서 다시 시도합니다."
      );
      return;
    }

    await db.execute(sql`SELECT pg_advisory_lock(${LOCK_KEY}::bigint)`);
    try {
      const before = await db.execute(sql`
        SELECT 1 AS t FROM information_schema.columns
         WHERE table_name = 'payment_intents'
           AND column_name = 'requested_installment'
      `);
      const existed = !!(before as any).rows?.[0]?.t;

      // NOT NULL DEFAULT 를 안 붙이는 이유는 위 헤더 참고 (모르는 것은 NULL).
      await db.execute(sql`
        ALTER TABLE payment_intents
          ADD COLUMN IF NOT EXISTS requested_installment INTEGER
      `);

      if (existed) {
        console.log("✅ 할부 컬럼 확인됨 (변경 없음)");
      } else {
        console.log(
          "✅ 할부 컬럼을 추가했습니다 (payment_intents.requested_installment). " +
            "기존 행은 한 줄도 바뀌지 않았습니다."
        );
      }
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${LOCK_KEY}::bigint)`);
    }
  } catch (err: any) {
    // 여기서 던지면 서버가 안 뜬다. 그건 어떤 경우에도 더 나쁘다.
    // 다만 이 실패는 카드결제를 멈추게 하므로 로그를 크게 남긴다.
    console.error(
      "❌ 할부 컬럼 준비 실패 — 카드결제 요청 생성이 실패할 수 있습니다. " +
        "즉시 확인이 필요합니다: " +
        (err?.message ?? err)
    );
  }
}
