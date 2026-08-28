/**
 * 결제 단말기 모드 dispatch 라우터.
 *
 * 두 가지 대상:
 *   - 태블릿(kioskGuard): 결제요청 생성·상태 조회·취소
 *   - 프론트(deviceGuard): SSE 구독·폴백 폴링·결과 업로드
 *
 * dispatch와 payment_intent는 1:1로 만들어진다. dispatch는 태블릿↔프론트 라우팅
 * 관점의 상태를, payment_intent는 결제(paymentKey) 관점의 상태를 기록한다.
 * 프론트가 confirm까지 성공하면 payments.ts의 confirm handler가 intent를 APPROVED로
 * 바꾸고, 여기 result 엔드포인트가 dispatch를 APPROVED로 마감한다.
 *
 * 만료 정리:
 *   앱 부팅 시 30초 주기로 expiresAt < now 인 PENDING/DELIVERED를 TIMEOUT으로 바꾼다.
 *   짧은 TTL(3분)이라 배치 부담 없음.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  paymentIntents,
  paymentDispatches,
  tossFrontDevices,
  kioskDevices,
  payments,
  enrollments,
  classes,
  type PaymentDispatchStatus,
  type PaymentIntentStatus,
} from "@shared/schema";
import { kioskGuard } from "./kioskAuth";
import { deviceGuard } from "./deviceAuth";
import { verifyVirtualInvoice } from "./virtualInvoice";
import { publish, subscribe } from "./dispatchBus";

/**
 * 라우터를 두 개로 분리한 이유 (2026-08 버그 수정):
 *
 *   예전엔 router 하나에 태블릿 경로를 "/kiosk/dispatch" 로 적어 두고
 *   app.use("/api/toss-kiosk", router) 로 마운트했다. 그 결과 실제 경로가
 *   "/api/toss-kiosk/kiosk/dispatch" 가 되어 버렸는데, 태블릿(StudentKiosk.tsx)은
 *   "/api/toss-kiosk/dispatch" 를 호출했다. 아무 라우트에도 걸리지 않으니
 *   server/index.ts 의 /api 폴백이 "존재하지 않는 API 경로입니다." 를 돌려줬고,
 *   학생 화면에는 미납 목록이 잘 보이는데 결제 버튼만 빨간 오류가 났다.
 *
 *   같은 router 를 /api/toss-front 에도 마운트하고 있어서 kioskGuard 경로가
 *   프론트 프리픽스로도 노출됐다. 인증 미들웨어가 서로 다른 두 그룹이 한 라우터에
 *   섞여 있으면 이런 사고가 반복된다. 그래서 파일 안에서 아예 갈라 둔다.
 *
 *   - kioskDispatchRouter → app.use("/api/toss-kiosk", ...) 로만 마운트
 *   - frontDispatchRouter → app.use("/api/toss-front", ...) 로만 마운트
 *
 *   두 라우터 모두 경로에 프리픽스를 중복해서 적지 않는다.
 */
export const kioskDispatchRouter = Router();
export const frontDispatchRouter = Router();

// 결제 단말기 모드 TTL: 3분. 결제하기를 누른 뒤 3분 안에 프론트에서 승인·취소·타임아웃 중 하나로 마감.
const DISPATCH_TTL_MS = 3 * 60 * 1000;

function generatePaymentKey(): string {
  return "tf_" + crypto.randomBytes(16).toString("hex");
}

/**
 * 32-bit signed CRC-like 해시. pg_advisory_xact_lock(int, int) 키 생성용.
 * 충돌해도 잘못된 결과가 나오는 게 아니라 서로 관련 없는 두 요청이 잠깐 직렬화될 뿐이라
 * 완벽할 필요가 없어 SHA-256 앞 4 바이트를 그대로 int32 로 해석한다.
 */
