/**
 * 원장이 웹 화면에서 Toss Front 연동 상태를 감시하는 API.
 *
 * 대부분은 순수 조회 전용이다. 결제 "승인"만큼은 사람이 관리자 화면에서 만들 수
 * 없게 막아 둔다. 승인은 SDK 응답과 웹훅으로만 확정돼야 데이터가 한 갈래로 흐르고,
 * 중간에 사람이 손대는 경로가 열리면 대사가 어긋나기 때문이다.
 *
 * 예외는 두 가지이며 둘 다 의도적이다:
 *   - 소액 테스트 결제 (연동 점검용, 환경변수로 잠가 둔다)
 *   - 환불 기록 (/admin/refunds) — 아래 해당 절의 주석 참고.
 *     환불은 본질적으로 사람의 결정이라 자동화할 수 없다. 대신 금액을 상태 플래그가
 *     아니라 payments 장부에서 매번 다시 세는 방식으로 이중 계상을 막는다.
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  paymentIntents,
  paymentDispatches,
  tossWebhookEvents,
  tossFrontDevices,
  students,
  enrollments,
  classes,
  payments,
  tossPaymentTransactions,
  type PaymentDispatchStatus,
} from "@shared/schema";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";
import { publish } from "./dispatchBus";
import { classifyRefund, refundableAmount } from "./refund";
import { classifyReconcile } from "./reconcile";

const router = Router();

// ─── 요약 대시보드 ─────────────────────────────────────────────────────
router.get(
  "/admin/summary",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.json({});

    // 오늘 자정(KST) 기준. Railway는 UTC라 offset을 명시적으로 계산.
    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    nowKst.setUTCHours(0, 0, 0, 0);
    const startOfToday = new Date(nowKst.getTime() - 9 * 60 * 60 * 1000);

    // 오늘 intent 카운트 by status
    const todayIntents = await db
      .select({
        status: paymentIntents.status,
        count: sql<number>`count(*)::int`,
      })
      .from(paymentIntents)
      .where(and(eq(paymentIntents.tenantId, tenantId), gte(paymentIntents.createdAt, startOfToday)))
      .groupBy(paymentIntents.status);

    // 오늘 승인 금액 합
    const [approvedSum] = await db
      .select({ sum: sql<number>`coalesce(sum(${paymentIntents.amount}), 0)::int` })
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          gte(paymentIntents.createdAt, startOfToday),
          eq(paymentIntents.status, "APPROVED")
        )
      );

    // 최근 24시간 웹훅 상태 카운트
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const webhookCounts = await db
      .select({
        status: tossWebhookEvents.status,
        count: sql<number>`count(*)::int`,
      })
      .from(tossWebhookEvents)
      .where(
        and(
          gte(tossWebhookEvents.receivedAt, since24h),
          // tenant가 null인 웹훅(서명 실패 등)도 카운트에는 포함
          sql`(${tossWebhookEvents.tenantId} = ${tenantId} OR ${tossWebhookEvents.tenantId} IS NULL)`
        )
      )
      .groupBy(tossWebhookEvents.status);

    // 활성 단말기 수
    const [deviceCounts] = await db
      .select({
        active: sql<number>`count(*) FILTER (WHERE ${tossFrontDevices.isActive} = true)::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(tossFrontDevices)
      .where(eq(tossFrontDevices.tenantId, tenantId));

    return res.json({
      todayIntentsByStatus: todayIntents,
      todayApprovedAmount: approvedSum?.sum ?? 0,
      webhook24hByStatus: webhookCounts,
      devices: deviceCounts ?? { active: 0, total: 0 },
    });
  }
);

// ─── intent 목록 ───────────────────────────────────────────────────────
router.get(
  "/admin/intents",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.json([]);

    const status = typeof req.query.status === "string" ? req.query.status : null;
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const conditions = [eq(paymentIntents.tenantId, tenantId)];
    if (status) conditions.push(eq(paymentIntents.status, status as any));

    const rows = await db
      .select({
        id: paymentIntents.id,
        paymentKey: paymentIntents.paymentKey,
        studentId: paymentIntents.studentId,
        studentName: students.name,
        className: classes.name,
        paymentMonth: paymentIntents.paymentMonth,
        amount: paymentIntents.amount,
        status: paymentIntents.status,
        approvedAt: paymentIntents.approvedAt,
        cancelledAt: paymentIntents.cancelledAt,
        failureReason: paymentIntents.failureReason,
        createdAt: paymentIntents.createdAt,
        // 이 건이 장부(payments)에 수입으로 잡혀 있는가.
        //
        // 상태만 봐서는 알 수 없다는 게 핵심이다. TIMEOUT 인데 실제로는 카드가
        // 승인된 건이 존재하고(2026-08-29 현장), 그 건은 화면상 실패와 구분되지
        // 않는다. 이 플래그가 있어야 원장이 "실패로 보이는데 장부에도 없네 →
        // 판매자센터에서 승인내역 확인" 이라는 다음 행동으로 갈 수 있다.
        ledgered: sql<boolean>`exists (
          SELECT 1 FROM payments p
          WHERE p.external_payment_key = ${paymentIntents.paymentKey}
            AND p.tenant_id = ${tenantId}
            AND p.amount > 0
        )`,
      })
      .from(paymentIntents)
      .leftJoin(students, eq(students.id, paymentIntents.studentId))
      .leftJoin(enrollments, eq(enrollments.id, paymentIntents.enrollmentId))
      .leftJoin(classes, eq(classes.id, enrollments.classId))
      .where(and(...conditions))
      .orderBy(desc(paymentIntents.createdAt))
      .limit(limit);

    return res.json(rows);
  }
);

// ─── 환불 (원장 전용) ──────────────────────────────────────────────────
/**
 * 왜 환불이 원장 화면에만 있고 학생 태블릿에는 없나:
 *   태블릿 인증은 "전화번호 뒤 4자리"다. 그건 학부모 본인 확인용이지 돈을 되돌릴
 *   권한의 근거가 못 된다. 뒤 4자리는 같은 학원 안에서도 충분히 겹치고, 태블릿은
 *   현관에 놓여 누구나 만진다. 환불은 authGuard + roleGuard(owner) 뒤에 둔다.
 *
 * ⚠️ 이 API 가 하는 일과 하지 않는 일을 분명히 해 둔다:
 *      하는 일    — 우리 장부(payments)에 환불 행을 남기고 잔액을 되돌린다.
 *      하지 않는 일 — 카드사에 취소를 걸지 않는다.
 *
 *   실제 카드 취소는 Toss Open API 서버-대-서버 호출이 필요한데, 이 서버에는
 *   그 시크릿 키가 없다 (TOSS_MERCHANT_ID·웹훅 시크릿·단말기 시크릿뿐).
 *   toss_payment_transactions 에 tid·vanTransactionKey 를 이미 저장해 두었으므로
 *   키만 확보되면 이 지점에 호출을 붙이면 된다. 그때까지 실제 취소는 단말기나
 *   토스 판매자센터에서 원장이 수행하고, 이 화면은 그 사실을 장부에 반영한다.
 *   화면에도 같은 문장을 띄운다 — 원장이 "눌렀으니 돈이 돌아갔겠지"라고
 *   오해하면 그게 가장 큰 사고다.
 */

