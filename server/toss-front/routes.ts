/**
 * Toss Front 플러그인 전용 API.
 *
 * 두 종류의 인증이 섞인다:
 *   - authGuard: 원장이 브라우저에서 단말기를 발급·폐기하는 관리 엔드포인트.
 *   - deviceGuard: 단말기 플러그인이 학생 조회·청구서 조회로 호출하는 엔드포인트.
 *
 * 두 인증 경로는 미들웨어 단에서 완전히 분리돼 있다. 원장 토큰으로 학생 검색
 * API를 부를 수 없고, 단말기 토큰으로 다른 단말기를 만들 수도 없다.
 *
 * 지금 커밋에서 담는 것: 장치 발급·목록·삭제, 세션 발급, 학생 조회, 미납 청구서 조회.
 * 결제 intent 생성·확정은 다음 커밋에서 붙인다.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import {
  students,
  enrollments,
  classes,
  tossFrontDevices,
  payments,
} from "@shared/schema";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";
import {
  deviceGuard,
  generateDeviceKey,
  hashDeviceKey,
  issueAccessTokenFromDeviceKey,
} from "./deviceAuth";
import { signVirtualInvoice } from "./virtualInvoice";
import { todayKst } from "@shared/day";

const router = Router();

// ─── 장치 발급 (원장 전용) ──────────────────────────────────────────────
/**
 * 원장이 새 단말기 하나를 등록한다.
 *
 * 응답에 담긴 deviceKey는 딱 한 번만 반환된다. 저장을 놓쳤으면 삭제하고 새로
 * 만드는 것 외에는 되찾을 방법이 없다. 이건 실수가 아니라 의도된 설계다 —
 * 서버가 원문 키를 알고 있다면 유출 시 방어할 수단이 없어진다.
 */
const enrollBodySchema = z.object({
  displayName: z.string().trim().min(1, "단말기 이름이 필요합니다.").max(64),
});

router.post(
  "/devices/enroll",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const parsed = enrollBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "요청이 잘못되었습니다." });
    }
    const tenantId = req.user!.tenantId;
    if (!tenantId) {
      return res.status(403).json({ error: "테넌트가 없는 계정은 단말기를 등록할 수 없습니다." });
    }

    // 토스 가맹점 ID. 학원마다 하나이며 개발자센터에서 발급받아 환경변수로 넣는다.
    // 아직 tenants 테이블에 넣지 않은 이유: 단일 학원 운영 중이라 env 하나로 충분하고,
    // 나중에 다중 학원으로 갈 때 tenant 컬럼으로 옮겨도 이 코드 흐름이 그대로 유지된다.
    const merchantId = process.env.TOSS_MERCHANT_ID;
    if (!merchantId) {
      return res.status(500).json({
        error: "TOSS_MERCHANT_ID 환경변수가 설정되어 있지 않습니다.",
      });
    }

    const rawKey = generateDeviceKey();
    const keyHash = hashDeviceKey(rawKey);

    const [row] = await db
      .insert(tossFrontDevices)
      .values({
        tenantId,
        merchantId,
        displayName: parsed.data.displayName,
        deviceKeyHash: keyHash,
        isActive: true,
      })
      .returning();

    return res.status(201).json({
      id: row.id,
      displayName: row.displayName,
      deviceKey: rawKey, // ⚠️ 이 응답 한 번만 반환된다.
      warning: "이 deviceKey는 다시 볼 수 없습니다. 단말기에 저장하세요.",
    });
  }
);

/** 원장 화면에서 단말기 목록·상태를 보여준다. */
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
        id: tossFrontDevices.id,
        displayName: tossFrontDevices.displayName,
        isActive: tossFrontDevices.isActive,
        lastSeenAt: tossFrontDevices.lastSeenAt,
        createdAt: tossFrontDevices.createdAt,
      })
      .from(tossFrontDevices)
      .where(eq(tossFrontDevices.tenantId, tenantId));
    return res.json(rows);
  }
);

/**
 * 단말기 폐기. 물리 삭제가 아니라 isActive=false로만 바꾼다.
 *
 * 이유: 이 장치로 처리된 과거 결제·출석 로그가 device_id를 참조하고 있어서,
 * 진짜로 지우면 나중에 "누가 이 결제를 받았나" 추적이 끊긴다. 대신 비활성
 * 처리하면 다음 접근 토큰 요청부터 즉시 거절된다.
 */
router.delete(
  "/devices/:id",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    if (!tenantId) return res.status(403).json({ error: "테넌트가 없습니다." });
    await db
      .update(tossFrontDevices)
      .set({ isActive: false })
      .where(and(eq(tossFrontDevices.id, req.params.id), eq(tossFrontDevices.tenantId, tenantId)));
    return res.json({ ok: true });
  }
);

// ─── 접근 토큰 발급 (단말기 → 서버) ───────────────────────────────────
/**
 * 단말기가 15분짜리 접근 토큰을 받는다.
 *
 * deviceKey는 요청 바디로만 받는다. URL 쿼리에 담으면 nginx/로드밸런서 접근
 * 로그에 남아 유출 위험이 커진다.
 */