function crc32(input: string): number {
  const buf = crypto.createHash("sha256").update(input).digest();
  // int32 signed 로 해석 (pg advisory lock 키가 signed 4-byte 두 개).
  return buf.readInt32BE(0);
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

// ─────────────────────────────────────────────────────────────────────────
// 태블릿용 (kioskGuard)
// ─────────────────────────────────────────────────────────────────────────

const dispatchBodySchema = z.object({
  invoiceToken: z.string().min(1),
  // 부분결제(=선납/분납) 지원: 태블릿이 원하는 결제 금액을 함께 보낸다.
  //   - 없으면 청구서 금액(=발급 시점 잔액) 전액으로 진행 (기존 동작)
  //   - 있으면 서버가 DB 를 다시 봐서 실제 잔액을 계산하고 0 < 요청금액 ≤ 실제잔액 인 경우만 승인
  requestedAmount: z.number().int().positive().optional(),
});

/**
 * POST /api/toss-kiosk/dispatch
 * 태블릿이 결제하기를 누르면 호출. paymentIntent + payment_dispatch를 만들고 프론트에 push.
 *
 * 금액 확정 원칙 (0.3.2~):
 *   프론트가 보낸 requestedAmount 를 절대 그대로 믿지 않는다. 아래 두 상한을 모두 만족해야 한다.
 *     1) invoiceToken 서명값(amount) — 발급 시점의 잔액 상한. 토큰 위조 방지.
 *     2) 트랜잭션 안에서 DB payments SUM 을 다시 조회한 "지금 이 순간의 실제 잔액".
 *   같은 (enrollment, month) 에 대해 미마감 intent 가 이미 있으면 새 dispatch 를 거절해
 *   두 태블릿이 동시에 초과 결제를 만드는 케이스를 막는다.
 */
kioskDispatchRouter.post("/dispatch", kioskGuard, async (req: Request, res: Response) => {
  const parsed = dispatchBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });

  const invoice = verifyVirtualInvoice(parsed.data.invoiceToken);
  if (!invoice) return res.status(400).json({ error: "청구서 토큰이 만료되었거나 유효하지 않습니다." });

  const kiosk = req.kiosk!;
  if (invoice.tenantId !== kiosk.tenantId) {
    return res.status(403).json({ error: "다른 학원의 청구서입니다." });
  }
  if (invoice.amount <= 0) return res.status(400).json({ error: "결제 금액이 0원 이하입니다." });

  // 태블릿이 지정한 요청 금액 상한 (없으면 청구서 전액)
  const requestedAmount = parsed.data.requestedAmount ?? invoice.amount;
  if (requestedAmount > invoice.amount) {
    return res.status(400).json({ error: "요청 금액이 청구서 잔액보다 큽니다." });
  }

  // 라우팅 대상 프론트 결정
  let tossDeviceId = kiosk.pairedFrontDeviceId;
  if (!tossDeviceId) {
    const [any] = await db
      .select({ id: tossFrontDevices.id })
      .from(tossFrontDevices)
      .where(and(eq(tossFrontDevices.tenantId, kiosk.tenantId), eq(tossFrontDevices.isActive, true)))
      .orderBy(desc(tossFrontDevices.lastSeenAt))
      .limit(1);
    if (!any) {
      return res.status(409).json({ error: "활성 프론트 단말기가 없습니다. 원장에게 문의하세요." });
    }
    tossDeviceId = any.id;
  }

  // 동시 결제 잠금: 이 프론트에 아직 마감되지 않은 dispatch가 있으면 409
  const openDispatchStates: PaymentDispatchStatus[] = ["PENDING", "DELIVERED"];
  const [busy] = await db
    .select({ id: paymentDispatches.id })
    .from(paymentDispatches)
    .where(
      and(
        eq(paymentDispatches.tossDeviceId, tossDeviceId),
        inArray(paymentDispatches.status, openDispatchStates)
      )
    )
    .limit(1);
  if (busy) {
    return res.status(409).json({ error: "이 결제 단말기가 다른 결제를 처리 중입니다." });
  }

  const paymentKey = generatePaymentKey();
  const orderId = generateOrderId();
  const expiresAt = new Date(Date.now() + DISPATCH_TTL_MS);

  // 트랜잭션 밖으로 검증 실패를 전달하기 위한 신호. 트랜잭션은 throw 되어야 롤백되기 때문에
  // 사용자 오류는 아래 클래스로 감싸서 던지고 catch 에서 HTTP 응답으로 바꾼다.
  class DispatchReject extends Error {
    constructor(public httpStatus: number, message: string) {
      super(message);
    }
  }

  try {
    const built = await db.transaction(async (tx) => {
      // (0) pg advisory lock — 같은 (enrollment, month) 에 대한 동시 요청을 직렬화.
      //   테이블 DDL 을 건드리지 않고 race 를 막는 표준 트릭. 트랜잭션 종료 시 자동 해제.
      //   두 32-bit 해시로 pg_advisory_xact_lock(int, int) 를 사용한다.
      const lockKeyA = crc32(invoice.enrollmentId);
      const lockKeyB = crc32(invoice.paymentMonth);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKeyA}, ${lockKeyB})`);

      // (A) 등록 확인 + tuition 재조회
      const [enrollRow] = await tx
        .select({
          enrollment: enrollments,
          defaultTuition: classes.defaultTuition,
        })
        .from(enrollments)
        .innerJoin(classes, eq(enrollments.classId, classes.id))
        .where(
          and(
            eq(enrollments.id, invoice.enrollmentId),
            eq(enrollments.tenantId, invoice.tenantId)
          )
        );
      if (!enrollRow) throw new DispatchReject(404, "수강 등록을 찾을 수 없습니다.");
      const tuition = enrollRow.enrollment.tuition ?? enrollRow.defaultTuition;
      if (!tuition || tuition <= 0) {
        throw new DispatchReject(409, "이 반의 수강료가 설정돼 있지 않습니다.");
      }

      // (B) 같은 (enrollment, month) 에 미마감 intent 존재 시 거절 (동시 결제 방지)
      const openIntentStates: PaymentIntentStatus[] = ["CREATED", "PROCESSING"];
      const [openIntent] = await tx
        .select({ id: paymentIntents.id })
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.enrollmentId, invoice.enrollmentId),
            eq(paymentIntents.paymentMonth, invoice.paymentMonth),
            eq(paymentIntents.tenantId, invoice.tenantId),
            inArray(paymentIntents.status, openIntentStates)
          )
        )
        .limit(1);
      if (openIntent) {
        throw new DispatchReject(409, "이 수강월에 대해 처리 중인 결제가 있습니다. 완료 후 다시 시도하세요.");
      }

      // (C) DB 잔액 재계산 (payments 부호 규칙: 원비 양수, 환불 음수)
      const paidRows = await tx
        .select({ amount: payments.amount })
        .from(payments)
        .where(
          and(
            eq(payments.enrollmentId, invoice.enrollmentId),
            eq(payments.paymentMonth, invoice.paymentMonth),
            eq(payments.tenantId, invoice.tenantId)
          )
        );
      const paidSoFar = paidRows.reduce((s, r) => s + r.amount, 0);
      const actualRemaining = tuition - paidSoFar;
      if (actualRemaining <= 0) throw new DispatchReject(409, "이 수강월은 이미 완납되었습니다.");
      if (requestedAmount > actualRemaining) {
        throw new DispatchReject(
          409,
          `요청 금액이 실제 잔액을 초과합니다. (실제 잔액: ${actualRemaining.toLocaleString()}원)`
        );
      }

      // (D) intent + dispatch 생성
      const finalAmount = requestedAmount;
      const orderName = `${invoice.studentName} · ${invoice.className} · ${invoice.paymentMonth}${
        finalAmount < actualRemaining ? " (부분결제)" : ""
      }`;

      const [intent] = await tx
        .insert(paymentIntents)
        .values({
          tenantId: invoice.tenantId,
          paymentKey,
          studentId: invoice.studentId,
          enrollmentId: invoice.enrollmentId,
          paymentMonth: invoice.paymentMonth,
          deviceId: tossDeviceId,
          amount: finalAmount,
          tax: 0,
          supplyValue: finalAmount,
          taxExemptValue: 0,
          status: "CREATED",
          expiresAt,
        })
        .returning();

      const [disp] = await tx
        .insert(paymentDispatches)
        .values({
          tenantId: invoice.tenantId,
          paymentKey,
          intentId: intent.id,
          kioskDeviceId: kiosk.id,
          tossDeviceId: tossDeviceId!,
          amount: finalAmount,
          orderId,
          orderName,
          status: "PENDING",
          expiresAt,
        })
        .returning();

      return { intent, disp, orderName, finalAmount };
    });

    const pushPayload = {
      dispatchId: built.disp.id,
      paymentKey,
      orderId,
      orderName: built.orderName,
      amount: built.finalAmount,
      studentName: invoice.studentName,
      className: invoice.className,
      paymentMonth: invoice.paymentMonth,
      expiresAt,
    };

    // 프론트가 지금 SSE에 붙어 있으면 즉시 push. 안 붙어 있으면 폴백 폴링이 30초 안에 잡아 감.
    publish(tossDeviceId, "payment.dispatch", pushPayload);

    return res.status(201).json({
      dispatchId: built.disp.id,
      paymentKey,
      orderId,
      amount: built.finalAmount,
      expiresAt,
      tossDeviceId,
    });
  } catch (err: any) {
    if (err instanceof DispatchReject) {
      return res.status(err.httpStatus).json({ error: err.message });
    }
    if (err?.code === "23505") {
      return res.status(409).json({ error: "결제 요청이 중복되었습니다." });
    }
    throw err;
  }
});

/** GET /api/toss-kiosk/dispatch/:id — 태블릿이 자기 결제 상태를 1.5초 주기로 폴링 */
kioskDispatchRouter.get("/dispatch/:id", kioskGuard, async (req: Request, res: Response) => {
  const kiosk = req.kiosk!;
  const [row] = await db
    .select()
    .from(paymentDispatches)
    .where(and(eq(paymentDispatches.id, req.params.id), eq(paymentDispatches.tenantId, kiosk.tenantId)));
  if (!row) return res.status(404).json({ error: "결제 요청을 찾을 수 없습니다." });
  if (row.kioskDeviceId !== kiosk.id) {
    // 다른 태블릿에서 만든 요청 조회 금지
    return res.status(403).json({ error: "다른 태블릿의 결제입니다." });
  }
  return res.json({
    id: row.id,
    status: row.status,
    amount: row.amount,
    paymentKey: row.paymentKey,
    deliveredAt: row.deliveredAt,
    respondedAt: row.respondedAt,
    expiresAt: row.expiresAt,
    failureReason: row.failureReason,
  });
});

/** POST /api/toss-kiosk/dispatch/:id/cancel — 태블릿에서 사용자가 취소를 눌렀을 때 */
kioskDispatchRouter.post("/dispatch/:id/cancel", kioskGuard, async (req: Request, res: Response) => {
  const kiosk = req.kiosk!;
  const openStates: PaymentDispatchStatus[] = ["PENDING", "DELIVERED"];
  const result = await db
    .update(paymentDispatches)
    .set({ status: "CANCELED", respondedAt: new Date(), failureReason: "kiosk cancelled" })
    .where(
      and(
        eq(paymentDispatches.id, req.params.id),
        eq(paymentDispatches.kioskDeviceId, kiosk.id),
        inArray(paymentDispatches.status, openStates)
      )
    )
    .returning({ id: paymentDispatches.id, tossDeviceId: paymentDispatches.tossDeviceId });
  if (result.length === 0) return res.status(409).json({ error: "취소할 수 없는 상태입니다." });

  publish(result[0].tossDeviceId, "payment.canceled", { dispatchId: result[0].id });
  return res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────
// 프론트용 (deviceGuard)
// ─────────────────────────────────────────────────────────────────────────

/**
 * GET /dispatch/stream — 프론트 플러그인의 SSE 구독.
 *
 * 브라우저의 EventSource는 Authorization 헤더를 보낼 수 없기 때문에, 프론트는 SSE 대신
 * 서버 fetch로 스트림을 열거나 (fetch+ReadableStream), accessToken을 쿼리 파라미터로 보내야 한다.
 * 여기선 SDK 환경(EventSource 대체 fetch)을 가정해 Authorization 헤더 방식 유지.
 * 만약 EventSource만 가능한 환경이면 accessToken 쿼리를 허용해야 하지만, 로그 유출 위험 때문에
 * 지금은 헤더 방식만 지원한다.
 */
frontDispatchRouter.get("/dispatch/stream", deviceGuard, async (req: Request, res: Response) => {
  const device = req.device!;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx·프록시 버퍼링 비활성화
  res.flushHeaders?.();

  // 헬로 이벤트로 즉시 응답, 이 프론트에 이미 대기 중인 PENDING을 함께 보낸다.
  res.write(`event: hello\ndata: ${JSON.stringify({ deviceId: device.id, at: Date.now() })}\n\n`);

  const pending = await db
    .select()
    .from(paymentDispatches)
    .where(
      and(
        eq(paymentDispatches.tossDeviceId, device.id),
        eq(paymentDispatches.status, "PENDING")
      )
    )
    .orderBy(paymentDispatches.createdAt);
  for (const p of pending) {
    res.write(
      `event: payment.dispatch\ndata: ${JSON.stringify({
        dispatchId: p.id,
        paymentKey: p.paymentKey,
        orderId: p.orderId,
        orderName: p.orderName,
        amount: p.amount,
        expiresAt: p.expiresAt,
      })}\n\n`
    );
  }

  subscribe(device.id, res);
});

/**
 * GET /dispatch/pending — 1초 주기 폴링 진입점 (결제 단말기 모드의 기본 통신 채널).
 *
 * 반환 형태 { pending: {...} | null } — 프론트가 즉시 sdk.payment.requestPayment 에
 * 필요한 필드를 그대로 갖도록 정규화한다. status='PENDING' 만 픽업 (DELIVERED 는 이미 다른
 * 폴링 사이클이 잡아 결제창까지 띄운 것이므로 재진입 금지).
 */
frontDispatchRouter.get("/dispatch/pending", deviceGuard, async (req: Request, res: Response) => {
  const device = req.device!;
  // paymentIntents 와 JOIN 해서 tax/supplyValue/taxExemptValue 를 함께 돌려준다.
  // 플러그인이 SDK 에 넘길 세금·공급가·비과세 값은 서버가 확정한 값만 신뢰한다 (프론트 계산 금지).
  const [row] = await db
    .select({
      dispatchId: paymentDispatches.id,
      paymentKey: paymentDispatches.paymentKey,
      orderId: paymentDispatches.orderId,
      orderName: paymentDispatches.orderName,
      amount: paymentDispatches.amount,
      status: paymentDispatches.status,
      deviceId: paymentDispatches.tossDeviceId,
      createdAt: paymentDispatches.createdAt,
      expiresAt: paymentDispatches.expiresAt,
      tax: paymentIntents.tax,
      supplyValue: paymentIntents.supplyValue,
      taxExemptValue: paymentIntents.taxExemptValue,
    })
    .from(paymentDispatches)
    .innerJoin(paymentIntents, eq(paymentDispatches.intentId, paymentIntents.id))
    .where(
      and(
        eq(paymentDispatches.tossDeviceId, device.id),
        eq(paymentDispatches.status, "PENDING")
      )
    )
    .orderBy(paymentDispatches.createdAt)
    .limit(1);
  if (!row) return res.json({ pending: null });
  return res.json({
    pending: {
      // dispatchId 는 서버 내부 라우팅 키, requestId 는 플러그인이 SDK 결과 통지 시 사용할 상관관계 ID.
      // 현재 스키마에선 둘이 같은 값을 갖지만 이름을 분리해 두면 나중에 별도 요청식별자를 도입할 여지가 있다.
      requestId: row.dispatchId,
      dispatchId: row.dispatchId,
      paymentKey: row.paymentKey,
      orderId: row.orderId,
      orderName: row.orderName,
      amount: row.amount,
      tax: row.tax,
      supplyValue: row.supplyValue,
      taxExemptValue: row.taxExemptValue,
      // tip 은 아직 학원 결제 흐름에 없다. 항상 0 을 명시적으로 내려 준다 (SDK 필수 필드).
      tip: 0,
      status: row.status,
      deviceId: row.deviceId,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    },
  });
});

/**
 * POST /dispatch/:id/ack — 프론트가 dispatch를 수신했음을 확정. DELIVERED로 표시.
 *
 * 여기서 intent도 CREATED → PROCESSING 으로 함께 올린다. 이 전이가 없으면
 * intent 는 결제창이 떠 있는 내내 CREATED 로 남아, 관리자 화면에서 "아직 아무도
 * 집어가지 않은 요청"과 "지금 카드 꽂는 중"이 구분되지 않았다. 상태 기계는
 * CREATED → PROCESSING → APPROVED/CANCELED/TIMEOUT/FAILED 로 한 방향이다.
 *
 * PENDING → DELIVERED 갱신 자체가 조건부 UPDATE 라 두 단말기가 동시에 ack 해도
 * 한 쪽만 1행을 얻는다. 이게 dispatch 를 집어가는 claim(선점) 역할을 한다.
 */
frontDispatchRouter.post("/dispatch/:id/ack", deviceGuard, async (req: Request, res: Response) => {
  const device = req.device!;
  const result = await db
    .update(paymentDispatches)
    .set({ status: "DELIVERED", deliveredAt: new Date() })
    .where(
      and(
        eq(paymentDispatches.id, req.params.id),
        eq(paymentDispatches.tossDeviceId, device.id),
        eq(paymentDispatches.status, "PENDING")
      )
    )
    .returning({ id: paymentDispatches.id, paymentKey: paymentDispatches.paymentKey });
  if (result.length === 0) return res.status(409).json({ error: "이 dispatch는 PENDING 상태가 아닙니다." });

  await db
    .update(paymentIntents)
    .set({ status: "PROCESSING" })
    .where(
      and(
        eq(paymentIntents.paymentKey, result[0].paymentKey),
        eq(paymentIntents.tenantId, device.tenantId),
        eq(paymentIntents.status, "CREATED")
      )
    );

  return res.json({ ok: true });
});

/**
 * POST /dispatch/:id/result — 프론트가 결제 결과를 업로드.
 *
 * status가 APPROVED면 payments.ts의 /payments/confirm으로 이미 결제 확정이 되었어야 한다.
 * 여기서는 dispatch만 마감. 두 흐름을 분리한 이유: 승인 결과 저장(FOR UPDATE 트랜잭션)과
 * 태블릿에 완료 신호(dispatch 상태)를 분리해 실패 반경을 좁힌다.
 *
 * TIMEOUT·CANCELED·FAILED는 여기서 dispatch만 마감.
 */
const resultBodySchema = z.object({
  status: z.enum(["APPROVED", "CANCELED", "TIMEOUT", "FAILED"]),
  // 플러그인은 reason 을 보내고 서버는 failureReason 필드에 저장한다.
  // 두 이름을 모두 받아 하위 호환을 유지.
  reason: z.string().max(300).optional(),
  failureReason: z.string().max(300).optional(),
});

frontDispatchRouter.post("/dispatch/:id/result", deviceGuard, async (req: Request, res: Response) => {
  const parsed = resultBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const device = req.device!;

  const openStates: PaymentDispatchStatus[] = ["PENDING", "DELIVERED"];
  const reason = parsed.data.failureReason ?? parsed.data.reason ?? null;
  const result = await db
    .update(paymentDispatches)
    .set({
      status: parsed.data.status,
      respondedAt: new Date(),
      failureReason: reason,
    })
    .where(
      and(
        eq(paymentDispatches.id, req.params.id),
        eq(paymentDispatches.tossDeviceId, device.id),
        inArray(paymentDispatches.status, openStates)
      )
    )
    .returning({ id: paymentDispatches.id, paymentKey: paymentDispatches.paymentKey });

  if (result.length === 0) {
    // 이미 마감된 dispatch에 결과가 오면 idempotent success (재전송 대비)
    return res.json({ ok: true, idempotent: true });
  }

  // 승인 실패/취소면 intent도 함께 정리 (APPROVED 인 경우엔 payments.ts confirm이 이미 처리)
  if (parsed.data.status !== "APPROVED") {
    await db
      .update(paymentIntents)
      .set({
        status: parsed.data.status === "TIMEOUT" ? "TIMEOUT" : parsed.data.status === "FAILED" ? "FAILED" : "CANCELED",
        failureReason: reason ?? parsed.data.status,
      })
      .where(and(eq(paymentIntents.paymentKey, result[0].paymentKey), eq(paymentIntents.tenantId, device.tenantId)));
  }

  return res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────
// 만료 정리 배치 (프로세스 부팅 시 시작)
// ─────────────────────────────────────────────────────────────────────────
export function startDispatchExpirySweeper(intervalMs = 30_000) {
  const openStates: PaymentDispatchStatus[] = ["PENDING", "DELIVERED"];
  const tick = async () => {
    try {
      const expired = await db
        .update(paymentDispatches)
        .set({ status: "TIMEOUT", respondedAt: new Date(), failureReason: "expired" })
        .where(
          and(
            inArray(paymentDispatches.status, openStates),
            lt(paymentDispatches.expiresAt, new Date())
          )
        )
        .returning({ id: paymentDispatches.id, paymentKey: paymentDispatches.paymentKey });

      if (expired.length > 0) {
        // 대응 intent도 TIMEOUT으로. paymentKey 리스트를 조건절에.
        await db.execute(sql`
          UPDATE payment_intents
             SET status = 'TIMEOUT', failure_reason = 'dispatch expired', updated_at = CURRENT_TIMESTAMP
           WHERE payment_key = ANY(${expired.map((r) => r.paymentKey)}::text[])
             AND status IN ('CREATED', 'PROCESSING')
        `);
      }
    } catch (err) {
      console.error("dispatch expiry sweeper error:", err);
    }
  };
  const timer = setInterval(tick, intervalMs);
  // 프로세스 종료 시 정리
  process.once("SIGTERM", () => clearInterval(timer));
  process.once("SIGINT", () => clearInterval(timer));
  // 첫 tick은 즉시
  tick();
}