/** pg_advisory_xact_lock(int, int) 키. dispatch.ts 와 같은 방식. */
function advisoryKey(input: string): number {
  return crypto.createHash("sha256").update(input).digest().readInt32BE(0);
}

/**
 * DB 오류를 원장이 읽고 그대로 옮겨 적을 수 있는 한 줄로 만든다.
 *
 * 왜 필요한가 (2026-08-29):
 *   장부 반영이 "500: 대사 처리 중 오류가 발생했습니다" 만 띄우고 죽었다. 그 문장에는
 *   원인이 한 글자도 없다. 원장은 Railway 로그를 볼 수 없고, 나는 화면만 보고 원인을
 *   추측하게 된다. 페어링 실패 때 "코드가 잘못됐거나 서버에 연결하지 못했습니다" 한 줄
 *   때문에 원인 찾는 데 하루가 걸렸던 것과 똑같은 실수를 내가 또 했다.
 *
 *   이 경로는 owner/superadmin 전용이라 내부 오류를 노출해도 외부로 새지 않는다.
 *   Postgres 오류는 code(23505 등)·constraint·column 을 들고 오는데, 그 셋이면
 *   대부분 원인이 한 번에 정해진다.
 */
function describeDbError(err: any): string {
  const bits: string[] = [];
  if (err?.code) bits.push(`code=${err.code}`);
  if (err?.constraint) bits.push(`constraint=${err.constraint}`);
  if (err?.column) bits.push(`column=${err.column}`);
  if (err?.table) bits.push(`table=${err.table}`);
  if (err?.detail) bits.push(`detail=${err.detail}`);
  const msg = err?.message ?? String(err);
  return bits.length > 0 ? `${msg} (${bits.join(" · ")})` : msg;
}

