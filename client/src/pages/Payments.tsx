import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, User, BookOpen, CheckCircle, XCircle, CreditCard, Calendar } from "lucide-react";
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

export default function Payments({ userRole }: PaymentsProps) {
  const [expandedTeachers, setExpandedTeachers] = useState<Set<string>>(new Set());
  const [expandedClasses, setExpandedClasses] = useState<Set<string>>(new Set());
  const [paymentDialog, setPaymentDialog] = useState<{
    isOpen: boolean;
    student?: StudentWithPaymentStatus;
    enrollment?: Enrollment;
  }>({ isOpen: false });
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  
  const { toast } = useToast();

  // Fetch all required data
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

  // Payment mutation
  const addPaymentMutation = useMutation({
    mutationFn: async (data: { enrollmentId: string; amount: number; paidDate: string }) => {
      const currentDate = new Date();
      const paymentMonth = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
      
      const payload = {
        enrollmentId: data.enrollmentId,
        amount: data.amount,
        paymentMonth: paymentMonth,
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

  // Process data to create teacher-class-student hierarchy
  const processTeacherData = (): TeacherWithClasses[] => {
    const teachersWithClasses: TeacherWithClasses[] = [];
    const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    
    // Group classes by teacher
    teachers.forEach(teacher => {
      const teacherClasses = classes.filter(c => c.teacherId === teacher.id);
      const classesWithStudents: ClassWithStudents[] = [];
      
      teacherClasses.forEach(classItem => {
        const classEnrollments = enrollments.filter(e => e.classId === classItem.id && e.isActive);
        
        const studentsWithStatus: StudentWithPaymentStatus[] = classEnrollments.map(enrollment => {
          const student = students.find(s => s.id === enrollment.studentId);
          const latestPayment = payments.find(p => 
            p.enrollmentId === enrollment.id && 
            p.paymentMonth === currentMonth
          );
          
          return {
            id: student?.id || '',
            name: student?.name || '알 수 없음',
            grade: student?.grade,
            enrollment,
            latestPayment,
            isPaid: !!latestPayment,
            tuition: enrollment.tuition || classItem.defaultTuition || 0,
          };
        }).filter(s => s.id); // Filter out students without valid IDs
        
        if (studentsWithStatus.length > 0) {
          classesWithStudents.push({
            id: classItem.id,
            name: classItem.name,
            students: studentsWithStatus,
            schedule: classItem.schedule,
          });
        }
      });
      
      if (classesWithStudents.length > 0) {
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

  const handlePaymentClick = (student: StudentWithPaymentStatus) => {
    setPaymentAmount(student.tuition.toString());
    setPaymentDialog({
      isOpen: true,
      student,
      enrollment: student.enrollment,
    });
  };

  const handlePaymentSubmit = () => {
    if (!paymentDialog.enrollment || !paymentAmount) return;
    
    addPaymentMutation.mutate({
      enrollmentId: paymentDialog.enrollment.id,
      amount: parseInt(paymentAmount),
      paidDate: paymentDate,
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

  // 총수납액과 총미납액 계산
  const calculateFinancials = () => {
    const currentMonthString = new Date().toISOString().slice(0, 7); // YYYY-MM
    
    // 총수납액: 현재 달의 모든 payment 금액 합산
    const totalRevenue = payments
      .filter(p => p.paymentMonth === currentMonthString)
      .reduce((sum, p) => sum + (p.amount || 0), 0);
    
    // 총미납액: 미납 학생들의 수강료 합산
    const totalOutstanding = teacherData.reduce((total, teacher) => {
      return total + teacher.classes.reduce((classTotal, classItem) => {
        return classTotal + classItem.students
          .filter(student => !student.isPaid)
          .reduce((studentTotal, student) => studentTotal + (student.tuition || 0), 0);
      }, 0);
    }, 0);

    return { totalRevenue, totalOutstanding };
  };

  const { totalRevenue, totalOutstanding } = calculateFinancials();

  return (
    <div className="space-y-6 p-6" data-testid="payments-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">수납 관리</h1>
          <p className="text-muted-foreground">
            {currentMonth} 수납 현황
          </p>
        </div>
      </div>

      {/* Teacher-Class-Student hierarchy layout */}
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
                {/* Teacher Header */}
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

                {/* Teacher's Classes */}
                {isTeacherExpanded && (
                  <CardContent className="pt-0 space-y-3">
                    {teacher.classes.map((classItem: ClassWithStudents) => {
                      const isExpanded = expandedClasses.has(classItem.id);
                      const paidCount = classItem.students.filter((s: StudentWithPaymentStatus) => s.isPaid).length;
                      const totalCount = classItem.students.length;
                      
                      return (
                        <div key={classItem.id} className="border rounded-md overflow-hidden">
                          {/* Class Header */}
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

                          {/* Students */}
                          {isExpanded && (
                            <div className="p-2 space-y-2">
                              {classItem.students.map((student: StudentWithPaymentStatus) => (
                                <div 
                                  key={student.id}
                                  className="flex items-center justify-between p-3 bg-background rounded-lg hover-elevate"
                                  data-testid={`student-row-${student.id}`}
                                >
                                  <div className="flex items-center gap-3">
                                    <div className="flex items-center gap-2">
                                      {student.isPaid ? (
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
                                      <div className="font-medium">{formatAmount(student.tuition)}</div>
                                      {student.isPaid && student.latestPayment ? (
                                        <div className="text-xs text-green-600">
                                          {new Date(student.latestPayment.paidDate).toLocaleDateString()} 납부
                                        </div>
                                      ) : (
                                        <div className="text-xs text-red-600">미납</div>
                                      )}
                                    </div>
                                    
                                    {!student.isPaid && (userRole === 'owner' || userRole === 'teacher') ? (
                                      <Button 
                                        size="sm"
                                        onClick={() => handlePaymentClick(student)}
                                        data-testid={`payment-button-${student.id}`}
                                        variant="default"
                                      >
                                        <CreditCard className="h-4 w-4 mr-1" />
                                        납부하기
                                      </Button>
                                    ) : student.isPaid ? (
                                      <Badge variant="default" className="bg-green-100 text-green-800">
                                        납부완료
                                      </Badge>
                                    ) : (
                                      <Badge variant="secondary">
                                        미납
                                      </Badge>
                                    )}
                                  </div>
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

      {/* Payment Dialog */}
      <Dialog open={paymentDialog.isOpen} onOpenChange={(open) => setPaymentDialog({ isOpen: open })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>수납 등록</DialogTitle>
            <DialogDescription>
              {paymentDialog.student?.name} 학생의 {currentMonth} 수납을 등록합니다.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
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

      {/* Summary */}
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
              <p className="text-sm text-muted-foreground">납부 완료</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">
                {teacherData.reduce((sum: number, t: TeacherWithClasses) => sum + (t.totalStudents - t.paidStudents), 0)}명
              </div>
              <p className="text-sm text-muted-foreground">미납</p>
            </div>
            {/* 총수납액 - 원장만 */}
            {(userRole === 'owner' || userRole === 'superadmin') && (
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">
                  ₩{totalRevenue.toLocaleString()}
                </div>
                <p className="text-sm text-muted-foreground">총수납액</p>
              </div>
            )}
            {/* 총미납액 - 원장과 교사 */}
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