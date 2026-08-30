/**
 * payments.created_by 에 넣을 수 있는 "실존하는" users.id 를 고른다.
 *
 * ── 왜 이 파일이 생겼나 (2026-08-29, 장부 반영 500 의 진짜 원인) ──
 *   원장이 [장부에 반영]을 누르면 500 이 떴다. 화면에는 "대사 처리 중 오류가
 *   발생했습니다" 한 줄뿐이라 원인이 안 보였다. 원인은 이것이다:
 *
 *     payments.created_by 는 VARCHAR NOT NULL REFERENCES users(id) 다.
 *     그런데 superadmin 계정은 users 테이블에 행이 없다. 로그인 미들웨어가
 *     일부러 DB 조회를 건너뛰고 id 를 문자열 "admin" 으로 박아 넣는다
 *     (server/middleware/auth.ts 의 "superadmin special case").
 *
 *   즉 superadmin 으로 로그인한 상태에서 장부에 무언가를 적으려 하면
 *   created_by = "admin" 이 되고, users 에 그런 id 가 없으니 외래키 위반
 *   (Postgres 23503) 이 나면서 트랜잭션이 통째로 죽는다. 269,000원과 1,000원이
 *   장부에 못 들어간 이유가 정확히 이것이다.
 *
 *   결제 승인 경로(payments.ts)는 이 함정을 이미 알고 피해 갔다 — 거기 주석에
 *   "createdBy는 시스템 결제라 필요하지만 users.id를 요구하는 FK가 있어 문제가
 *   된다" 고 적혀 있고 시스템 사용자를 만들어 썼다. 그런데 나중에 만든 환불·
 *   수기 대사 경로에서는 그 교훈을 안 옮겨 왔다. 같은 함정에 두 번 빠졌다.
 *
 * ── 왜 "superadmin 은 못 쓰게" 막지 않았나 ──
 *   그게 제일 쉬운 수정이지만 원장이 실제로 쓰는 계정을 막아 버릴 수 있다.
 *   돈을 되찾는 기능을 로그인 방식 때문에 못 쓰게 되는 건 고친 게 아니다.
 *   대신 장부에는 실존 사용자를 적고, "실제로 누른 사람"은 notes 에 남긴다.
 *   감사 기록은 오히려 더 정확해진다 — 이전에는 아예 기록 자체가 없었다.
 */

import { sql } from "drizzle-orm";

/** 로그인한 사람의 신원 중 이 모듈이 쓰는 부분만. */
export interface LedgerActor {
  id: string;
  email?: string | null;
  name?: string | null;
  role?: string | null;
}

export interface LedgerUserResolution {
  /** payments.created_by 에 넣어도 안전한, 실존하는 users.id */
  userId: string;
  /** 로그인한 사람 대신 시스템 사용자로 대체했는가 */
  substituted: boolean;
  /**
   * 실제로 누른 사람을 사람이 읽을 수 있게 적은 한 줄.
   * substituted 가 true 일 때 notes 에 반드시 덧붙인다. 안 그러면
   * "누가 이 돈을 장부에 넣었는가"가 영영 사라진다.
   */
  actorLabel: string;
}

/** 감사 기록용 한 줄. 이메일이 있으면 이메일이 제일 유용하다. */
export function describeActor(actor: LedgerActor): string {
  const who = actor.email || actor.name || actor.id || "unknown";
  return actor.role ? `${who}(${actor.role})` : who;
}

/**
 * 이 테넌트의 시스템 사용자. 없으면 만든다.
 *
 * is_active=false 라 로그인에 쓸 수 없다. 비밀번호 자리에 넣는 'x' 는 어떤
 * 해시와도 일치하지 않으므로 인증을 통과할 수 없다. 장부의 외래키를 만족시키는
 * 것만이 이 행의 용도다.
 */
export async function getOrCreateSystemUserId(tx: any, tenantId: string): Promise<string> {
  const email = `system+toss-front@${tenantId}.local`;
  const existing = await tx.execute(sql`
    SELECT id FROM users WHERE email = ${email} LIMIT 1
  `);
  const found = (existing.rows as any[])[0];
  if (found) return found.id;

  const created = await tx.execute(sql`
    INSERT INTO users (email, password, name, role, tenant_id, is_active)
    VALUES (${email}, 'x', 'Toss Front (system)', 'owner', ${tenantId}, false)
    RETURNING id
  `);
  return (created.rows as any[])[0].id;
}

/**
 * 장부에 적을 created_by 를 정한다.
 *
 * 순서:
 *   1. 로그인한 사람이 users 에 실존하면 그 id 를 쓴다 (제일 정확한 감사 기록).
 *   2. 없으면 시스템 사용자로 대체하고 substituted=true 를 돌려준다.
 *      호출한 쪽은 actorLabel 을 notes 에 반드시 덧붙여야 한다.
 *
 * 1번을 id 존재 확인으로 하는 이유:
 *   superadmin 의 "admin" 뿐 아니라, 계정이 지워졌는데 토큰이 아직 살아 있는
 *   경우도 같은 FK 위반을 낸다. 역할 이름으로 분기하면 그 경우를 놓친다.
 *   "그 행이 실제로 있는가" 만이 FK 가 보는 유일한 사실이다.
 */
export async function resolveLedgerUserId(
  tx: any,
  tenantId: string,
  actor: LedgerActor
): Promise<LedgerUserResolution> {
  const actorLabel = describeActor(actor);

  if (actor.id) {
    const hit = await tx.execute(sql`SELECT id FROM users WHERE id = ${actor.id} LIMIT 1`);
    const row = (hit.rows as any[])[0];
    if (row) return { userId: row.id, substituted: false, actorLabel };
  }

  const systemUserId = await getOrCreateSystemUserId(tx, tenantId);
  return { userId: systemUserId, substituted: true, actorLabel };
}
