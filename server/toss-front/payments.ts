/**
 * 결제 intent 생성 · 확정 · 취소.
 *
 * 왜 intent를 미리 만들어 두나:
 *   Toss Front SDK로 결제창을 띄우기 전에 서버가 paymentKey를 만들어 건네야
 *   나중에 confirm으로 돌아왔을 때 "이 결제는 우리가 시작한 게 맞다"를 확인할 수
 *   있다. 프론트가 임의로 만든 paymentKey는 서버가 알 방법이 없어 신뢰할 수 없다.
 *
 * 왜 confirm에서 트랜잭션 + FOR UPDATE를 걸었나:
 *   같은 paymentKey로 confirm이 두 번 들어올 수 있다. 원인은 다양하다 —
 *   네트워크 재시도, 사용자가 새로고침, SDK가 재시도. 그런데 payments 테이블에
 *   두 번 INSERT하면 학원비가 두 배로 찍힌다. 그래서 intent를 FOR UPDATE로
 *   잠그고 상태를 확인한 뒤에만 진행한다. 이미 APPROVED면 같은 결과를
 *   그대로 돌려준다 (idempotent).
 *
 * 왜 프론트가 보내는 amount를 그대로 신뢰하지 않나:
 *   결제창의 금액을 조작해 100원짜리 승인만 받고 서버에는 12만원으로 기록하려는
 *   시도를 막기 위해서. intent를 만들 때 저장한 amount와 confirm이 실어 온
 *   amount가 다르면 실패시킨다.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  paymentIntents,
  tossPaymentTransactions,
  payments,
  paymentDispatches,
  type PaymentIntentStatus,
} from "@shared/schema";
import { deviceGuard } from "./deviceAuth";
import { verifyVirtualInvoice } from "./virtualInvoice";
import { classifyConfirm } from "./lifecycle";

const router = Router();

// intent 유효 기간. 15분 안에 결제창을 닫고 다시 시도하지 않으면 만료된다.
// invoice 토큰과 같은 창이라 사용자가 갖게 되는 시간 창이 예측 가능해진다.
const INTENT_TTL_MS = 15 * 60 * 1000;

// paymentKey · orderId 포맷 — 관리자 화면에서 눈으로 훑을 수 있게 접두어를 붙인다.
function generatePaymentKey(): string {
  return "tf_" + crypto.randomBytes(16).toString("hex");
}

function generateOrderId(): string {
  const now = new Date();
  const yyyymmdd =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0");
  const rand = crypto.randomBytes(4).toString("hex");
  return `TF-${yyyymmdd}-${rand}`;
}

// ─── intent 생성 ───────────────────────────────────────────────────────
const createIntentBodySchema = z.object({
  invoiceToken: z.string().min(1, "invoiceToken이 필요합니다."),
});

router.post(
  "/payments/intents",
  deviceGuard,
  async (req: Request, res: Response) => {
    const parsed = createIntentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }
    const invoice = verifyVirtualInvoice(parsed.data.invoiceToken);
    if (!invoice) {
      return res.status(400).json({ error: "청구서 토큰이 만료되었거나 유효하지 않습니다." });
    }
    // 단말기가 소속된 학원의 청구서인지 확인. 다른 학원의 토큰을 억지로 넣는 걸 막는다.
    if (invoice.tenantId !== req.device!.tenantId) {
      return res.status(403).json({ error: "다른 학원의 청구서입니다." });
    }
    if (invoice.amount <= 0) {
      return res.status(400).json({ error: "결제 금액이 0원 이하입니다." });
    }

    const paymentKey = generatePaymentKey();
    const orderId = generateOrderId();
    const expiresAt = new Date(Date.now() + INTENT_TTL_MS);

    const [row] = await db
      .insert(paymentIntents)
      .values({
        tenantId: invoice.tenantId,
        paymentKey,
        studentId: invoice.studentId,
        enrollmentId: invoice.enrollmentId,
        paymentMonth: invoice.paymentMonth,
        deviceId: req.device!.id,
        amount: invoice.amount,
        tax: 0,
        supplyValue: invoice.amount,
        taxExemptValue: 0,
        status: "CREATED",
        expiresAt,
      })
      .returning();

    return res.status(201).json({
      intentId: row.id,
      paymentKey,
      orderId,
      amount: invoice.amount,
      orderName: `${invoice.studentName} · ${invoice.className} · ${invoice.paymentMonth}`,
      expiresAt: row.expiresAt,
    });
  }
);

// ─── confirm (승인 확정) ──────────────────────────────────────────────
/**
 * Toss SDK가 승인 완료를 알린 뒤 프론트가 서버로 이 요청을 보낸다.
 *
 * 트랜잭션 안에서 intent를 FOR UPDATE로 잠그고 → 상태·금액을 확인 →
 * 이미 APPROVED면 저장된 결과를 그대로 돌려주고, 아니면 payments 행과
 * toss_payment_transactions 행을 함께 INSERT하고 intent 상태를 APPROVED로 바꾼다.
 *
 * SDK 응답 원본은 rawResponseJson에 그대로 담아 사후 대사·환불에 대비한다.
 * 단 카드 원본번호(cardNumber)는 저장 전에 삭제한다 — 마스킹된 번호만 남긴다.
 */