/**
 * 이 paymentKey 로 이미 환불된 누적액(양수).
 *
 * 상태 플래그가 아니라 payments 행을 매번 다시 센다. 원장의 수기 환불과 토스
 * 취소 웹훅이 서로 다른 순서로 도착하기 때문에, "환불했음" 이라는 플래그 하나로는
 * 이중 계상을 막을 수 없다. 실제로 적힌 돈만이 사실이다.
 */
async function sumRefunded(tx: any, tenantId: string, paymentKey: string): Promise<number> {
  const [row] = await tx
    .select({ sum: sql<number>`coalesce(sum(${payments.amount}), 0)::int` })
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, tenantId),
        eq(payments.externalPaymentKey, paymentKey),
        sql`${payments.amount} < 0`
      )
    );
  return Math.abs(row?.sum ?? 0);
}

/** 환불 가능한 결제 목록 — 승인된 건과 그 중 이미 환불된 금액. */
router.get(
  "/admin/refundable",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.json([]);
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    // 승인된 적 있는 건만. CANCELED 도 포함하는 이유는 "이미 전액 환불됨"을
    // 화면에서 보여 주기 위함이다. 목록에서 사라지면 원장은 환불이 반영된 건지
    // 자기가 잘못 본 건지 확인할 방법이 없다 (태블릿 완납 표시와 같은 이유).
    const rows = await db
      .select({
        paymentKey: paymentIntents.paymentKey,
        studentName: students.name,
        className: classes.name,
        paymentMonth: paymentIntents.paymentMonth,
        amount: paymentIntents.amount,
        status: paymentIntents.status,
        approvedAt: paymentIntents.approvedAt,
        // 이 건에 딸린 환불 누적액. 상관 서브쿼리로 한 번에 가져온다.
        refunded: sql<number>`coalesce((
          SELECT -sum(p.amount)::int FROM payments p
          WHERE p.external_payment_key = ${paymentIntents.paymentKey}
            AND p.tenant_id = ${tenantId}
            AND p.amount < 0
        ), 0)`,
      })
      .from(paymentIntents)
      .leftJoin(students, eq(students.id, paymentIntents.studentId))
      .leftJoin(enrollments, eq(enrollments.id, paymentIntents.enrollmentId))
      .leftJoin(classes, eq(classes.id, enrollments.classId))
      .where(
        and(
          eq(paymentIntents.tenantId, tenantId),
          inArray(paymentIntents.status, ["APPROVED", "CANCELED"])
        )
      )
      .orderBy(desc(paymentIntents.approvedAt))
      .limit(limit);

    return res.json(
      rows.map((r) => ({
        ...r,
        refundable: r.status === "APPROVED" ? refundableAmount(r.amount, r.refunded) : 0,
      }))
    );
  }
);

