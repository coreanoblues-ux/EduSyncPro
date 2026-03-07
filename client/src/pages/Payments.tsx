import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, User, BookOpen, CheckCircle, XCircle, CreditCard, Calendar, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Payment, Enrollment, Student, Class, Teacher } from "@shared/schema";

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
}

interface ClassWithStudents {
  id: string;
  name: string;
  students: StudentWithPaymentStatus[];
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

  const { data: payments = [], isLoading: paymentsLoading } = useQuery<Payment[]>({
    queryKey: ['/api/payments'],
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
        
        const studentsWithStatus: StudentWithPaymentStatus[] = classEnrollments.map(enrollment => {
          const student = students.find(s => s.id === enrollment.studentId);
          const tuition = enrollment.tuition || classItem.defaultTuition || 0;

          const allMonths = getMonthsBetween(enrollment.startDate, enrollment.endDate, now);

          const enrollmentPayments = payments.filter(p => p.enrollmentId === enrollment.id);
          const paidMonthSet = new Set(enrollmentPayments.map(p => p.paymentMonth));

          const paidMonths = allMonths.filter(m => paidMonthSet.has(m));
          const unpaidMonths = allMonths.filter(m => !paidMonthSet.has(m));

          const currentMonthPaid = paidMonthSet.has(currentMonthStr);
          const latestPayment = enrollmentPayments.find(p => p.paymentMonth === currentMonthStr);

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
          };
        }).filter(s => s.id);
        
        classesWithStudents.push({
          id: classItem.id,
          name: classItem.name,
          students: studentsWithStatus,
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

  const handlePaymentClick = (student: StudentWithPaymentStatus, month: string) => {
    setPaymentAmount(student.tuition.toString());
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
    
    const totalOutstanding = teacherData.reduce((total, teacher) => {
      return total + teacher.classes.reduce((classTotal, classItem) => {
        return classTotal + classItem.students.reduce((studentTotal, student) => {
          return studentTotal + (student.unpaidMonths.length * student.tuition);
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
                                  등록된 수강생이 없습니다
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
                                        {student.unpaidMonths.length === 0 ? (
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
                                        {student.unpaidMonths.length > 0 ? (
                                          <div className="flex items-center gap-1 text-xs text-red-600">
                                            <AlertTriangle className="h-3 w-3" />
                                            {student.unpaidMonths.length}개월 미납
                                          </div>
                                        ) : (
                                          <div className="text-xs text-green-600">전월 납부완료</div>
                                        )}
                                      </div>
                                      {student.unpaidMonths.length === 0 && (
                                        <Badge variant="default" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                                          납부완료
                                        </Badge>
                                      )}
                                    </div>
                                  </div>

                                  {student.unpaidMonths.length > 0 && (
                                    <div className="mt-3 flex flex-wrap gap-2">
                                      {student.unpaidMonths.map((month) => {
                                        const now = new Date();
                                        const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                                        const isCurrentMonth = month === currentMonthStr;
                                        const canPay = userRole === 'owner' || userRole === 'teacher';

                                        return (
                                          <div
                                            key={month}
                                            className="flex items-center gap-2 border rounded-md px-3 py-1.5 bg-muted/30"
                                          >
                                            <span className={`text-sm font-medium ${isCurrentMonth ? 'text-foreground' : 'text-red-600 dark:text-red-400'}`}>
                                              {formatMonthLabel(month)}
                                            </span>
                                            {!isCurrentMonth && (
                                              <Badge variant="destructive" className="text-xs px-1.5 py-0">
                                                미납
                                              </Badge>
                                            )}
                                            {canPay && (
                                              <Button
                                                size="sm"
                                                variant={isCurrentMonth ? "default" : "destructive"}
                                                onClick={() => handlePaymentClick(student, month)}
                                                data-testid={`payment-button-${student.id}-${month}`}
                                              >
                                                <CreditCard className="h-3.5 w-3.5 mr-1" />
                                                납부하기
                                              </Button>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              ))}
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