const confirmBodySchema = z.object({
  paymentKey: z.string().min(1),
  orderId: z.string().min(1),
  amount: z.number().int().positive(),
  // Toss SDK 응답의 결제 결과 부분 — 실제 필드는 SDK 문서에 맞춰 사용한다.
  paymentMethod: z.enum(["CARD", "CASH", "BARCODE"]),
  approvalNumber: z.string().min(1),
  approvedTimestamp: z.string().min(1),
  van: z.string().nullish(),
  tid: z.string().nullish(),
  vanTransactionKey: z.string().nullish(),
  maskedCardNumber: z.string().nullish(),
  issuerName: z.string().nullish(),
  acquirerName: z.string().nullish(),
  cardType: z.string().nullish(),
  installment: z.number().int().min(0).default(0),
  rawResponse: z.any().optional(),
});

router.post(
  "/payments/confirm",
  deviceGuard,
  async (req: Request, res: Response) => {
    const parsed = confirmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      // 어느 필드가 문제인지 반드시 함께 돌려준다.
      //
      // ── 왜 (2026-08-29, 단말기 로그) ──
      //   단말기 화면에 이렇게 찍혔다:
      //     ApiError: API /api/toss-front/payments/confirm 400: {"error":"Required"}
      //   "Required" 는 zod 가 값이 undefined 일 때 쓰는 기본 문구다. 즉 어떤 필드가
      //   빠졌다는 것까지는 알겠는데 그게 amount 인지 paymentMethod 인지 approvedTimestamp
      //   인지는 알 수가 없다. 이 오류가 난 자리가 하필 "카드 승인은 났는데 서버 원장에
      //   못 올린 결제를 복구하는" 경로라 그냥 넘길 수 없다 — 돈은 빠져나갔는데 장부에
      //   없는 상태가 계속된다는 뜻이기 때문이다.
      //
      //   필드 이름은 우리 스키마의 키일 뿐 비밀이 아니다. 값은 절대 싣지 않는다.
      const issue = parsed.error.issues[0];
      const field = issue?.path?.join(".") || "(unknown)";
      const detail = `${field}: ${issue?.message ?? "invalid"}`;
      console.warn(
        "⚠️ payment confirm 400:",
        detail,
        "· 받은 필드=",
        Object.keys(req.body ?? {}).join(",")
      );
      return res.status(400).json({ error: detail, field });
    }
    const body = parsed.data;
    const tenantId = req.device!.tenantId;

    try {
      const result = await db.transaction(async (tx) => {
        // 1) intent 잠금·상태 확인
        const rows = await tx.execute(sql`
          SELECT * FROM payment_intents
          WHERE payment_key = ${body.paymentKey}
            AND tenant_id = ${tenantId}
          FOR UPDATE
        `);
        const intent = (rows.rows as any[])[0];
        if (!intent) {
          return { status: 404, body: { error: "결제 intent를 찾을 수 없습니다." } };
        }

        // 2) 재요청 대응 — 이미 승인된 건이면 같은 결과 반환
        if (intent.status === "APPROVED") {
          const [existingTx] = await tx
            .select()
            .from(tossPaymentTransactions)
            .where(eq(tossPaymentTransactions.paymentKey, body.paymentKey));
          return {
            status: 200,
            body: {
              idempotent: true,
              intentId: intent.id,
              paymentKey: body.paymentKey,
              amount: intent.amount,
              approvalNumber: existingTx?.approvalNumber ?? null,
            },
          };
        }

        // 3~4) 이 승인을 받아 줄지 판단. 규칙과 그 근거는 lifecycle.ts 에 있다.
        //   요지: 이 핸들러에 도착했다는 건 카드가 **이미 긁혔다**는 뜻이다. 만료나
        //   TIMEOUT 을 이유로 거절하면 돈은 나갔는데 장부에는 안 남는다. 그래서
        //   늦게 온 승인도 받아 주되 "지각 승인"이라는 흔적을 반드시 남긴다.
        const decision = classifyConfirm({
          intentStatus: intent.status,
          expiresAt: intent.expires_at,
        });
        if (decision.kind === "reject") {
          return { status: 409, body: { error: decision.reason } };
        }
        // kind === "idempotent" 는 위 2) 에서 이미 처리했다. 방어적으로 한 번 더.
        if (decision.kind === "idempotent") {
          return { status: 409, body: { error: "이미 승인된 결제입니다." } };
        }

        const lateRecovery = decision.lateRecovery;
        const lateWhy = decision.lateRecovery ? decision.why : null;
        if (decision.lateRecovery) {
          console.warn(
            `⚠️ 지각 승인 복구: paymentKey=${body.paymentKey} (${decision.why}) — ` +
              `카드가 이미 승인된 건이므로 거절하지 않고 기록합니다.`
          );
        }

        // 5) 금액 위조 확인 — 프론트가 보낸 amount가 intent에 저장된 값과 다르면 거절
        if (body.amount !== intent.amount) {
          await tx
            .update(paymentIntents)
            .set({
              status: "FAILED",
              failureReason: `amount mismatch: expected ${intent.amount}, got ${body.amount}`,
            })
            .where(eq(paymentIntents.id, intent.id));
          return { status: 400, body: { error: "결제 금액이 일치하지 않습니다." } };
        }

        // 6) 승인 원본 저장 — 카드 원본번호는 저장하지 않는다.
        const rawForStorage = sanitizeRawResponse(body.rawResponse);

        const [txRow] = await tx
          .insert(tossPaymentTransactions)
          .values({
            tenantId,
            paymentKey: body.paymentKey,
            intentId: intent.id,
            paymentMethod: body.paymentMethod,
            van: body.van ?? null,
            tid: body.tid ?? null,
            vanTransactionKey: body.vanTransactionKey ?? null,
            approvalNumber: body.approvalNumber,
            approvedTimestamp: body.approvedTimestamp,
            maskedCardNumber: body.maskedCardNumber ?? null,
            issuerName: body.issuerName ?? null,
            acquirerName: body.acquirerName ?? null,
            cardType: body.cardType ?? null,
            installment: body.installment,
            rawResponseJson: rawForStorage ? JSON.stringify(rawForStorage) : null,
          })
          .returning();

        // 7) payments 행 INSERT — 기존 회계 화면이 그대로 인식하도록 기존 컬럼을 채우고
        //    external 컬럼으로 어느 승인 트랜잭션에서 왔는지 연결한다.
        //    method는 결제수단에 맞춰 매핑, 없으면 카드로 기록.
        //    createdBy는 시스템 결제라 필요하지만 users.id를 요구하는 FK가 있어 문제가 된다.
        //    → 아래에서 별도로 처리한다.
        const systemUserId = await getOrCreateSystemUserId(tx, tenantId);

        await tx.insert(payments).values({
          tenantId,
          enrollmentId: intent.enrollment_id,
          amount: intent.amount,
          type: "원비",
          method: body.paymentMethod === "CARD" ? "카드" : "현금",
          paymentMonth: intent.payment_month,
          paidDate: new Date(),
          createdBy: systemUserId,
          // 지각 승인이면 비고에 남긴다. 회계 화면에서 원장이 "이 건은 왜 늦게 들어왔지"를
          // 되짚을 수 있는 유일한 단서다.
          notes:
            `Toss Front · ${body.approvalNumber}` +
            (lateWhy ? ` · 지각 승인 복구(${lateWhy})` : ""),
          externalProvider: "TOSSPLACE",
          externalPaymentKey: body.paymentKey,
          externalTransactionId: txRow.id,
          paidVia: "TOSS_FRONT",
        });

        // 8) intent 상태를 APPROVED로 확정.
        //    지각 승인이면 failureReason 에 경위를 남긴다 (실패가 아니라 "왜 늦었나"의 기록).
        await tx
          .update(paymentIntents)
          .set({
            status: "APPROVED",
            approvedAt: new Date(),
            failureReason: lateWhy ? `late confirm recovered (${lateWhy})` : null,
          })
          .where(eq(paymentIntents.id, intent.id));

        // 9) 결제 단말기 모드로 만들어진 결제였다면 dispatch도 함께 APPROVED로 마감.
        //    태블릿이 폴링해서 완료 화면으로 넘어갈 수 있게 하는 신호.
        //    dispatch가 없으면(구 흐름) 조용히 건너뛴다.
        await tx
          .update(paymentDispatches)
          .set({ status: "APPROVED", respondedAt: new Date() })
          .where(
            and(
              eq(paymentDispatches.paymentKey, body.paymentKey),
              eq(paymentDispatches.tenantId, tenantId)
            )
          );

        return {
          status: 200,
          body: {
            idempotent: false,
            intentId: intent.id,
            paymentKey: body.paymentKey,
            amount: intent.amount,
            approvalNumber: body.approvalNumber,
          },
        };
      });

      return res.status(result.status).json(result.body);
    } catch (err: any) {
      // paymentKey unique violation은 승인 중복 방어의 마지막 관문.
      // 위의 FOR UPDATE + APPROVED 분기가 통과하지 못한 극단적 경합에서만 여기 도달.
      if (err?.code === "23505") {
        console.warn("🔒 payment confirm unique conflict:", err.detail);
        return res.status(409).json({ error: "중복된 승인 요청입니다." });
      }
      console.error("payment confirm error:", err);
      return res.status(500).json({ error: "결제 확정 중 오류가 발생했습니다." });
    }
  }
);