const refundBodySchema = z.object({
  paymentKey: z.string().min(1),
  // 부분 환불을 허용한다. 27만원 중 7만원만 돌려주는 상황(중도 퇴원 정산)이 실제로 있다.
  amount: z.number().int().positive("환불 금액은 1원 이상이어야 합니다."),
  reason: z.string().trim().max(200).optional(),
});

router.post(
  "/admin/refunds",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const parsed = refundBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }
    const tenantId = req.user!.tenantId;
    const userId = req.user!.id;
    if (!tenantId) return res.status(403).json({ error: "테넌트가 없는 계정입니다." });

    const { paymentKey, amount, reason } = parsed.data;

    class RefundReject extends Error {
      constructor(public httpStatus: number, message: string) {
        super(message);
      }
    }

    try {
      const result = await db.transaction(async (tx) => {
        // 같은 결제에 대한 동시 환불 요청을 직렬화한다. 환불 버튼은 네트워크가
        // 느리면 반드시 두 번 눌린다 — 잠그지 않으면 두 요청이 같은 "이미 환불된
        // 누적액"을 읽고 둘 다 통과시킨다.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryKey(paymentKey)}, 0)`);

        const [intent] = await tx
          .select({
            id: paymentIntents.id,
            status: paymentIntents.status,
            amount: paymentIntents.amount,
            enrollmentId: paymentIntents.enrollmentId,
            paymentMonth: paymentIntents.paymentMonth,
          })
          .from(paymentIntents)
          .where(
            and(eq(paymentIntents.paymentKey, paymentKey), eq(paymentIntents.tenantId, tenantId))
          );
        if (!intent) throw new RefundReject(404, "결제 건을 찾을 수 없습니다.");

        const alreadyRefunded = await sumRefunded(tx, tenantId, paymentKey);
        const decision = classifyRefund({
          intentStatus: intent.status,
          approvedAmount: intent.amount,
          alreadyRefunded,
          requested: amount,
        });
        if (decision.kind === "reject") throw new RefundReject(409, decision.reason);

        // 장부 반영. 부호 규칙에 따라 음수로 넣는다 (Payments 화면이 단순 SUM 한다).
        // createdBy 는 시스템 사용자가 아니라 실제로 누른 원장이다 — 환불은 사람의
        // 결정이므로 누가 했는지가 감사 기록에 남아야 한다.
        await tx.insert(payments).values({
          tenantId,
          enrollmentId: intent.enrollmentId,
          amount: -decision.amount,
          type: "환불",
          method: "카드",
          paymentMonth: intent.paymentMonth,
          paidDate: new Date(),
          createdBy: userId,
          notes:
            `Toss Front 환불 (원장 기록) · ${paymentKey}` +
            (reason ? ` · 사유: ${reason}` : "") +
            (decision.fullyRefunded ? " · 전액" : ` · 부분(${decision.remainingAfter.toLocaleString()}원 남음)`),
          externalProvider: "TOSSPLACE",
          externalPaymentKey: paymentKey,
          paidVia: "TOSS_FRONT",
        });

        // 전액 환불이면 intent 를 CANCELED 로 마감한다. 부분 환불이면 APPROVED 로
        // 남겨 둔다 — 아직 환불할 잔액이 있다는 뜻이고, 목록에서도 계속 보여야 한다.
        if (decision.fullyRefunded) {
          await tx
            .update(paymentIntents)
            .set({ status: "CANCELED", cancelledAt: new Date() })
            .where(eq(paymentIntents.id, intent.id));
        }

        return {
          refundedNow: decision.amount,
          totalRefunded: alreadyRefunded + decision.amount,
          remaining: decision.remainingAfter,
          fullyRefunded: decision.fullyRefunded,
        };
      });

      console.log(
        `💸 환불 기록: paymentKey=${paymentKey} ${result.refundedNow.toLocaleString()}원 (누적 ${result.totalRefunded.toLocaleString()}원, 잔여 ${result.remaining.toLocaleString()}원)`
      );
      return res.json({
        ok: true,
        ...result,
        notice:
          "장부에 환불이 기록되었습니다. 실제 카드 취소는 단말기 또는 토스 판매자센터에서 별도로 진행해야 합니다.",
      });
    } catch (err: any) {
      if (err instanceof RefundReject) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      console.error("refund error:", err);
      return res.status(500).json({
        error: `환불 처리 중 오류가 발생했습니다: ${describeDbError(err)}`,
      });
    }
  }
);

