/**
 * 가상 청구서 토큰.
 *
 * EduSyncPro에는 invoices 테이블이 없다. 미납은 enrollments의 수강료와 payments의
 * 실적을 그때그때 뺀 값이다. 그런 걸 굳이 표로 만들지 않은 이유:
 *   - 원장이 수강료·월을 자유롭게 손볼 수 있어야 하고, 청구서 표가 있으면
 *     반드시 그 표를 갱신해야 하는 부담이 생긴다.
 *   - 미납은 "언제 물어봐도 맞아야" 하는 정보라서 계산이 유일한 원본이다.
 *
 * 결제 흐름에는 문제가 있다. 단말기가 "학생 X의 3월분 12만원"을 결제할 때,
 * 그 (학생, 월, 금액) 조합을 서버가 나중에 위조 없이 되짚을 수 있어야 한다.
 * 그래서 조회 시점에 청구 정보를 JWT로 서명한 짧은 토큰을 만들어 단말기에
 * 건네고, 결제 요청이 돌아올 때 이 토큰으로만 금액·대상·기간을 받는다.
 *
 * 이 토큰만으로는 결제되지 않는다. 실제 승인 흐름은 paymentIntent가 담당하고,
 * 이 토큰은 그 intent를 만들 때의 "확인용 재료"다. 유효 기간이 짧아서(15분)
 * 단말기 화면에 오래 열어 둔 청구서를 다시 눌러도 자동으로 만료된다.
 */

import crypto from "crypto";
import jwt from "jsonwebtoken";

const SECRET =
  process.env.TOSS_FRONT_INVOICE_SECRET ||
  process.env.JWT_SECRET ||
  crypto.randomBytes(32).toString("hex");

if (!process.env.TOSS_FRONT_INVOICE_SECRET && !process.env.JWT_SECRET) {
  console.warn(
    "⚠️  TOSS_FRONT_INVOICE_SECRET 미설정 — 부팅마다 새 키를 만들어 씁니다."
  );
}

const INVOICE_TTL_SECONDS = 15 * 60;

export interface VirtualInvoicePayload {
  tenantId: string;
  studentId: string;
  studentName: string;
  enrollmentId: string;
  paymentMonth: string; // YYYY-MM
  amount: number; // 원 단위 정수, 양수
  className: string;
}

export function signVirtualInvoice(payload: VirtualInvoicePayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: INVOICE_TTL_SECONDS });
}

/**
 * 결제 확정 직전에 이 함수로 검증한다. 반환된 payload는 signVirtualInvoice에
 * 넣은 것과 동일 — 즉 서버가 발급한 값 그대로다. 만료·서명 실패는 null.
 */
export function verifyVirtualInvoice(token: string): VirtualInvoicePayload | null {
  try {
    const raw = jwt.verify(token, SECRET) as VirtualInvoicePayload & {
      iat?: number;
      exp?: number;
    };
    // jwt는 iat/exp 필드도 얹어 주지만, 우리는 원본 payload만 되돌린다.
    return {
      tenantId: raw.tenantId,
      studentId: raw.studentId,
      studentName: raw.studentName,
      enrollmentId: raw.enrollmentId,
      paymentMonth: raw.paymentMonth,
      amount: raw.amount,
      className: raw.className,
    };
  } catch {
    return null;
  }
}
