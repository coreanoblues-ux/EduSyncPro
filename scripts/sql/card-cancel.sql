-- ═══════════════════════════════════════════════════════════════════════
-- 단말기 카드 취소 테이블 (운영 DB용)
--
-- 붙여넣을 곳: Railway → 프로젝트 → Postgres → Query 탭
--
-- scripts/migrate-add-card-cancel.ts 와 같은 것을 만든다. 그 스크립트는
-- DATABASE_URL 로 붙는데 원장님 PC 의 .env 는 localhost 를 가리켜서
-- 운영 DB 에 걸 수가 없다. 그래서 SQL 을 따로 둔다.
--
-- 기존 데이터를 지우거나 바꾸지 않는다. 새 테이블 하나를 만들 뿐이다.
-- 여러 번 실행해도 안전하다 (전부 IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- 1) 상태 enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_cancel_dispatch_status') THEN
    CREATE TYPE payment_cancel_dispatch_status AS ENUM (
      'PENDING', 'DELIVERED', 'SUCCEEDED', 'FAILED', 'TIMEOUT'
    );
  END IF;
END $$;

-- 2) 테이블
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
);

-- 3) ★ 이중 취소를 DB 가 마지막으로 막는 인덱스
--
--    결제는 중복 승인돼도 우리가 환불하면 된다. 취소는 중복되면 학부모 카드로
--    돈이 두 번 들어가고, 그걸 되돌릴 API 가 우리에게 없다 (Open API 시크릿 키가
--    없다). 비대칭이라서 애플리케이션 판정에만 맡기지 않는다.
--
--    FAILED 만 제외하는 이유:
--      FAILED  = 단말기가 "카드를 못 건드렸다"고 명시한 상태. 다시 걸어도 안전.
--      TIMEOUT = 응답이 없었을 뿐 카드는 취소됐을 수 있다. 모르는 상태다.
--                그래서 일부러 인덱스에 포함시켜 재시도를 DB 가 거부하게 한다.
CREATE UNIQUE INDEX IF NOT EXISTS payment_cancel_dispatches_active_uniq
    ON payment_cancel_dispatches (payment_key)
 WHERE status <> 'FAILED';

-- 4) 단말기별 대기 목록 조회용
CREATE INDEX IF NOT EXISTS payment_cancel_dispatches_device_status_idx
    ON payment_cancel_dispatches (toss_device_id, status, created_at);

COMMIT;

-- 확인용 — 아래가 1 을 반환하면 성공이다.
SELECT count(*) AS "테이블_생성됨"
  FROM information_schema.tables
 WHERE table_name = 'payment_cancel_dispatches';