// ─── 수기 대사 (원장 전용) ─────────────────────────────────────────────
/**
 * "카드는 승인됐는데 장부에 없는 건"을 되찾는다. 판정 근거는 reconcile.ts 참고.
 *
 * 금액을 사람이 정하지 못하게 하는 것이 이 API 의 핵심 안전장치다. 항상
 * intent.amount 를 쓴다. 승인번호는 필수 — 판매자센터에서 실물을 보고 옮겨 적는
 * 행위를 강제해서 "아마 됐겠지" 로 누르는 것을 막는다.
 */
const reconcileBodySchema = z.object({
  paymentKey: z.string().min(1),
  approvalNumber: z
    .string()
    .trim()
    .min(1, "승인번호를 입력하세요. 토스 판매자센터에서 확인할 수 있습니다.")
    .max(64),
  /** 실제 승인 시각. 모르면 생략 가능하나, 넣으면 장부 날짜가 정확해진다. */
  approvedAt: z.string().datetime().optional(),
  note: z.string().trim().max(200).optional(),
});

/** 이 paymentKey 로 이미 수입(양수) 행이 장부에 있는가. */
async function hasPositiveLedgerRow(tx: any, tenantId: string, paymentKey: string): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, tenantId),
        eq(payments.externalPaymentKey, paymentKey),
        sql`${payments.amount} > 0`
      )
    );
  return (row?.n ?? 0) > 0;
}