// ─── 취소 ─────────────────────────────────────────────────────────────
/**
 * 이 엔드포인트는 실제 카드 취소 API 호출을 트리거하지는 않는다 (그건 Toss
 * Open API 서버 대 서버 호출). intent 상태를 CANCELED로 표시하고 감사 로그만
 * 남긴다. 실제 승인이 이미 있었다면 별도의 환불 흐름으로 payments에 음수 행이
 * 들어와야 하며, 그건 다음 커밋(웹훅 재조정)에서 붙는다.
 */
const cancelBodySchema = z.object({
  paymentKey: z.string().min(1),
  reason: z.string().max(200).optional(),
});

router.post(
  "/payments/cancel",
  deviceGuard,
  async (req: Request, res: Response) => {
    const parsed = cancelBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }
    const tenantId = req.device!.tenantId;
    // CREATED 뿐 아니라 PROCESSING 도 취소 대상이다.
    // dispatch ack 시점에 intent 가 CREATED → PROCESSING 으로 올라가므로,
    // CREATED 만 허용하면 "결제창까지 떴다가 사용자가 취소" 라는 가장 흔한 경로에서
    // 항상 409 가 나고 intent 가 만료될 때까지 PROCESSING 으로 남는다.
    const cancellable: PaymentIntentStatus[] = ["CREATED", "PROCESSING"];
    const result = await db
      .update(paymentIntents)
      .set({
        status: "CANCELED",
        cancelledAt: new Date(),
        failureReason: parsed.data.reason ?? "user cancelled",
      })
      .where(
        and(
          eq(paymentIntents.paymentKey, parsed.data.paymentKey),
          eq(paymentIntents.tenantId, tenantId),
          inArray(paymentIntents.status, cancellable)
        )
      )
      .returning({ id: paymentIntents.id });
    if (result.length === 0) {
      return res.status(409).json({ error: "취소할 수 없는 상태입니다." });
    }
    return res.json({ ok: true });
  }
);

