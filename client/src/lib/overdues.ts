import type { Class, Enrollment, Payment, Student } from "@shared/schema";

export interface OverdueInfo {
  enrollment: Enrollment;
  student: Student;
  class: Class;
  /** 미납으로 판정된 달들 ("YYYY-MM"), 오래된 순 */
  overdueMonths: string[];
  totalOverdueAmount: number;
  latestOverdueMonth: string;
}

/**
 * 활성 수강 등록을 훑어 미납 건을 뽑는다.
 *
 * 대시보드와 미납 관리 화면이 같은 숫자를 보여야 하므로 계산을 한곳에 둔다.
 * 두 곳에 따로 두면 한쪽만 고쳐졌을 때 "미납 3명"이라 써 놓고 목록에는 5명이
 * 뜨는 상황이 생긴다.
 *
 * 판정 기준: 해당 월의 납부 기준일이 이미 지났는데 그 달 수납액의 순합계가
 * 0 이하이면 미납. 환불(음수)이 섞이므로 "기록 존재"가 아니라 순액으로 본다.
 */
export function computeOverdues(
  enrollments: Enrollment[],
  payments: Payment[],
  students: Student[],
  classes: Class[],
  now: Date = new Date()
): OverdueInfo[] {
  if (!enrollments.length || !students.length || !classes.length) return [];

  const studentById = new Map(students.map((s) => [s.id, s]));
  const classById = new Map(classes.map((c) => [c.id, c]));

  const result: OverdueInfo[] = [];

  for (const enrollment of enrollments) {
    if (!enrollment.isActive) continue;

    const student = studentById.get(enrollment.studentId);
    const classItem = classById.get(enrollment.classId);
    if (!student || !classItem) continue;

    const startDate = new Date(enrollment.startDate);
    const endDate = enrollment.endDate ? new Date(enrollment.endDate) : now;
    const dueDay = enrollment.dueDay || 8;
    const tuitionAmount = enrollment.tuition || classItem.defaultTuition || 0;

    const overdueMonths: string[] = [];
    let totalOverdueAmount = 0;

    const checkDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    while (checkDate <= endDate && checkDate <= now) {
      const year = checkDate.getFullYear();
      const month = checkDate.getMonth() + 1;
      const paymentMonth = `${year}-${String(month).padStart(2, "0")}`;

      if (now > new Date(year, month - 1, dueDay)) {
        const netPaid = payments
          .filter((p) => p.enrollmentId === enrollment.id && p.paymentMonth === paymentMonth)
          .reduce((sum, p) => sum + (p.amount || 0), 0);

        if (netPaid <= 0) {
          overdueMonths.push(paymentMonth);
          totalOverdueAmount += tuitionAmount;
        }
      }

      checkDate.setMonth(checkDate.getMonth() + 1);
    }

    if (overdueMonths.length > 0) {
      result.push({
        enrollment,
        student,
        class: classItem,
        overdueMonths,
        totalOverdueAmount,
        latestOverdueMonth: overdueMonths[overdueMonths.length - 1],
      });
    }
  }

  return result;
}
