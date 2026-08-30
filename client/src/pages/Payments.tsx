import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, User, BookOpen, CheckCircle, XCircle, CreditCard, Calendar, AlertTriangle, PauseCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Payment, Enrollment, Student, Class, Teacher } from "@shared/schema";
import {
  computeMonthStatus,
  PARTIAL_PAYMENT_SINCE,
  isOutstanding,
  totalOutstanding as sumOutstanding,
  withPrepaidMonths,
  type MonthPayment,
} from "@shared/paymentStatus";

interface PaymentsProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
}

interface StudentWithPaymentStatus {
  id: string;
  name: string;
  grade?: string | null;
  enrollment: Enrollment;
  latestPayment?: Payment;
  isPaid: boolean;
  tuition: number;
  unpaidMonths: string[];
  paidMonths: string[];
  /**
   * 재원 기간의 모든 달 (미납·부분납·완납 전부). 화면은 이걸로 그린다.
   * unpaidMonths/paidMonths 는 여기서 파생된 값이고, "부분납"은 둘 중
   * 어디에도 정직하게 담기지 않기 때문에 원본을 따로 들고 다닌다.
   */
  months: MonthPayment[];
  /** 이 학생에게 아직 받아야 할 총액. 개월수×수강료가 아니라 실제 잔액의 합. */
  outstanding: number;
}

interface ClassWithStudents {
  id: string;
  name: string;
  students: StudentWithPaymentStatus[];
  /** 휴원 처리된 학생. 접어 두되 버리지는 않는다. 아래 onLeave 주석 참고. */
  onLeave: StudentWithPaymentStatus[];
  schedule?: string;
}

interface TeacherWithClasses {
  id: string;
  name: string;
  subject: string;
  classes: ClassWithStudents[];
  totalStudents: number;
  paidStudents: number;
}

function getMonthsBetween(startDate: Date | string, endDate: Date | string | null | undefined, now: Date): string[] {
  const start = new Date(startDate);
  const capDate = endDate ? new Date(endDate) : now;
  const finalEnd = capDate < now ? capDate : now;

  const months: string[] = [];
  const current = new Date(start.getFullYear(), start.getMonth(), 1);
  const end = new Date(finalEnd.getFullYear(), finalEnd.getMonth(), 1);

  while (current <= end) {
    const yyyy = current.getFullYear();
    const mm = String(current.getMonth() + 1).padStart(2, '0');
    months.push(`${yyyy}-${mm}`);
    current.setMonth(current.getMonth() + 1);
  }
  return months;
}

function formatMonthLabel(month: string): string {
  const [year, m] = month.split('-');
  return `${year}.${m}`;
}

