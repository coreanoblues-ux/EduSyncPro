/**
 * 단말기 카드 취소 라우터.
 *
 *   원장(웹)  ──POST /admin/card-cancels──▶  서버가 취소 dispatch 생성
 *                                              │
 *   프론트 단말기 ◀──폴링 응답의 cancel 필드────┘
 *        │
 *        ├─ POST /dispatch/cancel/:id/ack      단말기가 집어감
 *        └─ POST /dispatch/cancel/:id/result   취소 결과 보고
 *                                              │
 *                              성공일 때만 ─────┴──▶ payments 에 음수 행 (장부 반영)
 *
 * ── 왜 새 파일인가 ──
 *   dispatch.ts·admin.ts 는 매일 돈을 받는 경로다. 거기에 취소 로직을 섞으면
 *   버그 하나가 결제까지 세운다. 취소는 아직 한 번도 현장에서 돌아 본 적이 없는
 *   기능이므로 실패 반경을 파일 단위로 격리한다.
 *
 * ── 이 파일의 단 하나의 규칙 ──
 *   **장부 음수 행은 단말기가 "카드 취소 성공"을 보고한 뒤에만 쓴다.**
 *   순서를 뒤집으면 장부엔 환불인데 돈은 안 돌아간 상태가 되고, 그건 학부모와
 *   다투게 되는 종류의 오류다. 기존 /admin/refunds 는 장부만 적는 별도 기능으로
 *   그대로 남는다 (카드를 이미 사장님 앱에서 취소한 경우에 쓴다).
 */

import { Router, Request, Response } from "express";
import crypto from "crypto";
import { z } from "zod";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db";
import {
  paymentIntents,
  paymentDispatches,
  paymentCancelDispatches,
  tossPaymentTransactions,
  tossFrontDevices,
  students,
  enrollments,
  classes,
  payments,
} from "@shared/schema";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";
import { deviceGuard } from "./deviceAuth";
import { publish } from "./dispatchBus";
import { isBlocking, OPEN_DISPATCH_STATES } from "./lifecycle";
import { resolveLedgerUserId, getOrCreateSystemUserId } from "./ledgerUser";
import {
  CANCEL_DISPATCH_TTL_MS,
  CANCEL_SCAN_LIMIT,
  DEVICE_TOUCH_INTERVAL_MS,
  classifyCancelResult,
  classifyCardCancel,
  decideCancelReroute,
  normalizeApprovedTimestamp,
  remainingRefundable,
  type CancelDispatchStatus,
} from "./cardCancel";

export const cardCancelAdminRouter = Router();
export const cardCancelDeviceRouter = Router();

/** pg_advisory_xact_lock 키. dispatch.ts·admin.ts 와 같은 방식. */
function advisoryKey(input: string): number {
  return crypto.createHash("sha256").update(input).digest().readInt32BE(0);
}

/** 원장이 그대로 옮겨 적을 수 있는 DB 오류 한 줄. admin.ts 와 같은 방침. */
function describeDbError(err: any): string {
  const bits: string[] = [];
  if (err?.code) bits.push(`code=${err.code}`);
  if (err?.constraint) bits.push(`constraint=${err.constraint}`);
  if (err?.detail) bits.push(`detail=${err.detail}`);
  const msg = err?.message ?? String(err);
  return bits.length > 0 ? `${msg} (${bits.join(" · ")})` : msg;
}

/**
 * 이 결제의 장부 현황. 상태 플래그가 아니라 실제로 적힌 돈만 센다.
 * (세 경로 — 단말기 취소·취소 웹훅·수기 환불 — 이 같은 근거를 봐야 중복 계상이 없다.)
 */
async function readLedger(
  tx: any,
  tenantId: string,
  paymentKey: string
): Promise<{ paidIn: number; refunded: number }> {
  const [row] = await tx
    .select({
      paidIn: sql<number>`coalesce(sum(${payments.amount}) FILTER (WHERE ${payments.amount} > 0), 0)::int`,
      refunded: sql<number>`coalesce(-sum(${payments.amount}) FILTER (WHERE ${payments.amount} < 0), 0)::int`,
    })
    .from(payments)
    .where(and(eq(payments.tenantId, tenantId), eq(payments.externalPaymentKey, paymentKey)));
  return { paidIn: row?.paidIn ?? 0, refunded: row?.refunded ?? 0 };
}

// ═══════════════════════════════════════════════════════════════════════
// 원장용 (authGuard + roleGuard(owner))
// ═══════════════════════════════════════════════════════════════════════

/**
 * 왜 원장 전용인가:
 *   태블릿 인증은 "전화번호 뒤 4자리"다. 그건 학부모 본인 확인용이지 돈을 되돌릴
 *   권한의 근거가 못 된다. 태블릿은 현관에 놓여 누구나 만진다. 카드 취소는
 *   authGuard + roleGuard(owner) 뒤에만 둔다 — /admin/refunds 와 같은 기준이다.
 *
 *   단말기는 "실행기"일 뿐 "결정 주체"가 아니다.
 */