router.post(
  "/admin/reconcile",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const parsed = reconcileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }
    const tenantId = req.user!.tenantId;
    const userId = req.user!.id;
    if (!tenantId) return res.status(403).json({ error: "테넌트가 없는 계정입니다." });

    const { paymentKey, approvalNumber, approvedAt, note } = parsed.data;

    class ReconcileReject extends Error {
      constructor(public httpStatus: number, message: string) {
        super(message);
      }
    }

    try {
      const result = await db.transaction(async (tx) => {
        // 환불과 같은 이유로 직렬화한다. 두 번 눌린 요청이 같은 "장부에 없음"을
        // 읽고 둘 다 통과하면 수입이 두 번 잡힌다.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryKey(paymentKey)}, 0)`);

        const [intent] = await tx
          .select({
            id: paymentIntents.id,
            status: paymentIntents.status,
            amount: paymentIntents.amount,
            enrollmentId: paymentIntents.enrollmentId,
            paymentMonth: paymentIntents.paymentMonth,
          })
          .from(paymentIntents)
          .where(
            and(eq(paymentIntents.paymentKey, paymentKey), eq(paymentIntents.tenantId, tenantId))
          );
        if (!intent) throw new ReconcileReject(404, "결제 건을 찾을 수 없습니다.");

        const alreadyLedgered = await hasPositiveLedgerRow(tx, tenantId, paymentKey);
        const decision = classifyReconcile({ intentStatus: intent.status, alreadyLedgered });
        if (decision.kind === "reject") throw new ReconcileReject(409, decision.reason);
        if (decision.kind === "noop") {
          return { inserted: false, amount: intent.amount, message: decision.reason };
        }

        const paidDate = approvedAt ? new Date(approvedAt) : new Date();

        // 승인 원본 테이블에도 흔적을 남긴다. 여기서 이중 삽입이 한 번 더 걸러진다
        // (advisory lock 이 어떤 이유로 안 먹어도).
        //
        // ⚠️ target 을 intentId 로 좁게 지정하면 안 된다. 이 테이블은 payment_key 에도
        //    unique 가 걸려 있어서, 그쪽에서 충돌하면 onConflictDoNothing 이 잡아 주지
        //    못하고 그대로 예외가 된다. 우리가 막으려는 건 "중복 삽입" 자체이므로
        //    어떤 unique 든 충돌하면 조용히 건너뛰는 게 맞다.
        //
        //    건너뛰더라도 payments 삽입은 계속 진행한다. 여기 오기 전에
        //    alreadyLedgered 로 "장부에 수입 행이 없다"를 이미 확인했기 때문이다.
        //    승인 원본만 남고 장부가 비어 있는 상태야말로 이 기능이 고치려는 대상이다.
        const [txRow] = await tx
          .insert(tossPaymentTransactions)
          .values({
            tenantId,
            paymentKey,
            intentId: intent.id,
            paymentMethod: "CARD",
            approvalNumber,
            approvedTimestamp: String(paidDate.getTime()),
            rawResponseJson: JSON.stringify({
              source: "manual-reconcile",
              by: userId,
              at: new Date().toISOString(),
              note: note ?? null,
            }),
          })
          .onConflictDoNothing()
          .returning();

        await tx.insert(payments).values({
          tenantId,
          enrollmentId: intent.enrollmentId,
          // ⚠️ 금액은 언제나 intent.amount. 사람이 못 고친다.
          amount: intent.amount,
          type: "원비",
          method: "카드",
          paymentMonth: intent.paymentMonth,
          paidDate,
          createdBy: userId,
          notes:
            `Toss Front 수기 대사 · 승인번호 ${approvalNumber}` +
            ` · 단말기 승인은 됐으나 서버 기록이 누락되어 원장이 확인 후 반영` +
            (note ? ` · ${note}` : ""),
          externalProvider: "TOSSPLACE",
          externalPaymentKey: paymentKey,
          externalTransactionId: txRow?.id ?? null,
          paidVia: "TOSS_FRONT",
        });

        await tx
          .update(paymentIntents)
          .set({
            status: "APPROVED",
            approvedAt: paidDate,
            failureReason: `manually reconciled by ${userId} (approval ${approvalNumber})`,
          })
          .where(eq(paymentIntents.id, intent.id));

        return { inserted: true, amount: intent.amount, message: "장부에 반영했습니다." };
      });

      if (result.inserted) {
        console.log(
          `🧾 수기 대사: paymentKey=${paymentKey} ${result.amount.toLocaleString()}원을 장부에 반영 (by ${userId})`
        );
      }
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      if (err instanceof ReconcileReject) {
        return res.status(err.httpStatus).json({ error: err.message });
      }
      console.error("reconcile error:", err);
      return res.status(500).json({
        error: `대사 처리 중 오류가 발생했습니다: ${describeDbError(err)}`,
      });
    }
  }
);

// ─── 웹훅 이벤트 목록 ──────────────────────────────────────────────────
router.get(
  "/admin/webhooks",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.json([]);
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const rows = await db
      .select({
        webhookId: tossWebhookEvents.webhookId,
        eventType: tossWebhookEvents.eventType,
        signatureValid: tossWebhookEvents.signatureValid,
        status: tossWebhookEvents.status,
        errorMessage: tossWebhookEvents.errorMessage,
        receivedAt: tossWebhookEvents.receivedAt,
        processedAt: tossWebhookEvents.processedAt,
      })
      .from(tossWebhookEvents)
      .where(
        sql`(${tossWebhookEvents.tenantId} = ${tenantId} OR ${tossWebhookEvents.tenantId} IS NULL)`
      )
      .orderBy(desc(tossWebhookEvents.receivedAt))
      .limit(limit);

    return res.json(rows);
  }
);

