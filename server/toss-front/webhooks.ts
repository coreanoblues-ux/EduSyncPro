/**
 * Toss Open API v1 웹훅 수신.
 *
 * 스펙 (Toss 공식 Open API v1):
 *   HTTP 헤더:
 *     x-toss-timestamp   유닉스 밀리초. 서명 검증 message 의 앞쪽.
 *     x-toss-signature   base64(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))
 *     x-toss-webhook-id  전송 단위 식별자. 재전송 시 값이 같음 → 멱등 키.
 *   HTTP 본문(JSON):
 *     {
 *       "type": "payment.payment.approved.v1" | "payment.payment.cancelled.v1",
 *       "merchantId": "<mid>",
 *       "data": {
 *         "payment": {
 *           "id":          "<paymentKey>",
 *           "orderId":     "<orderId>",
 *           "state":       "APPROVED" | "CANCELED" | "...",
 *           "amount":      <int, 원 단위>,
 *           "approvedAt":  "<ISO>" | null,
 *           "cancelledAt": "<ISO>" | null
 *         }
 *       }
 *     }
 *
 * 처리:
 *   1. rawBody + x-toss-timestamp 로 HMAC-SHA256 검증
 *   2. tossWebhookEvents 에 원문 저장 (webhookId 유니크 → 재전송 자동 중복 방지)
 *   3. body.type 스위치:
 *        - payment.payment.approved.v1  → intent APPROVED, payments 삽입 (confirm 유실 보완)
 *        - payment.payment.cancelled.v1 → 전액 취소만 처리 (부분 취소는 v1 기본 스펙 밖으로 취급)
 *   4. 서명 실패 = 401, 처리 성공 = 200. 200 을 돌려주면 Toss 는 재발송을 중단한다.
 *
 * 왜 rawBody 인가:
 *   서명은 원문 문자열에 대해 계산되므로 JSON 파싱 후 재직렬화하면 값이 달라져 검증 실패.
 *   index.ts 의 express.json({ verify }) 에서 req.rawBody 를 채워 둔다.
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  tossWebhookEvents,
  paymentIntents,
  tossPaymentTransactions,
  payments,
} from "@shared/schema";
import { webhookCancelAmount } from "./refund";
import { getOrCreateSystemUserId } from "./ledgerUser";

const router = Router();

const WEBHOOK_SECRET = process.env.TOSS_WEBHOOK_SECRET || "";
if (!WEBHOOK_SECRET) {
  console.warn(
    "⚠️  TOSS_WEBHOOK_SECRET 미설정 — 웹훅 서명 검증이 모두 실패로 기록됩니다. 운영 전에 설정하세요."
  );
}

// ─── 서명 검증 ────────────────────────────────────────────────────────
function verifySignature(rawBody: string, timestamp: string, signature: string): boolean {
  if (!WEBHOOK_SECRET) return false;
  const message = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(message, "utf8")
    .digest("base64");
  // 길이 다르면 timingSafeEqual이 예외. Buffer 만든 뒤 사이즈 체크.
  const aBuf = Buffer.from(expected, "base64");
  const bBuf = Buffer.from(signature, "base64");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ─── 엔드포인트 ───────────────────────────────────────────────────────
router.post("/webhooks", async (req: Request, res: Response) => {
  const webhookId = (req.headers["x-toss-webhook-id"] as string) || "";
  const timestamp = (req.headers["x-toss-timestamp"] as string) || "";
  const signature = (req.headers["x-toss-signature"] as string) || "";
  // v1 이후 이벤트 타입은 body.type 이 진실의 원본. 헤더는 하위 호환용으로만 참조한다.
  const legacyHeaderEventType = (req.headers["x-toss-event-type"] as string) || "";
  const eventId = (req.headers["x-toss-event-id"] as string) || "";
  const deliveryId = (req.headers["x-toss-delivery-id"] as string) || "";
  const rawBody = (req as any).rawBody as string | undefined;

  if (!webhookId) {
    // webhookId 없으면 감사 저장도 불가. 400으로 명확히 거절.
    return res.status(400).json({ error: "x-toss-webhook-id 헤더가 필요합니다." });
  }
  if (!rawBody || !timestamp || !signature) {
    await insertOrIgnoreEvent(webhookId, {
      eventId,
      deliveryId,
      eventType: legacyHeaderEventType,
      signatureValid: false,
      status: "FAILED",
      payloadJson: rawBody ?? "",
      errorMessage: "missing required headers or body",
    });
    return res.status(400).json({ error: "필수 헤더 또는 본문이 없습니다." });
  }

  const signatureValid = verifySignature(rawBody, timestamp, signature);
  if (!signatureValid) {
    await insertOrIgnoreEvent(webhookId, {
      eventId,
      deliveryId,
      eventType: legacyHeaderEventType,
      signatureValid: false,
      status: "FAILED",
      payloadJson: rawBody,
      errorMessage: "signature mismatch",
    });
    // 서명 실패는 401로 알려 Toss가 재발송을 멈추게 한다 — 시크릿이 바뀐 상황일 수 있어
    // 계속 재시도하게 두면 로그 폭탄이 된다.
    return res.status(401).json({ error: "서명이 유효하지 않습니다." });
  }

  // JSON 파싱은 서명 검증 이후에 (서명 미검증 payload 를 파서에 흘리지 않기 위함)
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch (err: any) {
    await insertOrIgnoreEvent(webhookId, {
      eventId,
      deliveryId,
      eventType: legacyHeaderEventType,
      signatureValid: true,
      status: "FAILED",
      payloadJson: rawBody,
      errorMessage: "invalid json",
    });
    return res.status(400).json({ error: "본문이 JSON이 아닙니다." });
  }

  // v1 이벤트 타입은 body.type 이 원본. 헤더는 폴백.
  const eventType: string = typeof body?.type === "string" ? body.type : legacyHeaderEventType;

  // 이미 처리된 webhookId면 그대로 200 반환. Toss 재전송을 안전하게 삼킨다.
  const existing = await db
    .select({ status: tossWebhookEvents.status })
    .from(tossWebhookEvents)
    .where(eq(tossWebhookEvents.webhookId, webhookId))
    .limit(1);
  if (existing.length > 0 && existing[0].status === "PROCESSED") {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  // 원문 저장 (신규 or 이전 실패 재처리)
  await insertOrIgnoreEvent(webhookId, {
    eventId,
    deliveryId,
    eventType,
    signatureValid: true,
    status: "RECEIVED",
    payloadJson: rawBody,
    errorMessage: null,
  });

  // 재조정 수행
  try {
    await reconcile(eventType, body);
    await db
      .update(tossWebhookEvents)
      .set({ status: "PROCESSED", processedAt: new Date() })
      .where(eq(tossWebhookEvents.webhookId, webhookId));
    return res.status(200).json({ ok: true });
  } catch (err: any) {
    await db
      .update(tossWebhookEvents)
      .set({
        status: "FAILED",
        errorMessage: (err?.message ?? String(err)).slice(0, 500),
        processedAt: new Date(),
      })
      .where(eq(tossWebhookEvents.webhookId, webhookId));
    console.error("webhook reconcile error:", err);
    // 서버 오류일 수 있으므로 500. Toss가 재전송하면 위의 duplicate 분기에서 걸린다.
    return res.status(500).json({ error: "재조정 중 오류가 발생했습니다." });
  }
});

// ─── 재조정 ────────────────────────────────────────────────────────────
/**
 * Open API v1 payload 에서 payment 정보를 뽑아 재조정한다.
 *
 * v1 페이로드 예:
 *   { type, merchantId, data: { payment: { id, orderId, state, amount, approvedAt, cancelledAt } } }
 *
 * id 가 곧 paymentKey. state 는 서버 상태와 비교하기 위한 사후 검증 용도로만 참고.
 *
 * 이 함수는 idempotent 해야 한다. confirm 이 먼저 성공했으면 여기서는 아무 것도 안 한다.
 * 취소는 전액 취소만 처리 (부분 취소는 v1 기본 스펙에서 다루지 않는다).
 */