/** 취소 요청 이력 — 원장이 진행 상황과 막힌 건을 본다. */
cardCancelAdminRouter.get(
  "/admin/card-cancels",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.json([]);
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const rows = await db
      .select({
        id: paymentCancelDispatches.id,
        paymentKey: paymentCancelDispatches.paymentKey,
        status: paymentCancelDispatches.status,
        cancelAmount: paymentCancelDispatches.cancelAmount,
        ledgerAmount: paymentCancelDispatches.ledgerAmount,
        reason: paymentCancelDispatches.reason,
        failureReason: paymentCancelDispatches.failureReason,
        cancelApprovalNumber: paymentCancelDispatches.cancelApprovalNumber,
        createdAt: paymentCancelDispatches.createdAt,
        deliveredAt: paymentCancelDispatches.deliveredAt,
        respondedAt: paymentCancelDispatches.respondedAt,
        expiresAt: paymentCancelDispatches.expiresAt,
        studentName: students.name,
        className: classes.name,
        paymentMonth: paymentIntents.paymentMonth,
      })
      .from(paymentCancelDispatches)
      .innerJoin(paymentIntents, eq(paymentIntents.id, paymentCancelDispatches.intentId))
      .leftJoin(students, eq(students.id, paymentIntents.studentId))
      .leftJoin(enrollments, eq(enrollments.id, paymentIntents.enrollmentId))
      .leftJoin(classes, eq(classes.id, enrollments.classId))
      .where(eq(paymentCancelDispatches.tenantId, tenantId))
      .orderBy(desc(paymentCancelDispatches.createdAt))
      .limit(limit);

    return res.json(
      rows.map((r) => ({
        ...r,
        // 사람이 개입해야 하는 건을 화면에서 바로 구분할 수 있게 표시한다.
        needsHuman: r.status === "TIMEOUT",
        hint:
          r.status === "TIMEOUT"
            ? "결과를 받지 못했습니다. 토스 사장님 앱에서 취소 여부를 확인한 뒤 처리하세요."
            : r.status === "DELIVERED"
              ? "단말기가 처리 중입니다. 단말기 화면을 확인하세요."
              : null,
      }))
    );
  }
);

/**
 * TIMEOUT 으로 잠긴 건을 사람이 확인한 뒤 푼다 (TIMEOUT → FAILED).
 *
 * ── 왜 필요한가 (2026-08-31) ──
 *   TIMEOUT 은 "카드가 취소됐는지 모른다" 는 뜻이고, 부분 유니크 인덱스 안에
 *   있어서 그 결제를 **영원히 잠근다.** 모르는 상태에서 자동 재시도를 붙이면
 *   이중 취소가 나기 때문에 이 잠금 자체는 옳다.
 *
 *   문제는 나가는 문이 없었다는 것이다. 현장에서 단말기가 "원거래 없음"(조회 키
 *   오류)을 던졌는데 TIMEOUT 으로 기록되면서, 시험용 1,000원 결제 한 건이
 *   통째로 잠겼다. 키를 고쳐도 다시 시험할 방법이 없었다.
 *
 * ── 안전 근거 ──
 *   푸는 것은 **사람만** 한다. 서버는 "카드가 안 됐다" 를 스스로 알 수 없으므로
 *   원장이 토스 사장님 앱에서 실물을 확인했다는 명시적 확인을 요구한다.
 *   이 엔드포인트는 장부를 건드리지 않는다 — 상태만 FAILED 로 바꿔 재시도를
 *   허용할 뿐이고, 실제 취소는 그 다음 요청이 처음부터 다시 한다.
 *
 *   되돌리기 위험: 만약 카드가 실제로는 취소됐는데 원장이 잘못 확인하고 풀면,
 *   다음 취소 시도에서 단말기가 "원거래 없음"(이미 취소됨)을 답한다 — 이제
 *   그 응답이 FAILED 로 기록되므로 장부에는 아무것도 적히지 않는다. 즉 잘못
 *   풀어도 이중 환불이 장부에 반영되지는 않는다.
 */
const releaseCancelSchema = z.object({
  /** 원장이 사장님 앱에서 "취소 안 됨" 을 확인했다는 명시적 표시. */
  confirmedNotCancelled: z.literal(true),
  note: z.string().trim().max(200).optional(),
});

