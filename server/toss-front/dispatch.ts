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
} from "@shared/schema";
import { kioskGuard } from "./kioskAuth";
import { deviceGuard } from "./deviceAuth";
import {
  OPEN_DISPATCH_STATES,
  OPEN_INTENT_STATES,
  isBlocking,
  secondsUntilFree,
} from "./lifecycle";
import { verifyVirtualInvoice } from "./virtualInvoice";
import { normalizeInstallment } from "@shared/installment";
import { todayKst } from "@shared/day";
import { CUSTOM_MAX_AMOUNT, sanitizeCustomLabel } from "@shared/customPayment";
import { publish, subscribe } from "./dispatchBus";
import { selectRecoveryKeys, type RecoveryCandidate } from "./recovery";
import { pendingCancelForDevice } from "./cardCancelRoutes";

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
  // 카드 할부 개월 (0 = 일시불). 없으면 일시불 — 기존 태블릿이 이 필드를 안 보내도
  // 동작이 한 톨도 바뀌지 않는다. 값 검증은 여기서 형식만 보고, 실제 정책
  // (5만원 이상, 허용 개월수)은 아래 트랜잭션에서 확정 금액으로 다시 판정한다.
  // 지금 판정하면 안 되는 이유: 이 시점의 requestedAmount 는 아직 상한 검사를
  // 통과하지 않은 희망사항이고, 최종 금액은 DB 잔액을 본 뒤에야 정해진다.
  installment: z.number().int().min(0).max(12).optional(),
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

  // 동시 결제 잠금: 이 프론트에 "아직 살아 있는" dispatch가 있으면 409.
  //
  // ── expiresAt > now 조건이 반드시 있어야 하는 이유 (2026-08-29 현장 사고) ──
  //   예전엔 status 만 봤다. 그런데 status 를 마감으로 바꾸는 주체는 단말기(result)와
  //   30초 배치(sweeper) 둘뿐이다. 단말기가 응답 없이 꺼지고 배치가 한 번이라도 실패하면
  //   PENDING 행이 영원히 남아 그 단말기의 모든 결제를 막는다. 실제로 어제 실패한 시도가
  //   오늘 온 학생의 결제를 막아 "진행중인 결제가 있습니다" 만 반복해서 떴다.
  //
  //   시간을 조건에 넣으면 정리 배치가 죽어 있어도 TTL(3분)이 지나는 순간 스스로 풀린다.
  //   status 정리는 기록을 위한 것이고, 차단 여부는 시간이 판단한다. 이 둘을 분리한다.
  //   차단 여부의 최종 판단은 SQL 이 아니라 isBlocking() 이 한다. 가장 늦게 만료되는
  //   행 하나만 가져오면 충분하다 — 그것도 살아 있지 않다면 나머지는 볼 것도 없다.
  //   (판단을 순수 함수로 옮겨야 테스트가 가능하다. lifecycle.ts 참고)
  const [newestOpen] = await db
    .select({ id: paymentDispatches.id, status: paymentDispatches.status, expiresAt: paymentDispatches.expiresAt })
    .from(paymentDispatches)
    .where(
      and(
        eq(paymentDispatches.tossDeviceId, tossDeviceId),
        inArray(paymentDispatches.status, OPEN_DISPATCH_STATES)
      )
    )
    .orderBy(desc(paymentDispatches.expiresAt))
    .limit(1);
  if (newestOpen && isBlocking(newestOpen.status, newestOpen.expiresAt)) {
    // 몇 초 뒤에 다시 시도하면 되는지까지 알려 준다. "처리 중입니다" 만 보면
    // 학부모는 영원히 막힌 건지 잠깐 기다리면 되는 건지 알 수 없다.
    const waitSec = secondsUntilFree(newestOpen.expiresAt);
    return res.status(409).json({
      error: `이 결제 단말기가 다른 결제를 처리 중입니다. ${waitSec}초 후 다시 시도해 주세요.`,
      retryAfterSeconds: waitSec,
    });
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

      // (B) 같은 (enrollment, month) 에 "아직 살아 있는" intent 존재 시 거절 (동시 결제 방지)
      //
      //   위 dispatch 검사와 같은 이유로 expiresAt > now 를 함께 본다. 실패로 끝난 시도는
      //   기록으로만 남고 다음 결제를 방해하면 안 된다. 만료된 CREATED/PROCESSING 은
      //   "처리 중"이 아니라 "버려진 시도"다.
      //
      //   덤으로 여기서 만료된 것들을 TIMEOUT 으로 정리까지 하고 지나간다(lazy expiry).
      //   배치를 기다리지 않고 그 자리에서 장부를 맞춰 두면, 관리자 화면의 상태 목록이
      //   실제와 어긋나 있는 시간이 짧아진다.
      const sameMonth = and(
        eq(paymentIntents.enrollmentId, invoice.enrollmentId),
        eq(paymentIntents.paymentMonth, invoice.paymentMonth),
        eq(paymentIntents.tenantId, invoice.tenantId),
        inArray(paymentIntents.status, OPEN_INTENT_STATES)
      );

      await tx
        .update(paymentIntents)
        .set({ status: "TIMEOUT", failureReason: "expired (lazy sweep at dispatch)" })
        .where(and(sameMonth, lt(paymentIntents.expiresAt, new Date())));

      const [newestIntent] = await tx
        .select({
          id: paymentIntents.id,
          status: paymentIntents.status,
          expiresAt: paymentIntents.expiresAt,
        })
        .from(paymentIntents)
        .where(sameMonth)
        .orderBy(desc(paymentIntents.expiresAt))
        .limit(1);
      if (newestIntent && isBlocking(newestIntent.status, newestIntent.expiresAt)) {
        throw new DispatchReject(
          409,
          `이 수강월은 지금 결제가 진행 중입니다. ${secondsUntilFree(newestIntent.expiresAt)}초 후 다시 시도해 주세요.`
        );
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

      // 할부는 **확정된 금액**으로 판정한다. 태블릿이 27만원을 보고 3개월을 골랐어도
      // 실제 승인 금액이 4만원으로 깎였다면 그건 일시불이어야 한다 (카드업계 관행상
      // 5만원 미만은 할부가 안 된다). 화면에서 이미 막지만 여기서 다시 부르는 이유는,
      // 태블릿이 보낸 값을 그대로 단말기까지 흘려보내면 학부모가 카드를 댄 채로
      // 영문 모를 거절을 보게 되기 때문이다. 정책 판정은 shared/installment.ts 한 벌만 쓴다.
      const installment = normalizeInstallment(parsed.data.installment, finalAmount);
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
          // 요청값이다. 승인된 개월수는 단말기 응답에서 따로 받아
          // toss_payment_transactions.installment 에 저장한다 (예전부터 그랬다).
          requestedInstallment: installment,
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

      return { intent, disp, orderName, finalAmount, installment };
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
      // 태블릿이 "3개월 할부로 요청됨" 을 화면에 다시 보여 줄 수 있도록 돌려준다.
      // 서버가 정규화한 뒤의 값이라, 태블릿이 보낸 것과 다를 수 있다 (예: 금액이
      // 5만원 미만으로 깎여 일시불로 내려간 경우). 화면은 이 값을 믿어야 한다.
      installment: built.installment,
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

// ─────────────────────────────────────────────────────────────────────────
// 기타 결제 (학생과 연결되지 않은 결제) — 태블릿에서 금액을 직접 입력한다
// ─────────────────────────────────────────────────────────────────────────

const customDispatchBodySchema = z.object({
  // 청구서 토큰이 없다. 이 결제에는 근거가 될 등록이 아예 없기 때문이다.
  // 대신 금액은 태블릿이 보낸 값을 그대로 쓴다 — 여기서만 예외인 이유는 아래 헤더 참고.
  amount: z.number().int().positive().max(CUSTOM_MAX_AMOUNT),
  label: z.string().max(60).optional(),
  installment: z.number().int().min(0).max(12).optional(),
});

/**
 * POST /api/toss-kiosk/dispatch/custom
 * 학원 웹앱에 학생으로 등록되지 않은 건(아직 등록 전인 학생, 교재·자료 판매 등)을
 * 태블릿에서 금액을 입력해 바로 결제 요청한다.
 *
 * ── 왜 기존 /dispatch 를 고치지 않고 새로 만드나 ──
 *   기존 핸들러가 하는 일의 대부분이 "등록(enrollment)이 있다" 는 전제 위에 서 있다.
 *     · (0) enrollmentId 로 어드바이저리 잠금
 *     · (A) 반 수강료 조회 — 없으면 거절
 *     · (B) 같은 (등록, 수강월) 미마감 intent 있으면 거절
 *     · (C) 잔액 재계산 — 초과분 거절, 완납이면 거절
 *   기타 결제에는 넷 다 걸 근거가 없다. 특히 (B)(C)는 **틀린 이유로 거절한다** —
 *   같은 달에 자료를 두 번 팔면 두 번째가 막히고, 잔액이랄 게 없으니 늘 완납이다.
 *   그래서 조건문을 덧대는 대신 흐름을 따로 둔다. 잘 돌고 있는 학생 결제 경로는
 *   이 파일에서 한 줄도 바뀌지 않는다.
 *
 * ── 금액을 왜 믿나 (학생 결제에서는 절대 안 믿는 그 값을) ──
 *   학생 결제의 금액은 "청구서에 적힌 잔액" 이라는 서버가 아는 사실이 있어서,
 *   태블릿이 보낸 값은 검증 대상이다. 기타 결제에는 대조할 사실이 서버에 없다.
 *   금액을 정하는 주체가 사람(태블릿 앞의 원장)이므로 서버가 할 수 있는 건
 *   형식 검사(양의 정수)와 상한뿐이다. 태블릿은 kioskGuard 로 인증된 학원 소유
 *   기기이고, 결제 자체는 카드 단말기 앞에서 사람이 다시 확인한다.
 *
 * ── 장부 ──
 *   승인되면 payments 에 type="기타" 로 적힌다 (payments.ts confirm). 등록이 없으니
 *   미납 판정·잔액 계산에는 애초에 들어가지 않는다. 환불은 기존 경로 그대로 된다.
 */
kioskDispatchRouter.post("/dispatch/custom", kioskGuard, async (req: Request, res: Response) => {
  const parsed = customDispatchBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "요청 형식이 올바르지 않습니다." });
  }

  const kiosk = req.kiosk!;
  const amount = parsed.data.amount;
  const label = sanitizeCustomLabel(parsed.data.label);

  // 라우팅 대상 프론트 결정 — 학생 결제와 완전히 같은 규칙이다.
  let tossDeviceId = kiosk.pairedFrontDeviceId;
  if (!tossDeviceId) {
    const [anyDevice] = await db
      .select({ id: tossFrontDevices.id })
      .from(tossFrontDevices)
      .where(and(eq(tossFrontDevices.tenantId, kiosk.tenantId), eq(tossFrontDevices.isActive, true)))
      .orderBy(desc(tossFrontDevices.lastSeenAt))
      .limit(1);
    if (!anyDevice) {
      return res.status(409).json({ error: "활성 프론트 단말기가 없습니다. 원장에게 문의하세요." });
    }
    tossDeviceId = anyDevice.id;
  }

  // 단말기 동시 결제 잠금. 시간까지 함께 보는 이유는 위 /dispatch 주석과 같다 —
  // 죽은 요청이 다음 결제를 영원히 막는 사고가 실제로 있었다.
  const [newestOpen] = await db
    .select({
      id: paymentDispatches.id,
      status: paymentDispatches.status,
      expiresAt: paymentDispatches.expiresAt,
    })
    .from(paymentDispatches)
    .where(
      and(
        eq(paymentDispatches.tossDeviceId, tossDeviceId),
        inArray(paymentDispatches.status, OPEN_DISPATCH_STATES)
      )
    )
    .orderBy(desc(paymentDispatches.expiresAt))
    .limit(1);
  if (newestOpen && isBlocking(newestOpen.status, newestOpen.expiresAt)) {
    const waitSec = secondsUntilFree(newestOpen.expiresAt);
    return res.status(409).json({
      error: `이 결제 단말기가 다른 결제를 처리 중입니다. ${waitSec}초 후 다시 시도해 주세요.`,
      retryAfterSeconds: waitSec,
    });
  }

  const paymentKey = generatePaymentKey();
  const orderId = generateOrderId();
  const expiresAt = new Date(Date.now() + DISPATCH_TTL_MS);
  // 수강월이 아니라 "이 돈이 들어온 달". payment_month 는 NOT NULL 이고, 장부·정산
  // 화면이 전부 이 값으로 묶여 있어서 비워 둘 수 없다. 기타 결제에 수강월이라는
  // 개념은 없으므로 한국 시각 기준 현재 달을 적는다.
  const paymentMonth = todayKst().slice(0, 7);
  const installment = normalizeInstallment(parsed.data.installment, amount);
  const orderName = `${label} (기타)`;

  try {
    const built = await db.transaction(async (tx) => {
      const [intent] = await tx
        .insert(paymentIntents)
        .values({
          tenantId: kiosk.tenantId,
          paymentKey,
          // 이 둘이 NULL 인 것이 이 기능의 전부다. "학생을 못 찾았다" 가 아니라
          // "연결할 학생이 없는 결제다" 라는 사실을 그대로 적는다.
          studentId: null,
          enrollmentId: null,
          customLabel: label,
          paymentMonth,
          deviceId: tossDeviceId,
          amount,
          tax: 0,
          supplyValue: amount,
          taxExemptValue: 0,
          requestedInstallment: installment,
          status: "CREATED",
          expiresAt,
        })
        .returning();

      const [disp] = await tx
        .insert(paymentDispatches)
        .values({
          tenantId: kiosk.tenantId,
          paymentKey,
          intentId: intent.id,
          kioskDeviceId: kiosk.id,
          tossDeviceId: tossDeviceId!,
          amount,
          orderId,
          orderName,
          status: "PENDING",
          expiresAt,
        })
        .returning();

      return { intent, disp };
    });

    // 단말기로 가는 통로는 학생 결제와 똑같다. 폴링 응답(/dispatch/pending)은
    // dispatch·intent 행만 보고 만들어지므로 플러그인은 고칠 것이 없다.
    publish(tossDeviceId, "payment.dispatch", {
      dispatchId: built.disp.id,
      paymentKey,
      orderId,
      orderName,
      amount,
      paymentMonth,
      expiresAt,
    });

    return res.status(201).json({
      dispatchId: built.disp.id,
      paymentKey,
      orderId,
      amount,
      installment,
      label,
      expiresAt,
      tossDeviceId,
    });
  } catch (err: any) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: "결제 요청이 중복되었습니다." });
    }
    // 23502 = NOT NULL 위반. 부팅 때 도는 ensureCustomPaymentSchema 가 실패한
    // 서버라면 여기로 온다. 원인을 정확히 말해 주는 게 "알 수 없는 오류" 보다 낫다.
    if (err?.code === "23502") {
      console.error("기타 결제 INSERT 가 NOT NULL 제약에 걸렸습니다 (스키마 준비 실패 가능성):", err);
      return res.status(500).json({
        error: "기타 결제 준비가 아직 끝나지 않았습니다. 서버를 다시 시작한 뒤 시도해 주세요.",
      });
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
  const result = await db
    .update(paymentDispatches)
    .set({ status: "CANCELED", respondedAt: new Date(), failureReason: "kiosk cancelled" })
    .where(
      and(
        eq(paymentDispatches.id, req.params.id),
        eq(paymentDispatches.kioskDeviceId, kiosk.id),
        inArray(paymentDispatches.status, OPEN_DISPATCH_STATES)
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
/**
 * 이 단말기에게 "이거 승인됐었니?" 하고 되물을 paymentKey 목록.
 *
 * ── 왜 폴링 응답에 얹어 보내나 ──
 *   서버가 단말기를 직접 부를 방법이 없다. 단말기는 매장 와이파이 뒤에 있고
 *   공인 주소가 없다. 반대로 단말기는 이미 이 엔드포인트를 주기적으로 두드리고
 *   있다. 그 왕복에 숙제를 한 줄 얹는 게 새 채널을 뚫는 것보다 훨씬 안전하다 —
 *   인증도 이미 deviceGuard 로 끝나 있고, 실패해도 다음 폴링에 다시 온다.
 *
 * ── 왜 이 단말기의 건만 ──
 *   getPayment 캐시는 **그 단말기 안에** 있다. 다른 단말기에서 긁힌 결제를
 *   물어봐야 무조건 NOT_FOUND 다. 그 답을 "승인 없음" 으로 받아 적으면 멀쩡한
 *   결제를 영영 못 찾게 된다. 그래서 device_id 로 반드시 좁힌다.
 *
 *   device_id 가 NULL 인 intent 는 어느 단말기에서 긁혔는지 알 수 없으므로
 *   자동 대사 대상이 아니다. 그건 수기 대사로 남는다.
 */
async function pendingRecoveryKeys(
  tenantId: string,
  deviceId: string
): Promise<Array<{ paymentKey: string; orderId: string; amount: number }>> {
  const rows = await db
    .select({
      paymentKey: paymentIntents.paymentKey,
      intentStatus: paymentIntents.status,
      createdAt: paymentIntents.createdAt,
      failureReason: paymentIntents.failureReason,
      // ⚠️ amount·orderId 를 서버가 함께 내려 주는 이유 (0.3.13 에서 고친 진짜 버그):
      //    getPayment 가 돌려주는 캐시 응답에는 **금액도 주문번호도 paymentKey 도
      //    없다.** 문서상 response 는 { paymentMethod, tid, vanTransactionKey, card }
      //    뿐이다. 그래서 예전 복구 경로가 SDK 응답만 보고 confirm 을 부르다가
      //    400 {"error":"Required"} 로 죽었다 (0.3.11 때 단말기 로그에 찍힌 그것).
      //    금액은 원래도 서버가 확정한 값만 신뢰해야 하므로, 여기서 같이 보낸다.
      amount: paymentIntents.amount,
      orderId: paymentDispatches.orderId,
      // 이 paymentKey 로 수입(양수) 행이 이미 있는가. 상태 플래그가 아니라
      // 실제로 적힌 돈을 센다 — 웹훅·수기 대사·지각 confirm 어느 경로로 들어왔든
      // "장부에 있다"는 사실 하나만 보면 되기 때문이다.
      ledgered: sql<number>`(
        SELECT count(*)::int FROM ${payments} p
         WHERE p.external_payment_key = ${paymentIntents.paymentKey}
           AND p.amount > 0
      )`,
    })
    .from(paymentIntents)
    // dispatch 는 orderId 를 가져오기 위한 것뿐이라 leftJoin 이다. dispatch 없이
    // 만들어진 intent(대사 대상이 될 수 있다)를 이 조인 때문에 잃으면 안 된다.
    .leftJoin(paymentDispatches, eq(paymentDispatches.intentId, paymentIntents.id))
    .where(
      and(
        eq(paymentIntents.tenantId, tenantId),
        eq(paymentIntents.deviceId, deviceId),
        inArray(paymentIntents.status, ["TIMEOUT", "FAILED", "CANCELED"])
      )
    )
    // 최근 것부터. 오래된 건은 어차피 캐시 수명 밖이라 selectRecoveryKeys 가 거른다.
    .orderBy(desc(paymentIntents.createdAt))
    .limit(50);

  const candidates: RecoveryCandidate[] = rows.map((r) => ({
    paymentKey: r.paymentKey,
    intentStatus: r.intentStatus,
    createdAt: r.createdAt,
    alreadyLedgered: (r.ledgered ?? 0) > 0,
    failureReason: r.failureReason,
  }));

  const chosen = new Set(selectRecoveryKeys(candidates, new Date()));
  return rows
    .filter((r) => chosen.has(r.paymentKey))
    .map((r) => ({
      paymentKey: r.paymentKey,
      // dispatch 가 없으면 orderId 도 없다. 서버 confirm 은 min(1) 을 요구하므로
      // paymentKey 로 대신한다 — 우리가 발급한 값이라 대사에 지장이 없다.
      orderId: r.orderId ?? r.paymentKey,
      amount: r.amount,
    }));
}

frontDispatchRouter.get("/dispatch/pending", deviceGuard, async (req: Request, res: Response) => {
  const device = req.device!;

  // 되찾을 게 있으면 함께 실어 보낸다. 여기서 실패해도 결제 전달은 막지 않는다 —
  // 대사는 부수적인 일이고, 결제를 받는 것이 이 엔드포인트의 본업이기 때문이다.
  let recover: Array<{ paymentKey: string; orderId: string; amount: number }> = [];
  try {
    recover = await pendingRecoveryKeys(device.tenantId, device.id);
    if (recover.length > 0) {
      console.log(`🔁 자동 대사 요청: device=${device.id} ${recover.length}건 확인 지시`);
    }
  } catch (err) {
    console.error("자동 대사 목록 조회 실패 (결제 전달은 계속합니다):", err);
  }

  // 카드 취소 대기 건. 결제와 같은 왕복에 얹는다 — 단말기는 이미 이 엔드포인트를
  // 1초마다 두드리고 있고, 새 채널을 뚫는 것보다 훨씬 안전하다 (자동 대사와 같은 이유).
  //
  // ⚠️ 응답에 필드를 **추가만** 한다. 지금 현장에 깔린 0.3.14 플러그인은 이 필드를
  //    모르므로 그냥 무시하고 지나간다. 서버를 먼저 배포해도 결제는 아무 영향이 없다.
  //    이것이 1단계를 SDK 호출 없이 끊은 이유다.
  let cancel: Awaited<ReturnType<typeof pendingCancelForDevice>> = null;
  try {
    cancel = await pendingCancelForDevice(device.tenantId, device.id);
  } catch (err) {
    console.error("취소 대기 조회 실패 (결제 전달은 계속합니다):", err);
  }

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
      requestedInstallment: paymentIntents.requestedInstallment,
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
  if (!row) return res.json({ pending: null, recover, cancel });
  return res.json({
    recover,
    cancel,
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
      // 할부 개월 (0 = 일시불).
      //
      // ⚠️ NULL 을 0 으로 바꿔서 내려 주는 것이 중요하다. 이 컬럼이 생기기 전에
      //    만들어진 intent 는 전부 NULL 인데, 그대로 내려보내면 구형 플러그인이든
      //    신형이든 undefined 를 SDK 에 넘기게 된다. DB 에서는 "모른다"(NULL)와
      //    "일시불"(0)을 구분해 두지만, 단말기에 보낼 때는 0 하나로 확정한다 —
      //    카드에 실제로 거는 값에 "모름" 같은 건 있으면 안 된다.
      installment: row.requestedInstallment ?? 0,
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
        inArray(paymentDispatches.status, OPEN_DISPATCH_STATES)
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
/**
 * 만료된 dispatch·intent 를 TIMEOUT 으로 정리한다.
 *
 * ── 왜 intent 를 dispatch 와 "따로" 쓸어야 하는가 (2026-08-29 사고) ──
 *   예전 배치는 dispatch 를 먼저 만료시키고, 거기서 나온 paymentKey 로만 intent 를
 *   따라 정리했다. 그래서 dispatch 가 아예 없는 intent 는 영원히 CREATED 로 남았다.
 *   그런 intent 는 두 경로로 생긴다:
 *     1) /payments/intents (단말기가 직접 만드는 구 흐름) — dispatch 를 만들지 않는다
 *     2) dispatch INSERT 직전에 트랜잭션이 깨진 경우
 *   그리고 dispatch 만료는 성공했는데 뒤이은 intent UPDATE 가 실패해도 같은 결과가 된다
 *   (두 UPDATE 가 한 트랜잭션이 아니었다).
 *
 *   실제로 8월 청구서에 CREATED intent 가 하루 넘게 남아 학생의 재결제를 막았다.
 *   그래서 이제 intent 를 **자기 자신의 expiresAt 기준으로** 독립적으로 쓴다.
 *   어떤 경로로 고아가 되었든 상관없이 잡힌다.
 *
 * 순서: intent 를 먼저 쓸고 dispatch 를 쓴다. 반대로 하면 dispatch 정리 후 intent
 * 정리 전에 프로세스가 죽었을 때 다시 고아가 생긴다. intent 가 결제를 막는 쪽이므로
 * 그쪽을 먼저 푼다.
 */
export function startDispatchExpirySweeper(intervalMs = 30_000) {
  const tick = async () => {
    const now = new Date();

    // (1) intent — 자기 expiresAt 기준. dispatch 와 무관하게 정리된다.
    try {
      const staleIntents = await db
        .update(paymentIntents)
        .set({ status: "TIMEOUT", failureReason: "expired", updatedAt: now })
        .where(
          and(
            inArray(paymentIntents.status, OPEN_INTENT_STATES),
            lt(paymentIntents.expiresAt, now)
          )
        )
        .returning({ id: paymentIntents.id });
      if (staleIntents.length > 0) {
        console.log(`🧹 만료된 결제 intent ${staleIntents.length}건을 TIMEOUT 으로 정리했습니다.`);
      }
    } catch (err) {
      console.error("intent expiry sweeper error:", err);
    }

    // (2) dispatch — 위가 실패해도 이건 돌아야 하므로 try 를 나눈다.
    try {
      const staleDispatches = await db
        .update(paymentDispatches)
        .set({ status: "TIMEOUT", respondedAt: now, failureReason: "expired", updatedAt: now })
        .where(
          and(
            inArray(paymentDispatches.status, OPEN_DISPATCH_STATES),
            lt(paymentDispatches.expiresAt, now)
          )
        )
        .returning({ id: paymentDispatches.id });
      if (staleDispatches.length > 0) {
        console.log(`🧹 만료된 dispatch ${staleDispatches.length}건을 TIMEOUT 으로 정리했습니다.`);
      }
    } catch (err) {
      console.error("dispatch expiry sweeper error:", err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  // 프로세스 종료 시 정리
  process.once("SIGTERM", () => clearInterval(timer));
  process.once("SIGINT", () => clearInterval(timer));
  // 첫 tick은 즉시 — 재시작 직후 남아 있던 유령을 곧바로 걷어낸다.
  tick();
}