export default function Payments({ userRole }: PaymentsProps) {
  const [expandedTeachers, setExpandedTeachers] = useState<Set<string>>(new Set());
  const [expandedClasses, setExpandedClasses] = useState<Set<string>>(new Set());
  /** 휴원 학생 명단을 펼쳐 둔 반. 기본은 접힘 — 수납할 대상이 아니기 때문이다. */
  const [expandedOnLeave, setExpandedOnLeave] = useState<Set<string>>(new Set());
  const [paymentDialog, setPaymentDialog] = useState<{
    isOpen: boolean;
    student?: StudentWithPaymentStatus;
    enrollment?: Enrollment;
    paymentMonth?: string;
  }>({ isOpen: false });
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  
  const { toast } = useToast();

  const { data: teachers = [], isLoading: teachersLoading } = useQuery<Teacher[]>({
    queryKey: ['/api/teachers'],
  });

  const { data: classes = [], isLoading: classesLoading } = useQuery<Class[]>({
    queryKey: ['/api/classes'],
  });

  const { data: students = [], isLoading: studentsLoading } = useQuery<Student[]>({
    queryKey: ['/api/students'],
  });

  const { data: enrollments = [], isLoading: enrollmentsLoading } = useQuery<Enrollment[]>({
    queryKey: ['/api/enrollments'],
  });

  // 이 화면만 주기적으로 다시 읽는다.
  //
  // 왜: 앱 전역 기본값이 staleTime Infinity + refetchInterval false 라서, 한 번
  // 띄운 수납 화면은 새로고침 전까지 절대 갱신되지 않는다. 그런데 Toss Front
  // 단말기 결제는 서버가 같은 payments 테이블에 직접 INSERT 한다
  // (server/toss-front/payments.ts 의 confirm, webhooks.ts). 즉 DB 에는 즉시
  // 반영되는데 원장이 보고 있는 화면만 옛날 숫자로 멈춰 있었다. 학생이 단말기로
  // 결제를 끝냈는데 수납 화면은 계속 미납이라고 말하는 상태다.
  //
  // 결제 건은 다른 목록보다 훨씬 빨리 변하고, 틀리면 돈 문제로 이어지므로
  // 여기만 폴링 + 창 포커스 시 갱신을 켠다. 다른 쿼리는 그대로 둔다.
  //
  // ── 왜 20초에서 5초로 내렸나 (2026-08-30, 원장 요청) ──
  //   원장의 말: "실제 카드결제 후에는 바로 자동으로 수납등록이 처리되었으면
  //   좋겠음." 카운터에서 학생이 카드를 대고, 원장은 이 화면을 보고 있다. 그
  //   장면에서 20초는 "바로" 가 아니다 — 원장은 반영이 안 된 줄 알고 새로고침을
  //   누르거나 수기 입력을 시작한다. 수기 입력이 들어가면 나중에 자동 반영이
  //   도착했을 때 같은 돈이 두 줄이 된다.
  //
  //   5초로 내려도 비용은 크지 않다. /api/payments 는 학원 하나의 결제 목록이고
  //   이 화면을 열어 두는 사람은 보통 원장 한 명이다. 화면을 벗어나면 쿼리가
  //   멈추고, refetchIntervalInBackground 를 켜지 않았으므로 탭이 뒤에 있는
  //   동안에는 브라우저가 알아서 쉰다.
  const { data: payments = [], isLoading: paymentsLoading } = useQuery<Payment[]>({
    queryKey: ['/api/payments'],
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  const addPaymentMutation = useMutation({
    mutationFn: async (data: { enrollmentId: string; amount: number; paidDate: string; paymentMonth: string }) => {
      const payload = {
        enrollmentId: data.enrollmentId,
        amount: data.amount,
        paymentMonth: data.paymentMonth,
        paidDate: new Date(data.paidDate).toISOString(),
        notes: "간편 납부",
      };
      
      const response = await apiRequest('POST', '/api/payments', payload);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
      setPaymentDialog({ isOpen: false });
      setPaymentAmount("");
      toast({
        title: "납부 완료",
        description: "수납이 성공적으로 등록되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "납부 실패",
        description: error.message || "납부 처리 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  const processTeacherData = (): TeacherWithClasses[] => {
    const teachersWithClasses: TeacherWithClasses[] = [];
    const now = new Date();
    const currentMonthStr = now.toISOString().slice(0, 7);
    
    teachers.forEach(teacher => {
      const teacherClasses = classes.filter(c => c.teacherId === teacher.id);
      const classesWithStudents: ClassWithStudents[] = [];
      
      teacherClasses.forEach(classItem => {
        const classEnrollments = enrollments.filter(e => e.classId === classItem.id && e.isActive);

        const onLeaveIds = new Set<string>();
        const studentsWithStatus: StudentWithPaymentStatus[] = classEnrollments.map(enrollment => {
          const student = students.find(s => s.id === enrollment.studentId);
          // 휴원 처리는 students.isActive만 내리고 수강 등록은 그대로 살려 둔다
          // (재원하면 다시 이어서 다녀야 하므로). 그래서 여기서 걸러 주지 않으면
          // 휴원한 학생이 반 명단에 그대로 남아 다달이 미납이 쌓인다.
          // 대시보드 미납 목록(lib/overdues.ts)은 이미 같은 기준으로 거른다.
          if (student && student.isActive === false) onLeaveIds.add(enrollment.id);
          const tuition = enrollment.tuition || classItem.defaultTuition || 0;

          const enrollmentPayments = payments.filter(p => p.enrollmentId === enrollment.id);

          // 달마다 순액을 낸다. 환불(음수)이 그대로 상계되므로
          // "350,000 수납 + 350,000 환불 = 0원"은 자연히 미납으로 돌아온다.
          const netByMonth = new Map<string, number>();
          for (const p of enrollmentPayments) {
            if (!p.paymentMonth) continue;
            netByMonth.set(p.paymentMonth, (netByMonth.get(p.paymentMonth) || 0) + (p.amount || 0));
          }

          // 기본은 "등록일 ~ 오늘". 여기에 미리 낸 미래 달을 얹는다.
          //
          // ⚠️ 순서 주의: netByMonth 를 먼저 만들어야 한다. 선납한 달이 어디인지는
          //    결제 내역을 봐야만 알 수 있기 때문이다. 예전에는 달 목록을 먼저
          //    만들었고, 그래서 9월에 낸 1,000원이 화면에서 통째로 사라졌다
          //    (2026-08-30 원장 실험). 이유는 shared/paymentStatus.ts 주석 참고.
          const allMonths = withPrepaidMonths(
            getMonthsBetween(enrollment.startDate, enrollment.endDate, now),
            netByMonth,
          );

          // 판정은 shared/paymentStatus.ts 한 곳에서만 한다.
          //
          // 예전에는 여기서 "순액 > 0 이면 납부완료"로 잘랐다. 그래서 27만원짜리
          // 달에 269,000원만 들어와도 초록색 완납으로 떴고, 남은 1,000원은 화면에서
          // 사라졌다 (2026-08-29 원장 지적). 이제 분모(수강료)까지 넘겨서
          // 미납/부분납/완납 세 갈래로 판정한다.
          //
          // PARTIAL_PAYMENT_SINCE 를 넘기는 이유: 이 화면은 등록일부터 지금까지
          // 전체 이력을 그린다. 과거 달의 실제 청구액이 어디에도 저장돼 있지 않아
          // 현재 수강료로 심판하면 원비를 올렸거나 할인 중인 학생의 과거가 전부
          // 부분납으로 뒤집힌다 (2026-08-29 김예진 학생 사고). 경계 이전은
          // 예전 규칙 그대로 둔다. 자세한 이유는 shared/paymentStatus.ts 주석.
          const months = allMonths.map(m =>
            computeMonthStatus(m, tuition, netByMonth.get(m) || 0, PARTIAL_PAYMENT_SINCE)
          );

          const paidMonths = months.filter(m => m.status === "완납").map(m => m.month);
          // 부분납은 아직 받을 돈이 남은 달이므로 미납 쪽에 선다.
          // 그래야 "납부하기" 버튼이 붙고 총액에도 잡힌다.
          const unpaidMonths = months.filter(isOutstanding).map(m => m.month);

          const currentMonthPaid = months.some(
            m => m.month === currentMonthStr && m.status === "완납"
          );
          // 표시용 영수증 정보는 실제 수납 기록(양수)을 우선한다.
          const latestPayment =
            enrollmentPayments.find(p => p.paymentMonth === currentMonthStr && (p.amount || 0) > 0) ??
            enrollmentPayments.find(p => p.paymentMonth === currentMonthStr);

          return {
            id: student?.id || '',
            name: student?.name || '알 수 없음',
            grade: student?.grade,
            enrollment,
            latestPayment,
            isPaid: currentMonthPaid,
            tuition,
            unpaidMonths,
            paidMonths,
            months,
            outstanding: sumOutstanding(months),
          };
        }).filter(s => s.id);
        
        classesWithStudents.push({
          id: classItem.id,
          name: classItem.name,
          students: studentsWithStatus.filter(s => !onLeaveIds.has(s.enrollment.id)),
          onLeave: studentsWithStatus.filter(s => onLeaveIds.has(s.enrollment.id)),
          schedule: classItem.schedule,
        });
      });
      
      if (teacherClasses.length > 0) {
        const totalStudents = classesWithStudents.reduce((sum, c) => sum + c.students.length, 0);
        const paidStudents = classesWithStudents.reduce((sum, c) => sum + c.students.filter(s => s.isPaid).length, 0);
        
        teachersWithClasses.push({
          id: teacher.id,
          name: teacher.name,
          subject: teacher.subject || '과목 미설정',
          classes: classesWithStudents,
          totalStudents,
          paidStudents,
        });
      }
    });
    
    return teachersWithClasses;
  };

  const handleTeacherToggle = (teacherId: string) => {
    const newExpanded = new Set(expandedTeachers);
    if (newExpanded.has(teacherId)) {
      newExpanded.delete(teacherId);
    } else {
      newExpanded.add(teacherId);
    }
    setExpandedTeachers(newExpanded);
  };

  const handleClassToggle = (classId: string) => {
    const newExpanded = new Set(expandedClasses);
    if (newExpanded.has(classId)) {
      newExpanded.delete(classId);
    } else {
      newExpanded.add(classId);
    }
    setExpandedClasses(newExpanded);
  };

  const handleOnLeaveToggle = (classId: string) => {
    const newExpanded = new Set(expandedOnLeave);
    if (newExpanded.has(classId)) {
      newExpanded.delete(classId);
    } else {
      newExpanded.add(classId);
    }
    setExpandedOnLeave(newExpanded);
  };

  /**
   * @param remaining 그 달에 아직 받아야 할 금액. 부분납인 달은 수강료 전액이 아니라
   *   잔액이 기본값으로 떠야 한다. 27만원짜리 달에 269,000원이 이미 들어왔는데
   *   입력칸에 270,000이 떠 있으면 원장이 그대로 눌러 54만원을 받은 걸로 적게 된다.
   */
  const handlePaymentClick = (
    student: StudentWithPaymentStatus,
    month: string,
    remaining?: number,
  ) => {
    const preset = remaining && remaining > 0 ? remaining : student.tuition;
    setPaymentAmount(preset.toString());
    setPaymentDate(new Date().toISOString().slice(0, 10));
    setPaymentDialog({
      isOpen: true,
      student,
      enrollment: student.enrollment,
      paymentMonth: month,
    });
  };

  const handlePaymentSubmit = () => {
    if (!paymentDialog.enrollment || !paymentAmount || !paymentDialog.paymentMonth) return;
    
    addPaymentMutation.mutate({
      enrollmentId: paymentDialog.enrollment.id,
      amount: parseInt(paymentAmount),
      paidDate: paymentDate,
      paymentMonth: paymentDialog.paymentMonth,
    });
  };

  const formatAmount = (amount: number) => {
    return `₩${amount.toLocaleString()}`;
  };

  if (teachersLoading || classesLoading || studentsLoading || enrollmentsLoading || paymentsLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">수납 관리</h1>
        </div>
        <div className="text-center py-8">
          <div className="text-muted-foreground">데이터를 불러오는 중...</div>
        </div>
      </div>
    );
  }

  const teacherData = processTeacherData();
  const currentMonth = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long' });

  const calculateFinancials = () => {
    const currentMonthString = new Date().toISOString().slice(0, 7);
    
    const totalRevenue = payments
      .filter(p => p.paymentMonth === currentMonthString)
      .reduce((sum, p) => sum + (p.amount || 0), 0);
    
    // 미납 개월수 × 수강료로 세지 않는다. 부분납이 있으면 이미 받은 269,000원까지
    // 미납으로 세어 총액이 두 배로 부풀기 때문이다. 달마다 실제 잔액을 더한다.
    const totalOutstanding = teacherData.reduce((total, teacher) => {
      return total + teacher.classes.reduce((classTotal, classItem) => {
        return classTotal + classItem.students.reduce((studentTotal, student) => {
          return studentTotal + student.outstanding;
        }, 0);
      }, 0);
    }, 0);

    const totalUnpaidStudents = teacherData.reduce((total, teacher) => {
      return total + teacher.classes.reduce((classTotal, classItem) => {
        return classTotal + classItem.students.filter(s => s.unpaidMonths.length > 0).length;
      }, 0);
    }, 0);

    return { totalRevenue, totalOutstanding, totalUnpaidStudents };
  };

  const { totalRevenue, totalOutstanding, totalUnpaidStudents } = calculateFinancials();

  return (
    <div className="space-y-6 p-6" data-testid="payments-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">수납 관리</h1>
          <p className="text-muted-foreground">
            {currentMonth} 수납 현황
          </p>
        </div>
      </div>

      {teacherData.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          <User className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <div className="text-lg font-medium">등록된 선생님이 없습니다</div>
          <p className="text-muted-foreground mt-2">선생님을 먼저 등록하고 수업을 개설해주세요.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {teacherData.map((teacher: TeacherWithClasses) => {
            const isTeacherExpanded = expandedTeachers.has(teacher.id);
            
            return (
              <Card key={teacher.id} className="overflow-hidden">
                <CardHeader 
                  className="hover-elevate cursor-pointer bg-primary/5"
                  onClick={() => handleTeacherToggle(teacher.id)}
                  data-testid={`teacher-header-${teacher.id}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {isTeacherExpanded ? (
                        <ChevronDown className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-5 w-5 text-muted-foreground" />
                      )}
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          <User className="h-5 w-5" />
                          {teacher.name} 선생님
                        </CardTitle>
                        <div className="text-sm text-muted-foreground mt-1">
                          {teacher.subject} • {teacher.classes.length}개 반
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge 
                        variant={teacher.paidStudents === teacher.totalStudents ? "default" : "secondary"}
                        className="px-3"
                      >
                        {teacher.paidStudents}/{teacher.totalStudents} 납부완료
                      </Badge>
                      <div className="text-right">
                        <div className="text-sm text-muted-foreground">수납률</div>
                        <div className="text-lg font-semibold">
                          {teacher.totalStudents > 0 ? Math.round((teacher.paidStudents / teacher.totalStudents) * 100) : 0}%
                        </div>
                      </div>
                    </div>
                  </div>
                </CardHeader>

                {isTeacherExpanded && (
                  <CardContent className="pt-0 space-y-3">
                    {teacher.classes.map((classItem: ClassWithStudents) => {
                      const isExpanded = expandedClasses.has(classItem.id);
                      const isOnLeaveExpanded = expandedOnLeave.has(classItem.id);
                      const paidCount = classItem.students.filter((s: StudentWithPaymentStatus) => s.isPaid).length;
                      const totalCount = classItem.students.length;
                      
                      return (
                        <div key={classItem.id} className="border rounded-md overflow-hidden">
                          <div 
                            className="flex items-center justify-between p-3 cursor-pointer hover-elevate bg-muted/50"
                            onClick={() => handleClassToggle(classItem.id)}
                            data-testid={`class-header-${classItem.id}`}
                          >
                            <div className="flex items-center gap-2">
                              {isExpanded ? (
                                <ChevronDown className="h-5 w-5 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-5 w-5 text-muted-foreground" />
                              )}
                              <div>
                                <div className="font-medium flex items-center gap-2">
                                  <BookOpen className="h-4 w-4" />
                                  {classItem.name}
                                </div>
                                {classItem.schedule && (
                                  <div className="text-sm text-muted-foreground mt-1">
                                    {classItem.schedule}
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge 
                                variant={paidCount === totalCount ? "default" : "secondary"}
                                className="text-xs"
                              >
                                {paidCount}/{totalCount}
                              </Badge>
                              <div className="text-sm font-medium">
                                {totalCount > 0 ? Math.round((paidCount / totalCount) * 100) : 0}%
                              </div>
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="p-2 space-y-2">
                              {classItem.students.length === 0 && (
                                <div className="py-4 text-center text-sm text-muted-foreground">
                                  {classItem.onLeave.length > 0
                                    ? "수업을 듣는 학생이 없습니다 (휴원 학생만 남아 있습니다)"
                                    : "등록된 수강생이 없습니다"}
                                </div>
                              )}
                              {classItem.students.map((student: StudentWithPaymentStatus) => (
                                <div 
                                  key={student.id}
                                  className="p-3 bg-background rounded-lg"
                                  data-testid={`student-row-${student.id}`}
                                >
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                      <div className="flex items-center gap-2">
                                        {student.outstanding === 0 ? (
                                          <CheckCircle className="h-5 w-5 text-green-600" />
                                        ) : (
                                          <XCircle className="h-5 w-5 text-red-600" />
                                        )}
                                        <span className="font-medium">{student.name}</span>
                                        {student.grade && (
                                          <Badge variant="outline" className="text-xs">
                                            {student.grade}
                                          </Badge>
                                        )}
                                      </div>
                                    </div>
                                    
                                    <div className="flex items-center gap-3">
                                      <div className="text-right">
                                        <div className="font-medium">{formatAmount(student.tuition)}/월</div>
                                        {student.outstanding > 0 ? (
                                          <div className="flex items-center gap-1 text-xs text-red-600">
                                            <AlertTriangle className="h-3 w-3" />
                                            {/* 개월수만 쓰면 "1,000원 남은 달"과 "한 푼도 안 낸 달"이
                                                똑같이 1개월로 보인다. 받을 금액을 같이 적는다. */}
                                            {student.unpaidMonths.length}개월 · {formatAmount(student.outstanding)} 미수
                                          </div>
                                        ) : (
                                          <div className="text-xs text-green-600">전월 납부완료</div>
                                        )}
                                      </div>
                                      {student.outstanding === 0 && (
                                        <Badge variant="default" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                                          납부완료
                                        </Badge>
                                      )}
                                    </div>
                                  </div>

                                  {student.outstanding > 0 && (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      {student.months.filter(isOutstanding).map((m) => {
                                        const now = new Date();
                                        const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                                        const isCurrentMonth = m.month === currentMonthStr;
                                        const canPay = userRole === 'owner' || userRole === 'teacher';
                                        const isPartial = m.status === "부분납";

                                        return (
                                          <div
                                            key={m.month}
                                            className="flex items-center gap-2 border rounded-md px-3 py-1.5 bg-muted/30"
                                            data-testid={`month-chip-${student.id}-${m.month}`}
                                          >
                                            <span className={`text-sm font-medium ${isCurrentMonth ? 'text-foreground' : 'text-red-600 dark:text-red-400'}`}>
                                              {formatMonthLabel(m.month)}
                                            </span>

                                            {/* 부분납은 "얼마 냈고 얼마 남았는지"를 다 보여 준다.
                                                금액이 없으면 원장이 남은 돈을 못 받는다. */}
                                            {isPartial ? (
                                              <>
                                                <Badge
                                                  variant="outline"
                                                  className="text-xs px-1.5 py-0 border-amber-500 text-amber-700 dark:text-amber-400"
                                                >
                                                  부분납
                                                </Badge>
                                                <span className="text-xs text-muted-foreground">
                                                  {formatAmount(m.paid)} 납부 ·{" "}
                                                  <span className="font-medium text-red-600 dark:text-red-400">
                                                    {formatAmount(m.remaining)} 남음
                                                  </span>
                                                </span>
                                              </>
                                            ) : (
                                              !isCurrentMonth && (
                                                <Badge variant="destructive" className="text-xs px-1.5 py-0">
                                                  미납
                                                </Badge>
                                              )
                                            )}

                                            {canPay && (
                                              <Button
                                                size="sm"
                                                variant={isCurrentMonth && !isPartial ? "default" : "destructive"}
                                                onClick={() => handlePaymentClick(student, m.month, m.remaining)}
                                                data-testid={`payment-button-${student.id}-${m.month}`}
                                              >
                                                <CreditCard className="h-3.5 w-3.5 mr-1" />
                                                {isPartial ? "잔액 납부" : "납부하기"}
                                              </Button>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              ))}

                              {/* 휴원 학생은 수납 대상이 아니라 접어 두지만, 명단에서 통째로
                                  지우면 원장이 "얘 어디 갔지" 하게 되므로 여기 남겨 둔다. */}
                              {classItem.onLeave.length > 0 && (
                                <div className="rounded-md border border-dashed">
                                  <button
                                    type="button"
                                    onClick={() => handleOnLeaveToggle(classItem.id)}
                                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover-elevate"
                                    data-testid={`on-leave-toggle-${classItem.id}`}
                                  >
                                    {isOnLeaveExpanded ? (
                                      <ChevronDown className="h-4 w-4" />
                                    ) : (
                                      <ChevronRight className="h-4 w-4" />
                                    )}
                                    <PauseCircle className="h-4 w-4" />
                                    휴원 {classItem.onLeave.length}명은 수납 명단에서 뺐습니다
                                  </button>

                                  {isOnLeaveExpanded && (
                                    <div className="space-y-1 px-3 pb-3">
                                      <p className="pb-1 text-xs text-muted-foreground">
                                        휴원 중에는 수업을 듣지 않으니 수강료가 더 쌓이지 않습니다.
                                        다시 수납하려면 학생 관리에서 재원 처리하세요.
                                      </p>
                                      {classItem.onLeave.map((student: StudentWithPaymentStatus) => {
                                        const lastPaid = student.paidMonths[student.paidMonths.length - 1];
                                        return (
                                          <div
                                            key={student.enrollment.id}
                                            className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm"
                                            data-testid={`on-leave-row-${student.id}`}
                                          >
                                            <div className="flex items-center gap-2">
                                              <span className="font-medium text-muted-foreground">
                                                {student.name}
                                              </span>
                                              {student.grade && (
                                                <Badge variant="outline" className="text-xs">
                                                  {student.grade}
                                                </Badge>
                                              )}
                                              <Badge variant="secondary" className="text-xs">
                                                휴원
                                              </Badge>
                                            </div>
                                            <span className="text-xs text-muted-foreground">
                                              {lastPaid
                                                ? `마지막 납부 ${formatMonthLabel(lastPaid)}`
                                                : "납부 기록 없음"}
                                            </span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={paymentDialog.isOpen} onOpenChange={(open) => setPaymentDialog({ isOpen: open })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>수납 등록</DialogTitle>
            <DialogDescription>
              {paymentDialog.student?.name} 학생의 {paymentDialog.paymentMonth ? formatMonthLabel(paymentDialog.paymentMonth) : ''} 수납을 등록합니다.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div>
              <Label>납부 대상 월</Label>
              <div className="mt-1">
                <Badge variant="secondary" className="text-sm px-3 py-1">
                  {paymentDialog.paymentMonth ? formatMonthLabel(paymentDialog.paymentMonth) : ''}
                </Badge>
              </div>
            </div>
            <div>
              <Label htmlFor="amount">수납 금액</Label>
              <Input
                id="amount"
                type="number"
                value={paymentAmount}
                onChange={(e) => setPaymentAmount(e.target.value)}
                placeholder="수납 금액을 입력하세요"
                data-testid="input-payment-amount"
              />
            </div>
            
            <div>
              <Label htmlFor="paidDate">납입 일자</Label>
              <Input
                id="paidDate"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                data-testid="input-payment-date"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPaymentDialog({ isOpen: false })}
            >
              취소
            </Button>
            <Button 
              onClick={handlePaymentSubmit}
              disabled={addPaymentMutation.isPending || !paymentAmount}
              data-testid="button-submit-payment"
            >
              {addPaymentMutation.isPending ? "처리 중..." : "납부 완료"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {teacherData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              {currentMonth} 수납 요약
            </CardTitle>
          </CardHeader>
          <CardContent className={`grid gap-4 ${userRole === 'owner' || userRole === 'superadmin' ? 'md:grid-cols-5' : 'md:grid-cols-4'}`}>
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                {teacherData.reduce((sum: number, t: TeacherWithClasses) => sum + t.classes.length, 0)}개
              </div>
              <p className="text-sm text-muted-foreground">운영 반</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {teacherData.reduce((sum: number, t: TeacherWithClasses) => sum + t.paidStudents, 0)}명
              </div>
              <p className="text-sm text-muted-foreground">전월 납부완료</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">
                {totalUnpaidStudents}명
              </div>
              <p className="text-sm text-muted-foreground">미납 학생</p>
            </div>
            {(userRole === 'owner' || userRole === 'superadmin') && (
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">
                  ₩{totalRevenue.toLocaleString()}
                </div>
                <p className="text-sm text-muted-foreground">총수납액</p>
              </div>
            )}
            <div className="text-center">
              <div className="text-2xl font-bold text-orange-600">
                ₩{totalOutstanding.toLocaleString()}
              </div>
              <p className="text-sm text-muted-foreground">총미납액</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