cardCancelAdminRouter.post(
  "/admin/card-cancels/:id/release",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const parsed = releaseCancelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "카드가 취소되지 않았음을 확인했다는 표시가 필요합니다.",
      });
    }
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.status(400).json({ error: "테넌트를 알 수 없습니다." });

    // 누가 언제 풀었는지는 반드시 남긴다. 돈을 되돌리는 잠금을 사람이 푼
    // 것이므로, 나중에 장부가 어긋났을 때 여기서부터 되짚어야 한다.
    // 컬럼 추가(마이그레이션) 없이 failure_reason 뒤에 덧붙인다.
    const auditNote =
      ` | 사람확인해제: 사장님앱에서 취소되지 않음을 확인 (${req.user!.id} ${new Date().toISOString()})` +
      (parsed.data.note ? ` 메모: ${parsed.data.note}` : "");

    // TIMEOUT 에서만 나갈 수 있다. SUCCEEDED 를 푸는 일은 절대 없어야 하고,
    // DELIVERED(단말기가 처리 중)를 푸는 것도 이중 취소로 이어진다.
    const [row] = await db
      .update(paymentCancelDispatches)
      .set({
        status: "FAILED",
        failureReason: sql`LEFT(COALESCE(${paymentCancelDispatches.failureReason}, '') || ${auditNote}, 2000)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paymentCancelDispatches.id, req.params.id),
          eq(paymentCancelDispatches.tenantId, tenantId),
          eq(paymentCancelDispatches.status, "TIMEOUT")
        )
      )
      .returning({ id: paymentCancelDispatches.id, paymentKey: paymentCancelDispatches.paymentKey });

    if (!row) {
      return res.status(409).json({
        error:
          "결과를 모르는(TIMEOUT) 취소 요청만 풀 수 있습니다. 이미 처리됐거나 진행 중인 건일 수 있으니 목록을 새로고침해 주세요.",
      });
    }

    console.warn(
      `⚠️  카드취소 사람확인 해제: cancel=${row.id} paymentKey=${row.paymentKey} ` +
        `by=${req.user!.id} — 원장이 '카드 취소되지 않음' 을 확인했습니다. 재시도가 가능해집니다.`
    );
    return res.json({ ok: true, paymentKey: row.paymentKey });
  }
);

const createCancelSchema = z.object({
  paymentKey: z.string().min(1),
  reason: z.string().trim().max(200).optional(),
});

cardCancelAdminRouter.post(
  "/admin/card-cancels",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const parsed = createCancelSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.status(403).json({ error: "테넌트가 없는 계정입니다." });
    const { paymentKey, reason } = parsed.data;

    class Reject extends Error {
      constructor(
        public httpStatus: number,
        message: string,
        public needsHuman = false
      ) {
        super(message);
      }
    }

    try {
      const built = await db.transaction(async (tx) => {
        // 취소 버튼은 네트워크가 느리면 반드시 두 번 눌린다. 같은 결제에 대한
        // 동시 요청을 직렬화하지 않으면 두 요청이 같은 "기존 취소 없음"을 읽고
        // 둘 다 통과한다 — 그게 이중 취소다.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryKey(paymentKey)}, 1)`);

        const [intent] = await tx
          .select()
          .from(paymentIntents)
          .where(
            and(eq(paymentIntents.paymentKey, paymentKey), eq(paymentIntents.tenantId, tenantId))
          );
        if (!intent) throw new Reject(404, "결제 건을 찾을 수 없습니다.");

        // 원승인 기록 — SDK 필수 파라미터(승인번호·승인시각)의 출처.
        const [approval] = await tx
          .select()
          .from(tossPaymentTransactions)
          .where(
            and(
              eq(tossPaymentTransactions.paymentKey, paymentKey),
              eq(tossPaymentTransactions.tenantId, tenantId)
            )
          );

        const ledger = await readLedger(tx, tenantId, paymentKey);

        const existing = await tx
          .select({ status: paymentCancelDispatches.status })
          .from(paymentCancelDispatches)
          .where(
            and(
              eq(paymentCancelDispatches.paymentKey, paymentKey),
              eq(paymentCancelDispatches.tenantId, tenantId)
            )
          );

        const decision = classifyCardCancel({
          intentStatus: intent.status,
          approvedAmount: intent.amount,
          ledgerPaidIn: ledger.paidIn,
          ledgerRefunded: ledger.refunded,
          hasApprovalRecord: !!approval,
          approvalNumber: approval?.approvalNumber ?? null,
          approvedTimestamp: approval?.approvedTimestamp ?? null,
          tid: approval?.tid ?? null,
          deviceId: intent.deviceId,
          existingCancelStates: existing.map((e) => e.status as CancelDispatchStatus),
        });
        if (decision.kind === "reject") {
          throw new Reject(409, decision.reason, decision.needsHuman ?? false);
        }

        // 단말기가 살아 있는지. 꺼져 있으면 요청만 쌓이고 아무 일도 안 일어난다.
        const [device] = await tx
          .select({ id: tossFrontDevices.id, isActive: tossFrontDevices.isActive })
          .from(tossFrontDevices)
          .where(eq(tossFrontDevices.id, intent.deviceId!));
        if (!device || !device.isActive) {
          throw new Reject(
            409,
            "이 결제를 승인한 단말기가 비활성 상태입니다. 단말기 전원과 연결을 확인해 주세요.",
            true
          );
        }

        // 단말기는 한 번에 하나만 한다. 결제 중에 취소를 밀어 넣으면 두 카드 작업이
        // 겹친다. payment_dispatches 쪽 진행 건을 함께 본다 (테이블이 다르므로
        // 여기서 명시적으로 확인해야 한다 — 이걸 빠뜨리면 상호배제가 깨진다).
        const [openPayment] = await tx
          .select({
            status: paymentDispatches.status,
            expiresAt: paymentDispatches.expiresAt,
          })
          .from(paymentDispatches)
          .where(
            and(
              eq(paymentDispatches.tossDeviceId, intent.deviceId!),
              inArray(paymentDispatches.status, OPEN_DISPATCH_STATES)
            )
          )
          .orderBy(desc(paymentDispatches.expiresAt))
          .limit(1);
        if (openPayment && isBlocking(openPayment.status, openPayment.expiresAt)) {
          throw new Reject(409, "단말기가 지금 결제를 처리 중입니다. 잠시 후 다시 시도해 주세요.");
        }

        // 장부에 적을 사람. superadmin 은 users 에 행이 없어 FK 가 깨진다 —
        // 결과 반영 시점에는 로그인 정보가 없으므로 **지금** 실존 id 로 확정해 둔다.
        const actor = await resolveLedgerUserId(tx, tenantId, req.user!);

        const [row] = await tx
          .insert(paymentCancelDispatches)
          .values({
            tenantId,
            paymentKey,
            intentId: intent.id,
            tossDeviceId: intent.deviceId!,
            cancelAmount: decision.cancelAmount,
            ledgerAmount: decision.ledgerAmount,
            status: "PENDING",
            requestedBy: actor.userId,
            reason:
              (reason ?? "") + (actor.substituted ? ` [실행자 ${actor.actorLabel}]` : "") || null,
            expiresAt: new Date(Date.now() + CANCEL_DISPATCH_TTL_MS),
          })
          .returning();

        return { row, intent, approval: approval!, decision };
      });

      // 단말기에 즉시 알린다. 안 붙어 있어도 폴링이 1초 안에 집어 간다.
      publish(built.row.tossDeviceId, "payment.cancel", {
        cancelId: built.row.id,
        paymentKey,
        amount: built.decision.cancelAmount,
      });

      console.log(
        `↩️  카드 취소 요청: paymentKey=${paymentKey} ${built.decision.cancelAmount.toLocaleString()}원 → device=${built.row.tossDeviceId}`
      );

      return res.status(201).json({
        cancelId: built.row.id,
        paymentKey,
        cancelAmount: built.decision.cancelAmount,
        ledgerAmount: built.decision.ledgerAmount,
        expiresAt: built.row.expiresAt,
        notice:
          "단말기로 취소 요청을 보냈습니다. 단말기 화면의 안내를 따라 주세요. " +
          "카드 취소가 완료되면 장부에 자동으로 반영됩니다.",
      });
    } catch (err: any) {
      if (err instanceof Reject) {
        return res.status(err.httpStatus).json({ error: err.message, needsHuman: err.needsHuman });
      }
      // 부분 유니크 인덱스 위반 = 이미 진행중/완료된 취소가 있다는 뜻.
      // 판정에서 걸렀어야 하지만, 동시 요청이 잠금을 우회한 경우 DB 가 마지막으로 막는다.
      if (err?.code === "23505") {
        return res.status(409).json({
          error: "이미 이 결제에 대한 취소가 진행 중이거나 완료되었습니다.",
        });
      }
      console.error("card cancel create error:", err);
      return res
        .status(500)
        .json({ error: `취소 요청 생성 중 오류가 발생했습니다: ${describeDbError(err)}` });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// 단말기용 (deviceGuard)
// ═══════════════════════════════════════════════════════════════════════

/**
 * 폴링한 단말기의 lastSeenAt 을 찍는다. 마지막 기록에서 DEVICE_TOUCH_INTERVAL_MS 가
 * 지났을 때만 UPDATE 한다.
 *
 * ── 왜 여기서 하는가 ──
 *   lastSeenAt 은 원래 **토큰 발급·페어링 때만** 기록됐다. 그래서 "이 단말기 살아 있나?"
 *   를 물으면 "몇 시간 전에 로그인했다" 밖에 답할 수 없었다. 재배정 판단이 그 값을 믿는
 *   순간, 멀쩡히 켜져 있는 단말기가 죽은 것으로 보인다.
 *
 *   deviceGuard 에 넣지 않은 이유: 그건 매일 돈을 받는 결제 경로다. 취소 때문에 결제
 *   미들웨어를 건드리지 않는다. 이 함수는 dispatch.ts 에서 이미 try/catch 로 감싸
 *   호출되므로, 여기서 실패해도 결제 폴링은 그대로 돈다.
 *
 *   덤으로 관리자 화면의 "마지막 접속" 도 이제 진짜 생존 시각을 보여 준다.
 */
const lastTouchAt = new Map<string, number>();

async function touchDevice(deviceId: string, now: number): Promise<void> {
  const prev = lastTouchAt.get(deviceId) ?? 0;
  if (now - prev < DEVICE_TOUCH_INTERVAL_MS) return;
  lastTouchAt.set(deviceId, now);
  try {
    await db
      .update(tossFrontDevices)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(tossFrontDevices.id, deviceId));
  } catch (err: any) {
    // 생존 표시를 못 찍은 것뿐이다. 취소 폴링을 멈출 이유가 되지 않는다.
    console.warn(`단말기 생존시각 기록 실패 (${deviceId}): ${err?.message ?? err}`);
  }
}