// ─── 소액 테스트 결제 (원장 전용) ──────────────────────────────────────
/**
 * 100원짜리 결제요청을 단말기로 밀어 넣는다. 연동 점검 전용.
 *
 * 왜 필요한가:
 *   실제 수강료는 27만원이다. 배선이 맞는지 확인하려고 그 금액을 긁어 볼 수는 없다.
 *   그렇다고 결제 없이 확인할 수도 없다 — SDK 결제창이 실제로 뜨고 카드가 승인되는
 *   구간이 바로 지금 고장난 구간이기 때문이다. 그래서 금액만 100원으로 낮춘
 *   진짜 결제 경로를 따로 연다.
 *
 * 안전장치 네 겹:
 *   1) 학생 태블릿 UI 에는 이 경로가 전혀 노출되지 않는다 (원장 화면에서만 호출).
 *   2) authGuard + roleGuard("owner","superadmin") — 강사도 못 부른다.
 *   3) TOSS_FRONT_TEST_PAYMENT=on 환경변수가 없으면 403. 점검이 끝나면 끄면 된다.
 *   4) 금액은 서버가 100원으로 못박는다. 요청 바디로 금액을 받지 않는다.
 *
 * 회계 오염 방지:
 *   paymentMonth 를 "TEST-YYYYMMDD" 로 박는다. 실제 청구월("2026-08") 과 절대
 *   겹치지 않으므로 미납 계산·월별 집계에 섞이지 않는다. 승인되면 payments 에
 *   100원 행이 남지만 청구월로 즉시 식별·삭제할 수 있다.
 */
const TEST_PAYMENT_AMOUNT = 100;

const testPaymentBodySchema = z.object({
  // 어떤 등록에 붙일지. payment_intents 의 student_id·enrollment_id 가 NOT NULL FK 라
  // 실재하는 등록 하나가 반드시 필요하다. 금액은 여기서 받지 않는다.
  enrollmentId: z.string().uuid(),
  tossDeviceId: z.string().uuid().optional(),
});

/**
 * 100원 테스트를 걸 대상 고르기.
 *
 * 테스트 결제도 payment_intents 에 학생·수강등록을 붙여야 한다 (스키마상 NOT NULL).
 * 그렇다고 원장에게 UUID 를 손으로 넣으라고 할 수는 없으니, 활성 수강 등록을
 * 이름과 함께 내려 준다. 조회 전용이고 금액은 서버가 100원으로 고정하므로
 * 이 목록으로 실결제를 일으킬 방법은 없다.
 */
router.get(
  "/admin/test-payment/candidates",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.json([]);
    const rows = await db
      .select({
        enrollmentId: enrollments.id,
        studentName: students.name,
        className: classes.name,
      })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .leftJoin(classes, eq(classes.id, enrollments.classId))
      .where(and(eq(enrollments.tenantId, tenantId), eq(enrollments.isActive, true)))
      .orderBy(students.name)
      .limit(300);
    return res.json(rows);
  }
);