const sessionBodySchema = z.object({
  deviceKey: z.string().min(1),
});

router.post("/session", async (req: Request, res: Response) => {
  const parsed = sessionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "deviceKey가 필요합니다." });
  }
  const result = await issueAccessTokenFromDeviceKey(parsed.data.deviceKey);
  if (!result) {
    // "키가 틀렸다"와 "비활성화됐다"를 구분해 주지 않는다. 공격자에게 힌트를 주지 않기 위해.
    return res.status(401).json({ error: "단말기 인증에 실패했습니다." });
  }
  return res.json({
    accessToken: result.accessToken,
    expiresInSeconds: 15 * 60,
    device: result.device,
  });
});

// ─── 학생 검색 (단말기) ────────────────────────────────────────────────
/**
 * 부모 전화번호 뒤 4자리로 학생 검색.
 *
 * 왜 뒤 4자리인가:
 *   전체 번호를 단말기 화면에 치면 오래 걸리고 옆 사람도 본다. 뒤 4자리는
 *   본인 확인용으로 학원에서도 이미 쓰는 관행이다. 동명이인은 학년·학교를
 *   함께 반환해 원장·단말기 조작자가 눈으로 골라내게 한다.
 *
 * 왜 뒤 4자리만 색인하지 않았나:
 *   학생 수가 학원 하나에 수백 명 규모라서 전체 스캔이 부담이 되지 않는다.
 *   따로 색인 컬럼을 만들면 학생 저장할 때마다 그 컬럼도 손봐야 해서
 *   기존 학생 CRUD 코드에 곁가지가 생긴다.
 */
const searchBodySchema = z.object({
  phoneSuffix: z.string().regex(/^\d{4}$/, "뒤 4자리 숫자여야 합니다."),
});

router.post("/students/search", deviceGuard, async (req: Request, res: Response) => {
  const parsed = searchBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message });
  }
  const suffix = parsed.data.phoneSuffix;
  const tenantId = req.device!.tenantId;

  // parentPhone의 하이픈·공백을 무시하고 뒤 4자리 매칭.
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

  return res.json(rows);
});

// ─── 학생 상세 (단말기) ────────────────────────────────────────────────
router.get("/students/:id", deviceGuard, async (req: Request, res: Response) => {
  const tenantId = req.device!.tenantId;
  const student = await storage.getStudent(req.params.id);
  if (!student || student.tenantId !== tenantId) {
    return res.status(404).json({ error: "학생을 찾을 수 없습니다." });
  }
  const enrollmentsRows = await storage.getActiveEnrollmentsWithClass(tenantId, student.id);
  return res.json({
    id: student.id,
    name: student.name,
    school: student.school,
    grade: student.grade,
    parentPhone: student.parentPhone,
    enrollments: enrollmentsRows.map((e) => ({
      id: e.id,
      classId: e.classId,
      className: e.className,
      subject: e.classSubject,
    })),
  });
});

// ─── 미납 청구서 조회 (단말기) ────────────────────────────────────────
/**
 * 이 학생이 지금 낼 수 있는 청구서 목록.
 *
 * 학원의 결제 실무:
 *   - 매달 8일이 "그 달 원비 마감 기준일" (enrollments.dueDay 기본값 8)
 *   - 이번 달분과 지난 달 미납분이 함께 보이는 게 자연스럽다
 *   - 이번 달 청구서를 만드는 건 8일이 되기 전이라도 원장이 미리 받고 싶어함
 *
 * 구현:
 *   - 이번 달과 지난 달 두 개 월(YYYY-MM)에 대해 각 활성 등록의 (수강료 - 실적) 계산
 *   - 잔액 > 0 이면 청구서 하나 만들어 JWT로 서명해 담는다
 *   - 이 토큰은 결제 요청 때 그대로 서버로 다시 온다 (다음 커밋의 intent에서 소비)
 */
router.get("/students/:id/invoices", deviceGuard, async (req: Request, res: Response) => {
  const tenantId = req.device!.tenantId;
  const student = await storage.getStudent(req.params.id);
  if (!student || student.tenantId !== tenantId) {
    return res.status(404).json({ error: "학생을 찾을 수 없습니다." });
  }

  const enrollmentsRows = await storage.getActiveEnrollmentsWithClass(tenantId, student.id);

  const today = todayKst();
  const thisMonth = today.slice(0, 7);
  // 지난 달: 문자열로 계산해서 시간대 문제를 아예 없앤다.
  const [y, m] = thisMonth.split("-").map(Number);
  const prevYear = m === 1 ? y - 1 : y;
  const prevMonth = m === 1 ? 12 : m - 1;
  const lastMonth = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;

  const months = [lastMonth, thisMonth]; // 지난 달 먼저 → 화면에서 오래된 게 위

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
      // payments.amount 부호 규칙: 원비 양수, 환불 음수. 그대로 더하면 순액.
      const amountPaid = rows.reduce((s, r) => s + r.amount, 0);
      const remaining = tuition - amountPaid;
      if (remaining <= 0) continue;

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

  return res.json({ studentId: student.id, studentName: student.name, invoices });
});

export default router;