/**
 * 이 단말기가 지금 처리해야 할 취소 한 건. dispatch.ts 의 /dispatch/pending 응답에
 * 얹어 보내기 위한 헬퍼다.
 *
 * SDK requestPaymentCancel 이 요구하는 값을 **서버가 확정해서** 통째로 내려 준다.
 * 단말기가 계산하거나 캐시에서 꺼내 쓰게 두면 안 된다 —
 * getPayment 캐시 응답에는 금액도 orderId 도 없다는 걸 0.3.13 에서 이미 겪었다.
 * 취소는 파라미터가 하나만 틀려도 실패하므로 더더욱 서버가 정해서 준다.
 *
 * ── 왜 tossDeviceId 로 좁혀 조회하지 않는가 (2026-08-30) ──
 *   취소는 "원래 결제를 승인했던 단말기 ID" 앞으로 쌓인다. 그런데 플러그인을 다시
 *   올리거나 단말기를 재페어링하면 toss_front_devices 에 새 행이 생긴다. 물리적으로는
 *   같은 단말기인데 ID 가 달라진 것이다. 그러면 취소는 옛 ID 앞에 남고, 지금 폴링하는
 *   새 ID 는 가져갈 게 없다. 원장 화면엔 "취소 요청됨" 인데 단말기는 조용한,
 *   설명이 안 되는 상태가 된다. 실제로 그 일이 났다.
 *
 *   그래서 좁히지 않고 다 본 다음, 대상 단말기가 **확실히 죽었을 때만** 가져온다.
 *   판단은 decideCancelReroute (cardCancel.ts) 가 한다. 애매하면 아무것도 안 한다 —
 *   두 단말기가 같은 취소를 집어가면 학부모 카드에 돈이 두 번 들어가고, 우리에겐
 *   그걸 되돌릴 API 가 없다.
 */
