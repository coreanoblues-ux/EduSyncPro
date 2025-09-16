import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Phone, Mail, Calendar, DollarSign, User, BookOpen, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Payment, Enrollment, Student, Class } from "@shared/schema";

interface OverdueInfo {
  enrollment: Enrollment;
  student: Student;
  class: Class;
  overdueMonths: string[];
  totalOverdueAmount: number;
  latestOverdueMonth: string;
}

interface OverduesProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
}

export default function Overdues({ userRole }: OverduesProps) {
  const [selectedClassFilter, setSelectedClassFilter] = useState<string>('all');
  const [overdueSeverity, setOverdueSeverity] = useState<string>('all'); // all, recent, severe

  // Fetch all required data
  const { data: payments = [], isLoading: paymentsLoading, isError: paymentsError } = useQuery<Payment[]>({
    queryKey: ['/api/payments'],
  });

  const { data: enrollments = [], isLoading: enrollmentsLoading, isError: enrollmentsError } = useQuery<Enrollment[]>({
    queryKey: ['/api/enrollments'],
  });

  const { data: students = [], isLoading: studentsLoading, isError: studentsError } = useQuery<Student[]>({
    queryKey: ['/api/students'],
  });

  const { data: classes = [], isLoading: classesLoading, isError: classesError } = useQuery<Class[]>({
    queryKey: ['/api/classes'],
  });

  // Calculate overdue information
  const overdueList = useMemo((): OverdueInfo[] => {
    if (!enrollments.length || !students.length || !classes.length) {
      return [];
    }

    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1; // getMonth() returns 0-11
    
    const overdues: OverdueInfo[] = [];

    // Check each active enrollment
    enrollments
      .filter(enrollment => enrollment.isActive)
      .forEach(enrollment => {
        const student = students.find(s => s.id === enrollment.studentId);
        const classItem = classes.find(c => c.id === enrollment.classId);
        
        if (!student || !classItem) return;

        const startDate = new Date(enrollment.startDate);
        const endDate = enrollment.endDate ? new Date(enrollment.endDate) : currentDate;
        const dueDay = enrollment.dueDay || 8;
        
        const overdueMonths: string[] = [];
        let totalOverdueAmount = 0;
        const tuitionAmount = enrollment.tuition || classItem.defaultTuition || 0;

        // Check each month from start date to current/end date
        let checkDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
        
        while (checkDate <= endDate && checkDate <= currentDate) {
          const checkYear = checkDate.getFullYear();
          const checkMonth = checkDate.getMonth() + 1;
          const paymentMonth = `${checkYear}-${checkMonth.toString().padStart(2, '0')}`;
          
          // Check if due date has passed
          const dueDate = new Date(checkYear, checkMonth - 1, dueDay);
          if (currentDate > dueDate) {
            // Look for payment for this month
            const hasPayment = payments.some(payment => 
              payment.enrollmentId === enrollment.id && 
              payment.paymentMonth === paymentMonth
            );
            
            if (!hasPayment) {
              overdueMonths.push(paymentMonth);
              totalOverdueAmount += tuitionAmount;
            }
          }
          
          // Move to next month
          checkDate.setMonth(checkDate.getMonth() + 1);
        }

        if (overdueMonths.length > 0) {
          overdues.push({
            enrollment,
            student,
            class: classItem,
            overdueMonths,
            totalOverdueAmount,
            latestOverdueMonth: overdueMonths[overdueMonths.length - 1],
          });
        }
      });

    return overdues;
  }, [enrollments, payments, students, classes]);

  // Filter overdue list
  const filteredOverdues = useMemo(() => {
    let filtered = overdueList;
    
    // Filter by class
    if (selectedClassFilter !== 'all') {
      filtered = filtered.filter(overdue => overdue.class.id === selectedClassFilter);
    }
    
    // Filter by severity
    if (overdueSeverity === 'recent') {
      // Only 1 month overdue
      filtered = filtered.filter(overdue => overdue.overdueMonths.length === 1);
    } else if (overdueSeverity === 'severe') {
      // 2 or more months overdue
      filtered = filtered.filter(overdue => overdue.overdueMonths.length >= 2);
    }
    
    // Sort by total overdue amount (descending)
    return [...filtered].sort((a, b) => b.totalOverdueAmount - a.totalOverdueAmount);
  }, [overdueList, selectedClassFilter, overdueSeverity]);

  const formatAmount = (amount: number) => {
    return `₩${amount.toLocaleString()}`;
  };

  const formatOverdueMonths = (months: string[]) => {
    return months.map(month => {
      const [year, monthStr] = month.split('-');
      return `${year}.${monthStr}`;
    }).join(', ');
  };

  const getSeverityBadge = (monthsCount: number) => {
    if (monthsCount === 1) {
      return <Badge variant="secondary">1개월</Badge>;
    } else if (monthsCount >= 2 && monthsCount < 4) {
      return <Badge variant="destructive">위험 {monthsCount}개월</Badge>;
    } else {
      return <Badge variant="destructive">심각 {monthsCount}개월</Badge>;
    }
  };

  // Handle errors
  const hasErrors = paymentsError || enrollmentsError || studentsError || classesError;
  const isLoading = paymentsLoading || enrollmentsLoading || studentsLoading || classesLoading;

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">미납 알림</h1>
        </div>
        <div className="text-center py-8">
          <div className="text-muted-foreground">미납 정보를 분석하는 중...</div>
        </div>
      </div>
    );
  }

  if (hasErrors) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">미납 알림</h1>
        </div>
        <Alert className="border-red-200 bg-red-50 dark:bg-red-900/20">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>데이터 로딩 오류</AlertTitle>
          <AlertDescription>
            미납 정보를 불러오는 중 오류가 발생했습니다. 페이지를 새로고침해 주세요.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6" data-testid="overdues-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">미납 알림</h1>
          <p className="text-muted-foreground">
            {filteredOverdues.length}명의 미납자가 있습니다
          </p>
        </div>
      </div>

      {/* Alert Summary */}
      {overdueList.length > 0 && (
        <Alert className="border-orange-200 bg-orange-50 dark:bg-orange-900/20">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>미납 현황 알림</AlertTitle>
          <AlertDescription>
            총 {overdueList.length}명의 학생에게 미납이 있으며, 
            총 미납액은 {formatAmount(overdueList.reduce((sum, item) => sum + item.totalOverdueAmount, 0))}입니다.
          </AlertDescription>
        </Alert>
      )}

      {/* Filter Controls */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Label htmlFor="class-filter">반별 필터:</Label>
          <Select value={selectedClassFilter} onValueChange={setSelectedClassFilter}>
            <SelectTrigger className="w-48" data-testid="select-class-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체 반</SelectItem>
              {classes.filter(c => c.isActive !== false).map((classItem) => (
                <SelectItem key={classItem.id} value={classItem.id}>
                  {classItem.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        
        <div className="flex items-center gap-2">
          <Label htmlFor="severity-filter">심각도:</Label>
          <Select value={overdueSeverity} onValueChange={setOverdueSeverity}>
            <SelectTrigger className="w-40" data-testid="select-severity-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체</SelectItem>
              <SelectItem value="recent">최근 (1개월)</SelectItem>
              <SelectItem value="severe">심각 (2개월+)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        
        <Badge variant="outline" data-testid="filtered-count">
          <Filter className="h-3 w-3 mr-1" />
          {filteredOverdues.length}명
        </Badge>
      </div>

      {/* Overdue List */}
      {filteredOverdues.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          {overdueList.length === 0 ? (
            <>
              <DollarSign className="h-12 w-12 mx-auto text-green-500 mb-4" />
              <div className="text-lg font-medium text-green-600">미납자가 없습니다</div>
              <p className="text-muted-foreground mt-2">모든 학생이 정상적으로 납부했습니다.</p>
            </>
          ) : (
            <>
              <Filter className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <div className="text-lg font-medium">필터 조건에 해당하는 미납자가 없습니다</div>
              <p className="text-muted-foreground mt-2">다른 필터 조건을 시도해보세요.</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredOverdues.map((overdue) => (
            <Card key={overdue.enrollment.id} className="hover-elevate" data-testid={`overdue-card-${overdue.enrollment.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg" data-testid={`overdue-student-${overdue.enrollment.id}`}>
                      {overdue.student.name}
                    </CardTitle>
                    {getSeverityBadge(overdue.overdueMonths.length)}
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <BookOpen className="h-4 w-4" />
                      <span data-testid={`overdue-class-${overdue.enrollment.id}`}>
                        {overdue.class.name}
                      </span>
                    </div>
                    {overdue.student.parentPhone && (
                      <div className="flex items-center gap-1">
                        <Phone className="h-4 w-4" />
                        <span data-testid={`overdue-phone-${overdue.enrollment.id}`}>
                          {overdue.student.parentPhone}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xl font-bold text-red-600" data-testid={`overdue-amount-${overdue.enrollment.id}`}>
                    {formatAmount(overdue.totalOverdueAmount)}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {overdue.overdueMonths.length}개월 미납
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Calendar className="h-4 w-4" />
                    미납 월
                  </div>
                  <div className="pl-6 text-sm" data-testid={`overdue-months-${overdue.enrollment.id}`}>
                    {formatOverdueMonths(overdue.overdueMonths)}
                  </div>
                </div>
                
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <DollarSign className="h-4 w-4" />
                    월 수강료
                  </div>
                  <div className="pl-6 text-sm">
                    {formatAmount(overdue.enrollment.tuition || overdue.class.defaultTuition || 0)}
                  </div>
                </div>

                {overdue.student.school && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      <User className="h-4 w-4" />
                      학생 정보
                    </div>
                    <div className="pl-6 text-sm">
                      {overdue.student.school} {overdue.student.grade && `${overdue.student.grade}`}
                    </div>
                  </div>
                )}

                {(userRole === 'owner' || userRole === 'teacher') && (
                  <div className="flex gap-2 pt-3 border-t">
                    <Button 
                      size="sm" 
                      variant="outline"
                      data-testid={`button-call-${overdue.enrollment.id}`}
                      disabled={!overdue.student.parentPhone}
                    >
                      <Phone className="h-4 w-4 mr-2" />
                      전화하기
                    </Button>
                    <Button 
                      size="sm" 
                      variant="outline"
                      data-testid={`button-sms-${overdue.enrollment.id}`}
                      disabled={!overdue.student.parentPhone}
                    >
                      <Mail className="h-4 w-4 mr-2" />
                      알림 발송
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Summary Stats */}
      {overdueList.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              미납 요약 통계
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">
                {overdueList.length}명
              </div>
              <p className="text-sm text-muted-foreground">전체 미납자</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-orange-600">
                {overdueList.filter(item => item.overdueMonths.length === 1).length}명
              </div>
              <p className="text-sm text-muted-foreground">최근 미납 (1개월)</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-700">
                {overdueList.filter(item => item.overdueMonths.length >= 2).length}명
              </div>
              <p className="text-sm text-muted-foreground">심각 미납 (2개월+)</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">
                {formatAmount(overdueList.reduce((sum, item) => sum + item.totalOverdueAmount, 0))}
              </div>
              <p className="text-sm text-muted-foreground">총 미납액</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}