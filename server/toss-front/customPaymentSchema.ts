/**
 * 기타 결제(학생과 연결되지 않은 결제)를 받기 위한 스키마 준비.
 *
 * ── 무엇을 하는가 (셋뿐이다) ──
 *   1. payment_intents.student_id     NOT NULL 해제
 *   2. payment_intents.enrollment_id  NOT NULL 해제
 *   3. payment_intents.custom_label   TEXT 컬럼 추가 (NULL 허용)
 *
 * ── 왜 필요한가 ──
 *   원장 요청: "학원 웹앱에 학생으로 등록되지 않은 건(아직 등록 안 한 학생이든
 *   자료 판매든)도 태블릿에서 금액을 입력하고 결제 요청을 할 수 있어야 한다."
 *
 *   장부(payments)는 이미 이걸 받을 수 있었다. payments.enrollment_id 는
 *   처음부터 nullable 이고 주석에도 "학원 운영 지출은 연결할 등록이 없으므로
 *   nullable" 이라고 적혀 있다. type enum 에도 "기타" 가 이미 있다.
 *   막혀 있던 건 **결제 요청 단계(payment_intents)** 하나뿐이었다.
 *
 * ── NOT NULL 을 푸는 게 위험하지 않은가 ──
 *   제약을 푸는 건 넓히는 방향이라 기존 행·기존 코드에 영향이 없다. 확인한 것:
 *     · 기존 INSERT 는 dispatch.ts 와 payments.ts 두 곳뿐이고 둘 다 항상 값을 채운다.
 *     · 읽는 쪽은 전부 leftJoin 이다 (admin.ts 156·269, cardCancelRoutes.ts 139).
 *       원래부터 "학생 행이 없을 수도 있다" 는 전제로 쓰여 있었다.
 *     · 장부에 쓰는 두 곳(payments.ts confirm, admin.ts 환불, cardCancelRoutes 취소)은
 *       모두 payments.enrollment_id 로 넘기는데 그 칸이 이미 nullable 이다.
 *   실제로 스키마를 바꾸고 tsc 를 돌렸을 때 오류가 한 건도 없었다. 타입이
 *   `string` 에서 `string | null` 로 넓어졌는데 아무도 안 깨졌다는 건, 이 코드가
 *   원래부터 null 을 감당하도록 쓰여 있었다는 뜻이다.
 *
 *   되돌리는 것(다시 NOT NULL 을 거는 것)은 기타 결제 행이 하나라도 생기면
 *   불가능해진다. 그래서 이 변경은 사실상 한 방향이다 — 그만큼 위 근거를 먼저 확인했다.
 *
 * ── 하지 않는 것 ──
 *   기존 행 UPDATE 없음. 컬럼 삭제·이름변경·타입변경 없음. 인덱스 변경 없음.
 *
 * 부팅 때 도는 이유는 cardCancelSchema.ts 헤더와 같다 — 개발 PC 의 .env 는
 * localhost 라 운영 DB 에 닿지 않는다.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";

/** 전용 잠금 번호. cardCancel(8140231)·installment(8140232) 와 겹치지 않는 고정값. */
const LOCK_KEY = 8_140_233;

export async function ensureCustomPaymentSchema(): Promise<void> {
  try {
    const pre = await db.execute(sql`SELECT to_regclass('payment_intents') AS t`);
    if (!(pre as any).rows?.[0]?.t) {
      console.warn(
        "⚠️  기타 결제 스키마 준비를 건너뜁니다 — payment_intents 가 아직 없습니다."
      );
      return;
    }

    await db.execute(sql`SELECT pg_advisory_lock(${LOCK_KEY}::bigint)`);
    try {
      const before = await db.execute(sql`
        SELECT
          (SELECT is_nullable FROM information_schema.columns
            WHERE table_name = 'payment_intents' AND column_name = 'student_id')    AS student_nullable,
          (SELECT is_nullable FROM information_schema.columns
            WHERE table_name = 'payment_intents' AND column_name = 'enrollment_id') AS enrollment_nullable,
          (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'payment_intents' AND column_name = 'custom_label')  AS label_exists
      `);
      const row: any = (before as any).rows?.[0] ?? {};
      const alreadyDone =
        row.student_nullable === "YES" && row.enrollment_nullable === "YES" && !!row.label_exists;

      // 셋 다 여러 번 돌려도 같은 결과다. DROP NOT NULL 은 이미 풀려 있으면 무시된다.
      await db.execute(sql`ALTER TABLE payment_intents ALTER COLUMN student_id    DROP NOT NULL`);
      await db.execute(sql`ALTER TABLE payment_intents ALTER COLUMN enrollment_id DROP NOT NULL`);
      await db.execute(sql`
        ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS custom_label TEXT
      `);

      if (alreadyDone) {
        console.log("✅ 기타 결제 스키마 확인됨 (변경 없음)");
      } else {
        console.log(
          "✅ 기타 결제 스키마를 준비했습니다 " +
            "(payment_intents: student_id·enrollment_id NULL 허용, custom_label 추가). " +
            "기존 행은 한 줄도 바뀌지 않았습니다."
        );
      }
    } finally {
      await db.execute(sql`SELECT pg_advisory_unlock(${LOCK_KEY}::bigint)`);
    }
  } catch (err: any) {
    // 실패해도 서버는 뜬다. 이 경우 기타 결제만 안 되고 학생 결제는 예전 그대로다
    // (기존 INSERT 는 두 칸을 항상 채우므로 NOT NULL 이 남아 있어도 아무 문제 없다).
    console.error(
      "❌ 기타 결제 스키마 준비 실패 (서버는 정상 기동하며 학생 결제는 영향 없습니다). " +
        "기타 결제 기능만 동작하지 않습니다: " +
        (err?.message ?? err)
    );
  }
}
