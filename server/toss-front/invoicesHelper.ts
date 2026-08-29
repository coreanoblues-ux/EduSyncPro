/**
 * 학생 미납/선납 청구서 계산 공유 헬퍼.
 *
 * 왜 헬퍼로 뺐나:
 *   deviceGuard(routes.ts) 와 kioskGuard(kioskRoutes.ts) 두 라우터가 미납 청구서 조회를
 *   똑같이 하고 있었다. 0.3.2 이전에는 항상 [지난달, 이번달] 두 달만 봤는데, 이번 커밋에서
 *   "선납 최대 6개월" 을 열어 주면 두 곳을 각각 고치다가 어긋난다. 한 곳으로 몰아 둔다.
 *
 * 반환 순서:
 *   과거(미납) → 현재 → 미래(선납) 순으로 붙는다. 태블릿·플러그인 화면에서 위에서
 *   아래로 읽었을 때 "오래된 미납이 먼저 눈에 띄도록" 하기 위함이다. 원장 실무에서
 *   미납이 있는데 선납부터 하는 케이스는 예외 취급.
 *
 * 잔액 계산:
 *   payments.amount 부호 규칙 — 원비 양수, 환불 음수. 그대로 SUM 하면 순 결제액.
 *   (해당 학생/등록/월 기준). tuition - paidSoFar > 0 이면 청구서로 남긴다.
 *   미래 월도 아직 낸 게 없으면 remaining == tuition 이 그대로 남아 선납 대상이 된다.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { payments } from "@shared/schema";
import { signVirtualInvoice } from "./virtualInvoice";
import { todayKst } from "@shared/day";

/**
 * 한 달치 납부 상태.
 *   미납  — 아직 한 푼도 안 냈다
 *   부분납 — 일부만 냈고 잔액이 남았다
 *   완납  — 다 냈다 (잔액 0 이하)
 */
export type InvoiceStatus = "미납" | "부분납" | "완납";

export interface ComputedInvoice {
  /**
   * 결제용 서명 토큰. 완납 건은 결제할 게 없으므로 null 이다.
   * null 인 청구서에 결제를 걸 수 없다는 것이 화면·서버 양쪽의 계약이다.
   */
  token: string | null;
  paymentMonth: string;
  enrollmentId: string;
  className: string;
  subject: string;
  amountDue: number;      // 지금 남은 실제 잔액 (선납 대상이면 tuition 전액)
  amountPaid: number;     // 이 달에 이미 낸 금액 (환불은 음수로 상계된 순액)
  /** 이 달의 총 청구액. 화면에서 "27만원 중 1천원 냄"을 그리려면 분모가 필요하다. */
  tuition: number;
  status: InvoiceStatus;
}

/**
 * 지난달 + 이번달 + 향후 N개월(기본 6) 에 대한 미납/선납 청구서 목록.
 *
 * monthsForward:
 *   현재 스펙은 6. UX 관점에서 반년 이상 미리 결제하는 케이스는 학원 실무에 없다고 봤고,
 *   너무 크게 잡으면 태블릿 화면 스크롤이 늘어난다. 값을 파라미터로 뺀 건 나중에 조절
 *   여지를 두기 위함이지 지금 다양한 값을 넣기 위함이 아니다.
 */
export async function computeStudentInvoices(
  tenantId: string,
  studentId: string,
  studentName: string,
  monthsForward = 6,
  /**
   * 완납된 달도 목록에 포함할지.
   *
   *   false (기본) — 결제할 것만 준다. 단말기 플러그인처럼 "지금 결제할 대상"만
   *                  필요한 쪽의 동작을 바꾸지 않기 위해 기본값을 유지한다.
   *   true         — 태블릿용. 원장 요청: "그 달의 미납·부분납·완납 상태가 보였으면".
   *                  완납이라 목록에서 사라지면 학부모는 낸 건지 시스템이 모르는 건지
   *                  구분할 수 없다. 낸 것도 "완납"으로 보여 줘야 안심한다.
   */
  includeSettled = false
): Promise<ComputedInvoice[]> {
  const enrollmentsRows = await storage.getActiveEnrollmentsWithClass(tenantId, studentId);

  const today = todayKst();
  const thisMonth = today.slice(0, 7);
  const [y, m] = thisMonth.split("-").map(Number);

  // 지난 달 (미납분)
  const prevYear = m === 1 ? y - 1 : y;
  const prevMonth = m === 1 ? 12 : m - 1;
  const lastMonth = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;

  // 향후 monthsForward 개월 (선납분)
  const futureMonths: string[] = [];
  for (let i = 1; i <= monthsForward; i++) {
    const fm = m + i;
    const fy = y + Math.floor((fm - 1) / 12);
    const fmm = ((fm - 1) % 12) + 1;
    futureMonths.push(`${fy}-${String(fmm).padStart(2, "0")}`);
  }

  const months = [lastMonth, thisMonth, ...futureMonths];

  const invoices: ComputedInvoice[] = [];

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

      const status: InvoiceStatus =
        remaining <= 0 ? "완납" : amountPaid > 0 ? "부분납" : "미납";

      if (remaining <= 0 && !includeSettled) continue;

      // 서명된 청구서 토큰. `amount` 는 지금 시점의 잔액 상한이며 dispatch 단계에서
      // 다시 DB 로 실제 잔액을 계산해 확인한다 (요청 금액은 min(signedAmount, dbRemaining) 이하).
      //
      // 완납 건에는 토큰을 발급하지 않는다. 서명이 없으면 dispatch 를 만들 수 없으므로,
      // "완납인데 실수로 또 결제" 가 화면 버그로도 일어날 수 없다. 금액이 0 이하인
      // 토큰은 어차피 dispatch 에서 거절되지만, 아예 발급하지 않는 편이 더 확실하다.
      const token =
        remaining > 0
          ? signVirtualInvoice({
              tenantId,
              studentId,
              studentName,
              enrollmentId: e.id,
              paymentMonth: month,
              amount: remaining,
              className: e.className,
            })
          : null;

      invoices.push({
        token,
        paymentMonth: month,
        enrollmentId: e.id,
        className: e.className,
        subject: e.classSubject,
        // 완납이면 잔액을 0 으로 정규화한다. 초과 납부(환불 예정)를 음수로 흘려보내면
        // 화면에 "-3,000원" 같은 값이 그대로 찍힌다.
        amountDue: Math.max(0, remaining),
        amountPaid,
        tuition,
        status,
      });
    }
  }

  return invoices;
}