export async function pendingCancelForDevice(tenantId: string, deviceId: string) {
  const now = Date.now();
  await touchDevice(deviceId, now);

  const rows = await db
    .select({
      cancelId: paymentCancelDispatches.id,
      paymentKey: paymentCancelDispatches.paymentKey,
      amount: paymentCancelDispatches.cancelAmount,
      expiresAt: paymentCancelDispatches.expiresAt,
      // ── SDK 필수 파라미터 (원거래와 동일해야 한다) ──
      paymentMethod: tossPaymentTransactions.paymentMethod,
      approvalNumber: tossPaymentTransactions.approvalNumber,
      approvedTimestamp: tossPaymentTransactions.approvedTimestamp,
      installment: tossPaymentTransactions.installment,
      tid: tossPaymentTransactions.tid,
      vanTransactionKey: tossPaymentTransactions.vanTransactionKey,
      // 문서: "원거래와 동일한 tax, supplyValue, taxExemptValue 를 전달해요"
      tax: paymentIntents.tax,
      supplyValue: paymentIntents.supplyValue,
      taxExemptValue: paymentIntents.taxExemptValue,
      // ── 배정 진단용 (단말기로 내려보내지 않는다) ──
      targetDeviceId: paymentCancelDispatches.tossDeviceId,
      targetActive: tossFrontDevices.isActive,
      targetLastSeenAt: tossFrontDevices.lastSeenAt,
    })
    .from(paymentCancelDispatches)
    .innerJoin(paymentIntents, eq(paymentIntents.id, paymentCancelDispatches.intentId))
    .innerJoin(
      tossPaymentTransactions,
      eq(tossPaymentTransactions.paymentKey, paymentCancelDispatches.paymentKey)
    )
    // 취소가 걸린 대상 단말기가 아직 살아 있는지 보려면 조인해야 한다.
    // 페어링 행이 지워졌을 수도 있으므로 leftJoin 이다.
    .leftJoin(tossFrontDevices, eq(tossFrontDevices.id, paymentCancelDispatches.tossDeviceId))
    .where(
      and(
        eq(paymentCancelDispatches.tenantId, tenantId),
        eq(paymentCancelDispatches.status, "PENDING")
      )
    )
    .orderBy(paymentCancelDispatches.createdAt)
    .limit(CANCEL_SCAN_LIMIT);

  if (rows.length === 0) return null;

  // 내 앞으로 온 것이 있으면 그것부터. (재배정 판단이 필요 없는 정상 경로)
  const mine = rows.find((r) => r.targetDeviceId === deviceId);
  const chosen = mine ?? decideCancelReroute(rows, deviceId, now, process.uptime() * 1000);
  if (!chosen) return null;

  if (!mine) {
    // ★ toss_device_id 를 반드시 옮겨야 한다.
    //   POST /dispatch/cancel/:id/ack 가 tossDeviceId = device.id 로 필터하기 때문에,
    //   행을 옮기지 않고 내려보내기만 하면 단말기는 ack 에서 409 를 받고 SDK 를 부르지
    //   않은 채 포기한다. 조용히 아무 일도 안 일어나는 바로 그 증상이 된다.
    //
    //   조건부 UPDATE 인 이유: PENDING 이고 아직 옛 단말기 앞으로 있을 때만 옮긴다.
    //   그 사이 옛 단말기가 집어갔다면(DELIVERED) 0행이 돌아오고 우리는 물러난다.
    //   카드는 절대 두 번 건드리지 않는다.
    const moved = await db
      .update(paymentCancelDispatches)
      .set({ tossDeviceId: deviceId, updatedAt: new Date() })
      .where(
        and(
          eq(paymentCancelDispatches.id, chosen.cancelId),
          eq(paymentCancelDispatches.tossDeviceId, chosen.targetDeviceId),
          eq(paymentCancelDispatches.status, "PENDING")
        )
      )
      .returning({ id: paymentCancelDispatches.id });

    if (moved.length === 0) {
      // 옛 단말기가 방금 집어갔다. 이번 폴링은 빈손으로 돌아간다.
      return null;
    }

    console.warn(
      `⚠️  카드취소 재배정: ${chosen.paymentKey} (${chosen.amount}원) — ` +
        `대상 단말기 ${chosen.targetDeviceId} 가 응답 없어 ` +
        `현재 폴링중인 ${deviceId} 로 옮겼습니다. ` +
        `(재페어링으로 기기 행이 새로 생긴 경우입니다. ` +
        `마지막 접속: ${chosen.targetLastSeenAt?.toISOString() ?? "없음"})`
    );
  }

  // ★ timestamp 는 단말기가 원거래를 찾는 조회 키다. 형식이 틀리면 단말기는
  //   "요청건이 없다" 며 되돌아온다 — 2026-08-30 현장에서 실제로 그랬다.
  //   저장된 값은 ISO 이고 SDK 는 밀리초를 원한다. 여기서 맞춰 준다.
  // TID 도 원거래 조회 키다. 생성 시점에 걸렀지만, 이 배포 이전에 쌓인 행은
  // 그 관문을 통과하지 않았다. 내려보내기 직전에 한 번 더 본다.
  if (!chosen.tid) {
    console.error(
      `❌ 카드취소 보류: ${chosen.paymentKey} — 단말기 거래번호(TID)가 없습니다. ` +
        `사장님 앱에서 취소 후 [장부만] 을 쓰세요.`
    );
    return null;
  }

  const timestamp = normalizeApprovedTimestamp(chosen.approvedTimestamp);
  if (!timestamp) {
    // 조회 키를 만들 수 없다. 추측한 값을 보내느니 보내지 않는다.
    // 원장 화면에는 이미 "취소 요청됨" 이 떠 있으므로, 왜 조용한지 로그에 남긴다.
    console.error(
      `❌ 카드취소 보류: ${chosen.paymentKey} — 원승인 시각을 밀리초로 해석할 수 없습니다 ` +
        `(저장값="${chosen.approvedTimestamp}"). 잘못된 조회 키를 보내면 단말기가 ` +
        `엉뚱한 거래를 건드릴 수 있어 보내지 않습니다. 사장님 앱에서 취소 후 [장부만] 을 쓰세요.`
    );
    return null;
  }

  const { targetDeviceId, targetActive, targetLastSeenAt, ...payload } = chosen;
  if (timestamp !== chosen.approvedTimestamp) {
    console.log(
      `카드취소 원승인시각 변환: "${chosen.approvedTimestamp}" → "${timestamp}" (${chosen.paymentKey})`
    );
  }
  return {
    ...payload,
    approvedTimestamp: timestamp,
    // tip 은 학원 결제 흐름에 없다. SDK 필수 필드라 항상 0 을 명시한다.
    tip: 0,
  };
}

