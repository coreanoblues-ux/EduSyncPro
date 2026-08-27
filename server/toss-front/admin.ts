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
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../db";
import {
  paymentIntents,
  tossWebhookEvents,
  tossFrontDevices,
  students,
  enrollments,
  classes,
} from "@shared/schema";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";

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

export default router;
