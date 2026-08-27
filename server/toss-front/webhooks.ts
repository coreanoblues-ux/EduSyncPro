/**
 * Toss Open API 웹훅 수신.
 *
 * 왜 웹훅이 필요한가:
 *   confirm 요청이 네트워크 문제로 서버에 도달하지 못한 경우, 카드 승인은 실제
 *   났지만 우리 payments에는 안 남는다. 그러면 학원비가 이중청구되거나 미납으로
 *   잘못 표시된다. Toss는 승인이 확정된 뒤 별도로 웹훅을 쏘므로, 이걸 최종
 *   진실의 원본으로 삼아 confirm이 빠뜨린 건을 뒤에서 채운다.
 *
 * 왜 rawBody가 필요한가:
 *   HMAC 서명은 원문 문자열에 대해 계산된다. Express가 JSON을 파싱해 다시
 *   JSON.stringify하면 공백·키 순서가 달라져 서명이 안 맞는다. index.ts의
 *   express.json({ verify }) 콜백에서 웹훅 경로에 한해 req.rawBody를 채워 둔다.
 *
 * 왜 x-toss-webhook-id를 PK로 두는가:
 *   Toss는 배송 실패 시 같은 webhook_id로 재전송한다. PK 유니크로 자동 중복 방지.
 *   서명 검증 실패도 status=FAILED로 저장한다 — 공격 시도의 흔적을 남기기 위해.
 *
 * 처리 흐름:
 *   1. rawBody + x-toss-timestamp로 HMAC-SHA256 계산 → x-toss-signature와 비교
 *   2. tossWebhookEvents에 원문 삽입 (webhookId 중복이면 이전 처리 결과 반환)
 *   3. eventType에 따라 재조정 로직 수행:
 *      - PAYMENT_APPROVED: paymentKey로 intent 찾아 APPROVED로 확정, payments 없으면 삽입
 *      - PAYMENT_CANCELED: 취소 반영 (음수 payments 행 삽입)
 *   4. 성공이면 200 OK, 항상 200을 돌려 Toss의 재시도를 줄인다 (서명 오류 제외).
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
  const eventType = (req.headers["x-toss-event-type"] as string) || "";
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
      eventType,
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
      eventType,
      signatureValid: false,
      status: "FAILED",
      payloadJson: rawBody,
      errorMessage: "signature mismatch",
    });
    // 서명 실패는 401로 알려 Toss가 재발송을 멈추게 한다 — 시크릿이 바뀐 상황일 수 있어
    // 계속 재시도하게 두면 로그 폭탄이 된다.
    return res.status(401).json({ error: "서명이 유효하지 않습니다." });
  }

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
    const parsed = JSON.parse(rawBody);
    await reconcile(eventType, parsed);
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
 * 웹훅 payload에서 paymentKey를 뽑아 payment_intents를 찾고, 상태·payments 행을
 * 실제 승인 결과에 맞춘다. 웹훅이 confirm보다 먼저 오는 경우도 있어서, intent만
 * 있고 payments가 아직 없으면 이 자리에서 채운다.
 *
 * confirm 흐름과 겹칠 수 있으므로 트랜잭션 안에서 FOR UPDATE로 잠근다.
 */
async function reconcile(eventType: string, payload: any) {
  const paymentKey: string | undefined = payload?.paymentKey ?? payload?.data?.paymentKey;
  if (!paymentKey) {
    // 결제 관련이 아닌 이벤트(예: 가맹점 정책 변경 알림)는 조용히 무시.
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

    if (eventType === "PAYMENT_APPROVED" || payload?.status === "DONE") {
      // 이미 confirm으로 처리됐으면 아무것도 안 함.
      if (intent.status === "APPROVED") return;

      // confirm이 오지 못한 상태 — 웹훅으로 확정한다.
      // rawResponseJson에 웹훅 원문을 넣어 두어 사후 대사 가능.
      const [txRow] = await tx
        .insert(tossPaymentTransactions)
        .values({
          tenantId: intent.tenant_id,
          paymentKey,
          intentId: intent.id,
          paymentMethod: (payload?.method as any) ?? "CARD",
          approvalNumber: payload?.approvalNumber ?? "WEBHOOK",
          approvedTimestamp: String(payload?.approvedAt ?? Date.now()),
          maskedCardNumber: payload?.card?.number ?? null,
          issuerName: payload?.card?.issuerName ?? null,
          acquirerName: payload?.card?.acquirerName ?? null,
          cardType: payload?.card?.cardType ?? null,
          installment: payload?.card?.installmentPlanMonths ?? 0,
          rawResponseJson: JSON.stringify({ source: "webhook", payload }),
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
            paidDate: new Date(),
            createdBy: systemUserId,
            notes: `Toss Front (webhook) · ${paymentKey}`,
            externalProvider: "TOSSPLACE",
            externalPaymentKey: paymentKey,
            externalTransactionId: txRow.id,
            paidVia: "TOSS_FRONT",
          });
      }

      await tx
        .update(paymentIntents)
        .set({ status: "APPROVED", approvedAt: new Date() })
        .where(eq(paymentIntents.id, intent.id));
    } else if (eventType === "PAYMENT_CANCELED" || eventType === "PAYMENT_PARTIAL_CANCELED") {
      // 취소 반영 — 원래 승인 금액만큼 음수 payments 행을 넣어 회계 순액을 맞춘다.
      // 부분 취소는 payload.cancelAmount를 우선 사용.
      const cancelAmount: number = Number(payload?.cancelAmount ?? intent.amount);
      if (cancelAmount <= 0) return;

      const email = `system+toss-front@${intent.tenant_id}.local`;
      const userRows = await tx.execute(sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`);
      const systemUserId = (userRows.rows as any[])[0]?.id;
      if (systemUserId) {
        await tx.insert(payments).values({
          tenantId: intent.tenant_id,
          enrollmentId: intent.enrollment_id,
          amount: -cancelAmount,
          type: "환불",
          method: "카드",
          paymentMonth: intent.payment_month,
          paidDate: new Date(),
          createdBy: systemUserId,
          notes: `Toss Front 취소 (webhook) · ${paymentKey}`,
          externalProvider: "TOSSPLACE",
          externalPaymentKey: paymentKey,
          paidVia: "TOSS_FRONT",
        });
      }

      await tx
        .update(paymentIntents)
        .set({ status: "CANCELED", cancelledAt: new Date() })
        .where(eq(paymentIntents.id, intent.id));
    }
    // 알 수 없는 eventType은 무시. 감사 로그에는 그대로 남는다.
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
