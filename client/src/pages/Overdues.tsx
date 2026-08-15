import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Phone, Mail, Calendar, DollarSign, User, BookOpen, Filter, PauseCircle, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Payment, Enrollment, Student, Class } from "@shared/schema";
import { computeOverdues, type OverdueInfo } from "@/lib/overdues";

interface OverduesProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
}

/** 수납 처리 창에서 다루는 값. 창을 닫으면 통째로 버린다. */
interface PayForm {
  overdue: OverdueInfo;
  months: string[];
  monthlyAmount: number;
  method: "계좌이체" | "카드" | "현금";
}

export default function Overdues({ userRole }: OverduesProps) {
  const [selectedClassFilter, setSelectedClassFilter] = useState<string>('all');
  const [overdueSeverity, setOverdueSeverity] = useState<string>('all'); // all, recent, severe
  const [payForm, setPayForm] = useState<PayForm | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<OverdueInfo | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

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

  // 미납 판정 규칙은 대시보드와 공유한다 (client/src/lib/overdues.ts)
  const overdueList = useMemo(
    () => computeOverdues(enrollments, payments, students, classes),
    [enrollments, payments, students, classes]
  );

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

  // 미납 월마다 수납 한 건씩 만든다. 미납 판정이 월별 순합계로 돌아가므로
  // 3개월치를 한 줄로 몰아 넣으면 나머지 두 달은 계속 미납으로 남는다.
  const payMutation = useMutation({
    mutationFn: async (form: PayForm) => {
      for (const month of form.months) {
        await apiRequest('POST', '/api/payments', {
          enrollmentId: form.overdue.enrollment.id,
          amount: form.monthlyAmount,
          type: '원비',
          method: form.method,
          paymentMonth: month,
          paidDate: new Date().toISOString(),
          notes: '미납 알림에서 수납 처리',
        });
      }
    },
    onSuccess: (_data, form) => {
      queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
      toast({
        title: "수납 처리 완료",
        description: `${form.overdue.student.name} · ${form.months.length}개월 ${formatAmount(form.monthlyAmount * form.months.length)}`,
      });
      setPayForm(null);
    },
    onError: (error: Error) => {
      toast({
        title: "수납 처리 실패",
        description: error.message.replace(/^\d+:\s*/, "") || "수납 처리 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  const suspendMutation = useMutation({
    mutationFn: async (studentId: string) =>
      apiRequest('PATCH', `/api/students/${studentId}/deactivate`),
    onSuccess: (_data, _studentId) => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/enrollments'] });
      toast({
        title: "휴원 처리 완료",
        description: `${suspendTarget?.student.name} 학생을 휴원 처리했습니다. 미납이 더 쌓이지 않습니다.`,
      });
      setSuspendTarget(null);
    },
    onError: (error: Error) => {
      toast({
        title: "휴원 처리 실패",
        description: error.message.replace(/^\d+:\s*/, "") || "휴원 처리 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

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
                  <div className="flex flex-wrap gap-2 pt-3 border-t">
                    {/* 전화를 걸고 돈을 받으면 그 자리에서 처리해야 한다.
                        수납 화면까지 옮겨 가면 누가 밀렸는지 다시 찾아야 한다. */}
                    <Button
                      size="sm"
                      onClick={() =>
                        setPayForm({
                          overdue,
                          // 오래된 달부터 채우는 것이 관행이다. 기본은 가장 오래된 한 달.
                          months: [overdue.overdueMonths[0]],
                          monthlyAmount:
                            overdue.enrollment.tuition || overdue.class.defaultTuition || 0,
                          method: "계좌이체",
                        })
                      }
                      data-testid={`button-pay-${overdue.enrollment.id}`}
                    >
                      <Wallet className="h-4 w-4 mr-2" />
                      수납 처리
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setSuspendTarget(overdue)}
                      data-testid={`button-suspend-${overdue.enrollment.id}`}
                    >
                      <PauseCircle className="h-4 w-4 mr-2" />
                      휴원 처리
                    </Button>
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

      {/* 수납 처리 */}
      <Dialog open={!!payForm} onOpenChange={(open) => !open && setPayForm(null)}>
        <DialogContent data-testid="dialog-pay">
          <DialogHeader>
            <DialogTitle>수납 처리</DialogTitle>
            <DialogDescription>
              {payForm && `${payForm.overdue.student.name} · ${payForm.overdue.class.name}`}
            </DialogDescription>
          </DialogHeader>

          {payForm && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>받은 달 (여러 개 고를 수 있습니다)</Label>
                <div className="flex flex-wrap gap-2">
                  {payForm.overdue.overdueMonths.map((month) => {
                    const on = payForm.months.includes(month);
                    return (
                      <Button
                        key={month}
                        type="button"
                        size="sm"
                        variant={on ? "default" : "outline"}
                        onClick={() =>
                          setPayForm({
                            ...payForm,
                            months: on
                              ? payForm.months.filter((m) => m !== month)
                              : [...payForm.months, month].sort(),
                          })
                        }
                        data-testid={`button-pay-month-${month}`}
                      >
                        {month.replace("-", ".")}
                      </Button>
                    );
                  })}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="pay-amount">월 납부액</Label>
                  <Input
                    id="pay-amount"
                    type="number"
                    min={0}
                    value={payForm.monthlyAmount}
                    onChange={(e) =>
                      setPayForm({ ...payForm, monthlyAmount: Number(e.target.value) })
                    }
                    data-testid="input-pay-amount"
                  />
                </div>
                <div className="space-y-2">
                  <Label>결제 방법</Label>
                  <Select
                    value={payForm.method}
                    onValueChange={(v) => setPayForm({ ...payForm, method: v as PayForm["method"] })}
                  >
                    <SelectTrigger data-testid="select-pay-method">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="계좌이체">계좌이체</SelectItem>
                      <SelectItem value="카드">카드</SelectItem>
                      <SelectItem value="현금">현금</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="rounded-md bg-muted p-3 text-sm">
                합계{" "}
                <span className="font-semibold" data-testid="text-pay-total">
                  {formatAmount(payForm.monthlyAmount * payForm.months.length)}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  ({payForm.months.length}개월 × {formatAmount(payForm.monthlyAmount)})
                </span>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPayForm(null)}>
              취소
            </Button>
            <Button
              onClick={() => payForm && payMutation.mutate(payForm)}
              disabled={
                !payForm ||
                payForm.months.length === 0 ||
                payForm.monthlyAmount <= 0 ||
                payMutation.isPending
              }
              data-testid="button-pay-submit"
            >
              {payMutation.isPending ? "처리 중..." : "수납 저장"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 휴원 처리 */}
      <Dialog open={!!suspendTarget} onOpenChange={(open) => !open && setSuspendTarget(null)}>
        <DialogContent data-testid="dialog-suspend">
          <DialogHeader>
            <DialogTitle>휴원 처리</DialogTitle>
            <DialogDescription>
              {suspendTarget?.student.name} 학생을 휴원 처리합니다.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 text-sm">
            {/* 휴원은 학생 단위라 다른 반까지 함께 멈춘다. 누르기 전에 알려야 한다. */}
            <p>휴원하면 이 학생이 듣는 모든 반의 미납이 더 이상 쌓이지 않고, 미납 목록에서 빠집니다.</p>
            <p className="text-muted-foreground">
              지금까지 밀린 {formatAmount(suspendTarget?.totalOverdueAmount ?? 0)}은 기록에 그대로
              남습니다. 학생 화면에서 재등록하면 다시 나타납니다.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setSuspendTarget(null)}>
              취소
            </Button>
            <Button
              variant="destructive"
              onClick={() => suspendTarget && suspendMutation.mutate(suspendTarget.student.id)}
              disabled={suspendMutation.isPending}
              data-testid="button-suspend-submit"
            >
              {suspendMutation.isPending ? "처리 중..." : "휴원 처리"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}