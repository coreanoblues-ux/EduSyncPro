/**
 * 원장이 웹 화면에서 Toss Front 연동 상태를 감시하는 API.
 *
 * 여기서 반환하는 데이터는 순수 조회 전용이다. 승인·취소 같은 상태 변경은
 * 사람이 관리자 화면에서 클릭하는 흐름을 원장에게 열어 두지 않는다. 이유:
 *   결제 승인은 SDK 응답과 웹훅으로만 확정돼야 데이터가 한 갈래로 흐르고,
 *   중간에 사람이 손대는 경로가 열리면 대사가 어긋난다. 관리자 화면은 오직
 *   "지금 어디에 어긋난 게 있나"를 원장이 알아채는 창구다.
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
  type PaymentDispatchStatus,
} from "@shared/schema";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";
import { publish } from "./dispatchBus";

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
