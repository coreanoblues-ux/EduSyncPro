/**
 * 학생용 태블릿 웹앱(StudentKiosk) 전용 API.
 *
 * routes.ts (프론트 플러그인용 deviceGuard 라우트)는 그대로 두고, 여기에 태블릿용
 * kioskGuard 라우트만 새로 담는다. 두 파일이 학생/청구서 조회 로직을 공유하지만
 * 인증 미들웨어가 다르기 때문에 라우터를 분리한다.
 *
 * 발급 흐름:
 *   - 원장: authGuard로 POST /kiosk/devices/enroll → 원문 키 한 번 노출
 *   - 태블릿: 별도 인증 없이 POST /kiosk/session (rawKey) → 15분 accessToken
 *   - 태블릿: kioskGuard로 학생 검색·청구서 조회·dispatch 생성
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import {
  students,
  payments,
  kioskDevices,
  tossFrontDevices,
} from "@shared/schema";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";
import {
  kioskGuard,
  generateKioskKey,
  hashKioskKey,
  issueAccessTokenFromKioskKey,
} from "./kioskAuth";
import { signVirtualInvoice } from "./virtualInvoice";
import { todayKst } from "@shared/day";

const router = Router();

// ─── 태블릿 발급 (원장) ────────────────────────────────────────────────
const enrollBodySchema = z.object({
  displayName: z.string().trim().min(1, "태블릿 이름이 필요합니다.").max(64),
  // 이 태블릿에서 만든 결제요청을 어느 프론트로 보낼지. 미지정 시 tenant 내 첫 활성 프론트로 자동 라우팅.
  pairedFrontDeviceId: z.string().uuid().optional(),
});

router.post(
  "/devices/enroll",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const parsed = enrollBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message });
    }
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.status(403).json({ error: "테넌트가 없는 계정입니다." });

    // 페어링 대상 프론트가 지정되면 소유권 검증
    if (parsed.data.pairedFrontDeviceId) {
      const [front] = await db
        .select({ id: tossFrontDevices.id, tenantId: tossFrontDevices.tenantId })
        .from(tossFrontDevices)
        .where(eq(tossFrontDevices.id, parsed.data.pairedFrontDeviceId));
      if (!front || front.tenantId !== tenantId) {
        return res.status(400).json({ error: "페어링하려는 프론트 단말기를 찾을 수 없습니다." });
      }
    }

    const rawKey = generateKioskKey();
    const [row] = await db
      .insert(kioskDevices)
      .values({
        tenantId,
        kioskKeyHash: hashKioskKey(rawKey),
        displayName: parsed.data.displayName,
        pairedFrontDeviceId: parsed.data.pairedFrontDeviceId ?? null,
        isActive: true,
      })
      .returning();

    return res.status(201).json({
      id: row.id,
      displayName: row.displayName,
      pairedFrontDeviceId: row.pairedFrontDeviceId,
      kioskKey: rawKey, // ⚠️ 한 번만 반환
      warning: "이 kioskKey는 다시 볼 수 없습니다. 태블릿에 저장하세요.",
    });
  }
);

router.get(
  "/devices",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.json([]);
    const rows = await db
      .select({
        id: kioskDevices.id,
        displayName: kioskDevices.displayName,
        pairedFrontDeviceId: kioskDevices.pairedFrontDeviceId,
        isActive: kioskDevices.isActive,
        lastSeenAt: kioskDevices.lastSeenAt,
        createdAt: kioskDevices.createdAt,
      })
      .from(kioskDevices)
      .where(eq(kioskDevices.tenantId, tenantId));
    return res.json(rows);
  }
);

router.delete(
  "/devices/:id",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.status(403).json({ error: "테넌트가 없습니다." });
    await db
      .update(kioskDevices)
      .set({ isActive: false })
      .where(and(eq(kioskDevices.id, req.params.id), eq(kioskDevices.tenantId, tenantId)));
    return res.json({ ok: true });
  }
);

// ─── 세션 발급 (태블릿) ────────────────────────────────────────────────
const sessionBodySchema = z.object({
  kioskKey: z.string().min(1),
});

router.post("/session", async (req: Request, res: Response) => {
  const parsed = sessionBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "kioskKey가 필요합니다." });
  const result = await issueAccessTokenFromKioskKey(parsed.data.kioskKey);
  if (!result) return res.status(401).json({ error: "태블릿 인증 실패." });
  return res.json({
    accessToken: result.accessToken,
    expiresInSeconds: 15 * 60,
    kiosk: result.kiosk,
  });
});

// ─── 학생 검색 (태블릿) ────────────────────────────────────────────────
const searchBodySchema = z.object({
  phoneSuffix: z.string().regex(/^\d{4}$/, "뒤 4자리 숫자여야 합니다."),
});

router.post("/students/search", kioskGuard, async (req: Request, res: Response) => {
  const parsed = searchBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const suffix = parsed.data.phoneSuffix;
  const tenantId = req.kiosk!.tenantId;

  const rows = await db
    .select({
      id: students.id,
      name: students.name,
      school: students.school,
      grade: students.grade,
      parentPhone: students.parentPhone,
    })
    .from(students)
    .where(
      and(
        eq(students.tenantId, tenantId),
        eq(students.isActive, true),
        sql`regexp_replace(coalesce(${students.parentPhone}, ''), '[^0-9]', '', 'g') LIKE ${"%" + suffix}`
      )
    )
    .limit(20);

  // 개인정보 최소화: 이름은 첫 글자만 남기고 마스킹, 전화는 뒷자리만 남긴다.
  // 태블릿 화면에는 다수가 지나가므로 노출을 줄인다. 원장·강사 화면(관리자)은 마스킹하지 않는다.
  const masked = rows.map((r) => ({
    id: r.id,
    nameMasked: r.name.length <= 1 ? r.name : r.name.charAt(0) + "○".repeat(r.name.length - 1),
    school: r.school,
    grade: r.grade,
    parentPhoneMasked: r.parentPhone
      ? r.parentPhone.replace(/(\d{2,3})[-\s]?(\d{3,4})[-\s]?(\d{4})/, "***-****-$3")
      : null,
  }));
  return res.json(masked);
});

// ─── 미납 청구서 조회 (태블릿) ────────────────────────────────────────
router.get("/students/:id/invoices", kioskGuard, async (req: Request, res: Response) => {
  const tenantId = req.kiosk!.tenantId;
  const student = await storage.getStudent(req.params.id);
  if (!student || student.tenantId !== tenantId) {
    return res.status(404).json({ error: "학생을 찾을 수 없습니다." });
  }

  const enrollmentsRows = await storage.getActiveEnrollmentsWithClass(tenantId, student.id);

  const today = todayKst();
  const thisMonth = today.slice(0, 7);
  const [y, m] = thisMonth.split("-").map(Number);
  const prevYear = m === 1 ? y - 1 : y;
  const prevMonth = m === 1 ? 12 : m - 1;
  const lastMonth = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
  const months = [lastMonth, thisMonth];

  const invoices: Array<{
    token: string;
    paymentMonth: string;
    enrollmentId: string;
    className: string;
    subject: string;
    amountDue: number;
    amountPaid: number;
  }> = [];

  for (const e of enrollmentsRows) {
    const tuition = e.tuition ?? e.defaultTuition;
    if (!tuition || tuition <= 0) continue;

    for (const month of months) {
      const rows = await db
        .select({ amount: payments.amount })
        .from(payments)
        .where(
          and(
            eq(payments.enrollmentId, e.id),
            eq(payments.paymentMonth, month),
            eq(payments.tenantId, tenantId)
          )
        );
      const amountPaid = rows.reduce((s, r) => s + r.amount, 0);
      const remaining = tuition - amountPaid;
      if (remaining <= 0) continue;

      // 서명된 청구서 토큰. 태블릿이 결제하기를 누르면 이 토큰을 그대로 서버로 되보내
      // dispatch를 만든다. 금액 조작 방지가 목적.
      const token = signVirtualInvoice({
        tenantId,
        studentId: student.id,
        studentName: student.name,
        enrollmentId: e.id,
        paymentMonth: month,
        amount: remaining,
        className: e.className,
      });
      invoices.push({
        token,
        paymentMonth: month,
        enrollmentId: e.id,
        className: e.className,
        subject: e.classSubject,
        amountDue: remaining,
        amountPaid,
      });
    }
  }

  // 태블릿에는 학생 이름을 그대로 노출한다 (본인이 이미 선택한 학생이므로).
  return res.json({ studentId: student.id, studentName: student.name, invoices });
});

export default router;