/**
 * POST /dispatch/cancel/:id/ack — 단말기가 취소 요청을 집어감.
 *
 * PENDING → DELIVERED 조건부 UPDATE 가 선점(claim) 역할을 한다. 두 폴링 사이클이
 * 동시에 같은 행을 집어도 한쪽만 1행을 얻으므로 카드 취소가 두 번 걸리지 않는다.
 * 이 한 줄이 이 파일에서 가장 중요한 동시성 방어다.
 */
cardCancelDeviceRouter.post(
  "/dispatch/cancel/:id/ack",
  deviceGuard,
  async (req: Request, res: Response) => {
    const device = req.device!;
    const result = await db
      .update(paymentCancelDispatches)
      .set({ status: "DELIVERED", deliveredAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(paymentCancelDispatches.id, req.params.id),
          eq(paymentCancelDispatches.tossDeviceId, device.id),
          eq(paymentCancelDispatches.status, "PENDING")
        )
      )
      .returning({ id: paymentCancelDispatches.id });

    if (result.length === 0) {
      // 이미 다른 사이클이 집어갔다. 카드를 두 번 취소하면 안 되므로 확실히 거절한다.
      return res.status(409).json({ error: "이 취소 요청은 PENDING 상태가 아닙니다." });
    }
    return res.json({ ok: true });
  }
);

const cancelResultSchema = z.object({
  /** SDK PaymentResult.type 그대로. */
  result: z.enum(["SUCCESS", "FAILED", "CANCELED", "TIMEOUT"]),
  cancelApprovalNumber: z.string().trim().max(64).optional(),
  cancelTid: z.string().trim().max(128).optional(),
  reason: z.string().trim().max(300).optional(),
  /** 감사용 최소 응답. 카드 원본번호는 단말기가 보내기 전에 제거한다. */
  raw: z.any().optional(),
});

/**
 * POST /dispatch/cancel/:id/result — 단말기가 취소 결과를 보고.
 *
 * **성공일 때만** 장부에 음수 행을 쓴다. 이 엔드포인트가 이 기능 전체의 심장이다.
 *
 * 멱등성:
 *   같은 결과가 두 번 와도 (재전송·아웃박스) 장부는 한 번만 움직인다. 근거는
 *   상태 플래그가 아니라 payments 를 다시 세는 것이다 — 취소 웹훅이 먼저 도착해
 *   이미 음수 행을 적어 뒀다면 여기서 계산한 금액이 0 이 되어 아무것도 안 적는다.
 *   세 경로가 같은 계산식(remainingRefundable)을 쓰는 이유가 이것이다.
 */