// ─── 헬퍼 ─────────────────────────────────────────────────────────────
/**
 * SDK 응답을 저장하기 전에 카드 원본번호로 보이는 필드를 삭제한다.
 *
 * 화이트리스트가 아니라 블랙리스트로 지운 이유: SDK 응답 스키마가 확장될 수
 * 있어서, 새 필드가 저장되지 않으면 나중에 대사할 때 부족해질 수 있다. 대신
 * 원본번호로 오인될 필드 이름만 걸러 낸다. PCI DSS는 SAQ D 없이 원본번호를
 * 저장할 수 없다.
 */
function sanitizeRawResponse(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  const CARD_KEY_PATTERN = /(^|_)card_?number$|^pan$|^track2$/i;
  const clone = JSON.parse(JSON.stringify(raw));
  const walk = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    for (const k of Object.keys(obj)) {
      if (CARD_KEY_PATTERN.test(k)) {
        delete obj[k];
      } else if (typeof obj[k] === "object") {
        walk(obj[k]);
      }
    }
  };
  walk(clone);
  return clone;
}

/**
 * payments.createdBy는 users FK. Toss 결제는 사람이 아닌 시스템이 만들지만
 * users에 자리를 마련해 두지 않으면 FK 위반이 난다. tenant마다 시스템 사용자
 * 한 명을 만들어 놓고 재사용한다. 이 사용자는 로그인 못하도록 isActive=false다.
 */
async function getOrCreateSystemUserId(tx: any, tenantId: string): Promise<string> {
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

export default router;