async function reconcile(eventType: string, body: any) {
  const payment = body?.data?.payment;
  const paymentKey: string | undefined =
    payment?.id ?? body?.paymentKey ?? body?.data?.paymentKey; // 마지막 두 개는 하위 호환
  if (!paymentKey) {
    // 결제와 무관한 이벤트(정책·가맹점 알림 등)는 조용히 무시.
    return;
  }

  await db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT * FROM payment_intents WHERE payment_key = ${paymentKey} FOR UPDATE
    `);
    const intent = (rows.rows as any[])[0];
    if (!intent) {
      // paymentKey를 우리 서버가 만들지 않은 건 — Toss 대시보드에서 직접 만든 결제거나
      // 다른 시스템의 것. 무시하되 로그는 남긴다.
      console.warn(`웹훅 payload의 paymentKey가 우리 intent에 없음: ${paymentKey}`);
      return;
    }

    const isApproved = eventType === "payment.payment.approved.v1";
    const isCanceled = eventType === "payment.payment.cancelled.v1";

    if (isApproved) {
      // 이미 confirm으로 처리됐으면 아무것도 안 함.
      if (intent.status === "APPROVED") return;

      // confirm이 오지 못한 상태 — 웹훅으로 확정한다.
      // v1 페이로드에는 카드 상세가 포함되지 않을 수 있으므로 최소 정보로 삽입.
      const approvedAtIso = payment?.approvedAt ?? new Date().toISOString();
      const [txRow] = await tx
        .insert(tossPaymentTransactions)
        .values({
          tenantId: intent.tenant_id,
          paymentKey,
          intentId: intent.id,
          paymentMethod: "CARD",
          approvalNumber: "WEBHOOK",
          approvedTimestamp: approvedAtIso,
          maskedCardNumber: null,
          issuerName: null,
          acquirerName: null,
          cardType: null,
          installment: 0,
          rawResponseJson: JSON.stringify({ source: "webhook.v1", body }),
        })
        .onConflictDoNothing({ target: tossPaymentTransactions.paymentKey })
        .returning();

      if (txRow) {
        // 시스템 사용자 확보
        const email = `system+toss-front@${intent.tenant_id}.local`;
        const userRows = await tx.execute(sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`);
        let systemUserId = (userRows.rows as any[])[0]?.id;
        if (!systemUserId) {
          const ins = await tx.execute(sql`
            INSERT INTO users (email, password, name, role, tenant_id, is_active)
            VALUES (${email}, 'x', 'Toss Front (system)', 'owner', ${intent.tenant_id}, false)
            RETURNING id
          `);
          systemUserId = (ins.rows as any[])[0].id;
        }

        await tx
          .insert(payments)
          .values({
            tenantId: intent.tenant_id,
            enrollmentId: intent.enrollment_id,
            amount: intent.amount,
            type: "원비",
            method: "카드",
            paymentMonth: intent.payment_month,
            paidDate: new Date(approvedAtIso),
            createdBy: systemUserId,
            notes: `Toss Front (webhook v1) · ${paymentKey}`,
            externalProvider: "TOSSPLACE",
            externalPaymentKey: paymentKey,
            externalTransactionId: txRow.id,
            paidVia: "TOSS_FRONT",
          });
      }

      await tx
        .update(paymentIntents)
        .set({ status: "APPROVED", approvedAt: new Date(approvedAtIso) })
        .where(eq(paymentIntents.id, intent.id));
      return;
    }

    if (isCanceled) {
      // v1 전액 취소만 처리.
      //
      // ⚠️ 예전에는 여기서 intent.amount 를 통째로 음수로 꽂았다. 그러면 원장이
      //    관리자 화면(/admin/refunds)에서 이미 환불을 기록한 뒤 취소 웹훅이 오는 순간
      //    같은 돈이 두 번 빠진다 — 27만원 결제가 -54만원이 된다. 사람과 웹훅은 서로
      //    다른 순서로 도착하므로 상태 플래그 하나로는 막을 수 없다.
      //
      //    그래서 금액을 intent 가 아니라 "실제 장부에 적힌 돈"에서 계산한다:
      //      실입금(양수 합) - 이미 환불(음수 합) = 아직 되돌릴 수 있는 금액
      //    이 값이 0 이하면 적을 게 없으므로 payments 삽입을 건너뛰고 상태만 마감한다.
      //    승인된 적 없는 건(실입금 0)도 자연히 0 이 되어 유령 환불이 생기지 않는다.
      const [ledger] = await tx
        .select({
          paidIn: sql<number>`coalesce(sum(${payments.amount}) FILTER (WHERE ${payments.amount} > 0), 0)::int`,
          refunded: sql<number>`coalesce(-sum(${payments.amount}) FILTER (WHERE ${payments.amount} < 0), 0)::int`,
        })
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, intent.tenant_id),
            eq(payments.externalPaymentKey, paymentKey)
          )
        );
      const cancelAmount = webhookCancelAmount(ledger?.paidIn ?? 0, ledger?.refunded ?? 0);
      const cancelledAtIso = payment?.cancelledAt ?? new Date().toISOString();

      // ⚠️ 예전에는 여기서 users 를 SELECT 만 하고, 없으면 조용히 넘어갔다.
      //    (조건이 `if (systemUserId && cancelAmount > 0)` 였고 else 는 금액이
      //    0 일 때만 로그를 남겼다.) 그래서 시스템 사용자가 아직 없는 테넌트에
      //    진짜 취소 웹훅이 오면 환불이 흔적도 없이 사라졌다. 돈이 빠져나갔는데
      //    장부에도 로그에도 없는, 가장 찾기 어려운 종류의 구멍이다.
      //
      //    승인 경로는 없으면 만들어 쓰고 있었다. 같은 헬퍼를 여기서도 쓴다.
      const systemUserId =
        cancelAmount > 0 ? await getOrCreateSystemUserId(tx, intent.tenant_id) : null;
      if (systemUserId && cancelAmount > 0) {
        await tx.insert(payments).values({
          tenantId: intent.tenant_id,
          enrollmentId: intent.enrollment_id,
          amount: -cancelAmount,
          type: "환불",
          method: "카드",
          paymentMonth: intent.payment_month,
          paidDate: new Date(cancelledAtIso),
          createdBy: systemUserId,
          notes: `Toss Front 취소 (webhook v1) · ${paymentKey}`,
          externalProvider: "TOSSPLACE",
          externalPaymentKey: paymentKey,
          paidVia: "TOSS_FRONT",
        });
      } else if (cancelAmount <= 0) {
        console.log(
          `ℹ️ 취소 웹훅 ${paymentKey}: 이미 환불이 기록되어 있어 장부에 추가로 적지 않습니다 (실입금 ${ledger?.paidIn ?? 0}원 · 환불 ${ledger?.refunded ?? 0}원).`
        );
      }

      await tx
        .update(paymentIntents)
        .set({ status: "CANCELED", cancelledAt: new Date(cancelledAtIso) })
        .where(eq(paymentIntents.id, intent.id));
      return;
    }

    // 그 외 이벤트(예: payment.payment.partial_cancelled.v1) 는 v1 기본 스펙 밖으로 취급.
    // 감사 로그에는 이미 저장되어 있으므로 여기서는 조용히 통과.
  });
}

async function insertOrIgnoreEvent(
  webhookId: string,
  fields: {
    eventId: string;
    deliveryId: string;
    eventType: string;
    signatureValid: boolean;
    status: "RECEIVED" | "PROCESSED" | "IGNORED" | "FAILED";
    payloadJson: string;
    errorMessage: string | null;
  }
) {
  // ON CONFLICT DO NOTHING — 재전송이면 이전 행이 그대로 유지되고 status 갱신은
  // 아래 처리 흐름에서 UPDATE로 수행한다.
  await db.execute(sql`
    INSERT INTO toss_webhook_events (
      webhook_id, event_id, delivery_id, event_type, signature_valid, status,
      payload_json, error_message
    )
    VALUES (
      ${webhookId}, ${fields.eventId}, ${fields.deliveryId}, ${fields.eventType},
      ${fields.signatureValid}, ${fields.status}, ${fields.payloadJson}, ${fields.errorMessage}
    )
    ON CONFLICT (webhook_id) DO NOTHING
  `);
}

export default router;