router.post(
  "/admin/test-payment",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    if (process.env.TOSS_FRONT_TEST_PAYMENT !== "on") {
      return res.status(403).json({
        error: "테스트 결제가 비활성화되어 있습니다. Railway 에 TOSS_FRONT_TEST_PAYMENT=on 을 설정하세요.",
      });
    }
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.status(403).json({ error: "테넌트가 없습니다." });

    const parsed = testPaymentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }

    // 등록·학생이 이 학원 소속인지 확인
    const [enr] = await db
      .select({
        id: enrollments.id,
        studentId: enrollments.studentId,
        studentName: students.name,
        className: classes.name,
      })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .leftJoin(classes, eq(classes.id, enrollments.classId))
      .where(and(eq(enrollments.id, parsed.data.enrollmentId), eq(enrollments.tenantId, tenantId)));
    if (!enr) return res.status(404).json({ error: "이 학원의 수강 등록을 찾을 수 없습니다." });

    // 대상 단말기 결정
    let tossDeviceId = parsed.data.tossDeviceId;
    if (!tossDeviceId) {
      const [anyDevice] = await db
        .select({ id: tossFrontDevices.id })
        .from(tossFrontDevices)
        .where(and(eq(tossFrontDevices.tenantId, tenantId), eq(tossFrontDevices.isActive, true)))
        .orderBy(desc(tossFrontDevices.lastSeenAt))
        .limit(1);
      if (!anyDevice) return res.status(409).json({ error: "활성 결제 단말기가 없습니다." });
      tossDeviceId = anyDevice.id;
    }

    // 단말기가 이미 다른 결제를 붙들고 있으면 거절 (실결제와 겹치면 안 된다)
    const openStates: PaymentDispatchStatus[] = ["PENDING", "DELIVERED"];
    const [busy] = await db
      .select({ id: paymentDispatches.id })
      .from(paymentDispatches)
      .where(
        and(
          eq(paymentDispatches.tossDeviceId, tossDeviceId),
          inArray(paymentDispatches.status, openStates)
        )
      )
      .limit(1);
    if (busy) return res.status(409).json({ error: "이 단말기가 다른 결제를 처리 중입니다." });

    const now = new Date();
    const stamp =
      now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, "0") +
      String(now.getDate()).padStart(2, "0");
    const paymentKey = "tf_" + crypto.randomBytes(16).toString("hex");
    const orderId = `TF-TEST-${stamp}-${crypto.randomBytes(4).toString("hex")}`;
    const orderName = `[연동테스트] ${enr.studentName} · ${TEST_PAYMENT_AMOUNT}원`;
    const paymentMonth = `TEST-${stamp}`;
    const expiresAt = new Date(Date.now() + 3 * 60 * 1000);

    const created = await db.transaction(async (tx) => {
      const [intent] = await tx
        .insert(paymentIntents)
        .values({
          tenantId,
          paymentKey,
          studentId: enr.studentId,
          enrollmentId: enr.id,
          paymentMonth,
          deviceId: tossDeviceId!,
          amount: TEST_PAYMENT_AMOUNT,
          tax: 0,
          supplyValue: TEST_PAYMENT_AMOUNT,
          taxExemptValue: 0,
          status: "CREATED",
          expiresAt,
        })
        .returning();

      const [disp] = await tx
        .insert(paymentDispatches)
        .values({
          tenantId,
          paymentKey,
          intentId: intent.id,
          kioskDeviceId: null,
          tossDeviceId: tossDeviceId!,
          amount: TEST_PAYMENT_AMOUNT,
          orderId,
          orderName,
          status: "PENDING",
          expiresAt,
        })
        .returning();
      return disp;
    });

    publish(tossDeviceId, "payment.dispatch", {
      dispatchId: created.id,
      paymentKey,
      orderId,
      orderName,
      amount: TEST_PAYMENT_AMOUNT,
      expiresAt,
    });

    console.log(
      `🧪 [toss-front] 테스트 결제 생성: ${TEST_PAYMENT_AMOUNT}원 dispatch=${created.id} device=${tossDeviceId}`
    );

    return res.status(201).json({
      dispatchId: created.id,
      paymentKey,
      orderId,
      amount: TEST_PAYMENT_AMOUNT,
      paymentMonth,
      expiresAt,
      notice:
        "단말기에 100원 결제창이 뜹니다. 승인되면 payments 에 청구월 " +
        paymentMonth +
        " 로 기록되며, 실제 월별 미납 계산에는 영향을 주지 않습니다.",
    });
  }
);

export default router;