cardCancelDeviceRouter.post(
  "/dispatch/cancel/:id/result",
  deviceGuard,
  async (req: Request, res: Response) => {
    const parsed = cancelResultSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }
    const device = req.device!;
    const { result, cancelApprovalNumber, cancelTid, reason, raw } = parsed.data;
    const verdict = classifyCancelResult(result);

    try {
      const outcome = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(paymentCancelDispatches)
          .where(
            and(
              eq(paymentCancelDispatches.id, req.params.id),
              eq(paymentCancelDispatches.tossDeviceId, device.id),
              eq(paymentCancelDispatches.tenantId, device.tenantId)
            )
          );
        if (!row) return { kind: "notfound" as const };

        // 이미 마감된 건에 결과가 또 오면 조용히 성공으로 답한다. 단말기 아웃박스가
        // 재전송했을 뿐이다. 여기서 400 을 주면 단말기가 영원히 재시도한다.
        if (row.status === "SUCCEEDED" || row.status === "FAILED") {
          return { kind: "idempotent" as const, status: row.status };
        }

        await tx.execute(sql`SELECT pg_advisory_xact_lock(${advisoryKey(row.paymentKey)}, 1)`);

        if (!verdict.cardCancelled) {
          // 실패·타임아웃 — 장부는 건드리지 않는다. 카드가 안 돌아갔으므로
          // 장부에 환불을 적으면 없는 돈을 적는 것이 된다.
          await tx
            .update(paymentCancelDispatches)
            .set({
              status: verdict.status,
              respondedAt: new Date(),
              failureReason: reason ?? result,
              rawResponseJson: raw ? JSON.stringify(raw).slice(0, 4000) : null,
              updatedAt: new Date(),
            })
            .where(eq(paymentCancelDispatches.id, row.id));
          return { kind: "failed" as const, status: verdict.status };
        }

        // ── 여기부터는 카드가 실제로 취소된 경우다 ──
        const [intent] = await tx
          .select()
          .from(paymentIntents)
          .where(eq(paymentIntents.id, row.intentId));

        const ledger = await readLedger(tx, device.tenantId, row.paymentKey);
        // 요청 시점 계산값(row.ledgerAmount)이 아니라 **지금** 다시 센다.
        // 그 사이에 취소 웹훅이나 수기 환불이 들어왔을 수 있다.
        const toWrite = remainingRefundable(ledger.paidIn, ledger.refunded);

        if (toWrite > 0 && intent) {
          // requestedBy 는 생성 시점에 실존이 확인된 users.id 다. 그래도 계정이
          // 그 사이 지워졌을 수 있으니 시스템 사용자로 폴백한다 — 여기서 FK 가
          // 깨지면 카드는 취소됐는데 장부만 비는, 가장 나쁜 결과가 된다.
          let createdBy = row.requestedBy;
          if (createdBy) {
            const hit = await tx.execute(
              sql`SELECT id FROM users WHERE id = ${createdBy} LIMIT 1`
            );
            if ((hit.rows as any[]).length === 0) createdBy = null;
          }
          if (!createdBy) createdBy = await getOrCreateSystemUserId(tx, device.tenantId);

          await tx.insert(payments).values({
            tenantId: device.tenantId,
            enrollmentId: intent.enrollmentId,
            amount: -toWrite,
            type: "환불",
            method: "카드",
            paymentMonth: intent.paymentMonth,
            paidDate: new Date(),
            createdBy,
            notes:
              `Toss Front 카드취소 (단말기) · ${row.paymentKey}` +
              (cancelApprovalNumber ? ` · 취소승인 ${cancelApprovalNumber}` : "") +
              (row.reason ? ` · 사유: ${row.reason}` : ""),
            externalProvider: "TOSSPLACE",
            externalPaymentKey: row.paymentKey,
            paidVia: "TOSS_FRONT",
          });
        }

        // 카드가 전액 취소됐으므로 intent 는 CANCELED 로 마감한다.
        await tx
          .update(paymentIntents)
          .set({ status: "CANCELED", cancelledAt: new Date(), updatedAt: new Date() })
          .where(eq(paymentIntents.id, row.intentId));

        await tx
          .update(paymentCancelDispatches)
          .set({
            status: "SUCCEEDED",
            respondedAt: new Date(),
            cancelApprovalNumber: cancelApprovalNumber ?? null,
            cancelTid: cancelTid ?? null,
            ledgerAmount: toWrite,
            rawResponseJson: raw ? JSON.stringify(raw).slice(0, 4000) : null,
            updatedAt: new Date(),
          })
          .where(eq(paymentCancelDispatches.id, row.id));

        return { kind: "succeeded" as const, wrote: toWrite, paymentKey: row.paymentKey };
      });

      if (outcome.kind === "notfound") {
        return res.status(404).json({ error: "취소 요청을 찾을 수 없습니다." });
      }
      if (outcome.kind === "idempotent") {
        return res.json({ ok: true, idempotent: true, status: outcome.status });
      }
      if (outcome.kind === "failed") {
        console.warn(
          `↩️  카드 취소 ${outcome.status}: id=${req.params.id} · ${reason ?? result}` +
            (outcome.status === "TIMEOUT"
              ? " — ⚠️ 카드 상태를 알 수 없습니다. 사장님 앱에서 확인이 필요합니다."
              : "")
        );
        return res.json({ ok: true, status: outcome.status });
      }

      console.log(
        `✅ 카드 취소 완료: ${outcome.paymentKey} · 장부 반영 ${outcome.wrote.toLocaleString()}원`
      );
      return res.json({ ok: true, status: "SUCCEEDED", ledgerWritten: outcome.wrote });
    } catch (err: any) {
      console.error("card cancel result error:", err);
      // 500 을 주면 단말기 아웃박스가 재전송한다. 그게 맞다 — 카드는 이미
      // 취소됐는데 장부만 못 적은 상태이므로 반드시 다시 와야 한다.
      return res.status(500).json({ error: `취소 결과 반영 실패: ${describeDbError(err)}` });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════
// 만료 정리
// ═══════════════════════════════════════════════════════════════════════

/**
 * 만료된 취소 dispatch 를 TIMEOUT 으로 넘긴다.
 *
 * ⚠️ TIMEOUT 은 "실패" 가 아니라 "모름" 이다. 그래서 여기서 자동 재시도를 걸지
 *    않는다. 부분 유니크 인덱스가 status <> 'FAILED' 이므로 TIMEOUT 행은 그대로
 *    남아 같은 결제에 대한 새 취소를 막는다. 그게 의도다 — 카드가 이미 취소됐을
 *    수 있는 상태에서 한 번 더 거는 것보다, 사람이 사장님 앱을 확인하는 게 낫다.
 *
 *    PENDING 이 만료된 경우는 단말기가 아예 집어가지 않은 것이라 카드가 안전하지만,
 *    DELIVERED 와 구분해서 다루면 규칙이 복잡해진다. 둘 다 TIMEOUT 으로 두고
 *    사람이 목록에서 보고 판단하게 한다 (PENDING 만료는 화면에 "단말기가 받지
 *    못했습니다" 로 표시된다).
 */
export function startCancelExpirySweeper(intervalMs = 30_000) {
  const tick = async () => {
    try {
      // ── 만료된 건을 두 부류로 나눈다. 이 구분이 돈을 살린다. ──
      //
      // 상태가 아직 PENDING = **어떤 단말기도 이 건을 가져가지 않았다.**
      //   ack 는 PENDING → DELIVERED 조건부 UPDATE 이고, 플러그인은 ack 가
      //   실패하면 SDK 를 부르지 않고 그냥 빠져나온다. 그러니 PENDING 으로
      //   만료됐다는 것은 requestPaymentCancel 이 한 번도 불리지 않았다는 뜻이고,
      //   카드는 확실히 안 건드려졌다. 이건 FAILED — 다시 걸어도 안전하다.
      //
      // 이걸 TIMEOUT 으로 뭉뚱그리면 어떤 일이 벌어지냐면:
      //   단말기가 꺼져 있거나 구버전 플러그인이라 요청을 못 집어간 경우에도
      //   TIMEOUT 이 찍히고, TIMEOUT 은 부분 유니크 인덱스에 포함되므로
      //   그 결제는 **영영 다시 취소할 수 없게 잠긴다.** 아무 일도 안 일어났는데
      //   사람이 DB 를 열어야 풀리는 상태가 된다. 그건 우리가 만든 사고다.
      const undelivered = await db
        .update(paymentCancelDispatches)
        .set({
          status: "FAILED",
          respondedAt: new Date(),
          failureReason: "expired-undelivered",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentCancelDispatches.status, "PENDING"),
            lt(paymentCancelDispatches.expiresAt, new Date())
          )
        )
        .returning({ key: paymentCancelDispatches.paymentKey });
      if (undelivered.length > 0) {
        console.warn(
          `↩️  단말기가 가져가지 않은 카드취소 ${undelivered.length}건이 만료됐습니다. ` +
            `카드는 건드려지지 않았으므로 다시 요청할 수 있습니다. ` +
            `단말기 전원·네트워크·플러그인 버전을 확인하세요: ${undelivered
              .map((s) => s.key)
              .join(", ")}`
        );
      }

      // 상태가 DELIVERED = 단말기가 집어갔는데 결과를 안 보냈다.
      //   SDK 가 불렸는지, 카드가 취소됐는지 **모른다.** 모르는 것을 안다고 적으면
      //   안 되므로 TIMEOUT 으로 두고 사람을 부른다.
      const stale = await db
        .update(paymentCancelDispatches)
        .set({
          status: "TIMEOUT",
          respondedAt: new Date(),
          failureReason: "expired",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(paymentCancelDispatches.status, "DELIVERED"),
            lt(paymentCancelDispatches.expiresAt, new Date())
          )
        )
        .returning({ id: paymentCancelDispatches.id, key: paymentCancelDispatches.paymentKey });
      if (stale.length > 0) {
        console.warn(
          `⚠️  만료된 카드취소 ${stale.length}건을 TIMEOUT 으로 정리했습니다. ` +
            `카드 상태를 알 수 없으므로 사장님 앱 확인이 필요합니다: ${stale
              .map((s) => s.key)
              .join(", ")}`
        );
      }
    } catch (err) {
      console.error("cancel expiry sweeper error:", err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  process.once("SIGTERM", () => clearInterval(timer));
  process.once("SIGINT", () => clearInterval(timer));
  tick();
}
