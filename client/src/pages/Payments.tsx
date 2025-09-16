import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Receipt, Calendar, DollarSign, User, BookOpen, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Payment, Enrollment, Student, Class } from "@shared/schema";

const paymentFormSchema = z.object({
  enrollmentId: z.string().min(1, "수강 등록을 선택해주세요"),
  amount: z.number().min(1, "수납 금액을 입력해주세요"),
  paymentMonth: z.string().min(1, "수납 월을 입력해주세요").regex(/^\d{4}-\d{2}$/, "YYYY-MM 형식으로 입력해주세요"),
  paidDate: z.string().min(1, "납입 일자를 입력해주세요"),
  notes: z.string().optional(),
});

type PaymentFormData = z.infer<typeof paymentFormSchema>;

interface PaymentsProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
}

export default function Payments({ userRole }: PaymentsProps) {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const { toast } = useToast();

  // Fetch payments
  const { data: payments = [], isLoading: paymentsLoading } = useQuery<Payment[]>({
    queryKey: ['/api/payments'],
  });

  // Fetch enrollments for dropdown
  const { data: enrollments = [], isLoading: enrollmentsLoading } = useQuery<Enrollment[]>({
    queryKey: ['/api/enrollments'],
  });

  // Fetch students to map enrollment info
  const { data: students = [] } = useQuery<Student[]>({
    queryKey: ['/api/students'],
  });

  // Fetch classes to map enrollment info
  const { data: classes = [] } = useQuery<Class[]>({
    queryKey: ['/api/classes'],
  });

  // Add payment mutation
  const addPaymentMutation = useMutation({
    mutationFn: async (data: PaymentFormData) => {
      const payload = {
        ...data,
        paidDate: new Date(data.paidDate).toISOString(),
      };
      const response = await apiRequest('POST', '/api/payments', payload);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
      setIsAddDialogOpen(false);
      addForm.reset();
      toast({
        title: "수납 등록 완료",
        description: "새 수납이 성공적으로 등록되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "수납 등록 실패",
        description: error.message || "수납 등록 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // Form for adding payment
  const addForm = useForm<PaymentFormData>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: {
      enrollmentId: "",
      amount: 0,
      paymentMonth: new Date().toISOString().slice(0, 7), // YYYY-MM
      paidDate: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
      notes: "",
    },
  });

  const handleAddPayment = (data: PaymentFormData) => {
    addPaymentMutation.mutate(data);
  };

  const getStudentName = (enrollmentId: string) => {
    const enrollment = enrollments.find(e => e.id === enrollmentId);
    if (!enrollment) return "학생 정보 없음";
    const student = students.find(s => s.id === enrollment.studentId);
    return student?.name || "학생 정보 없음";
  };

  const getClassName = (enrollmentId: string) => {
    const enrollment = enrollments.find(e => e.id === enrollmentId);
    if (!enrollment) return "반 정보 없음";
    const classItem = classes.find(c => c.id === enrollment.classId);
    return classItem?.name || "반 정보 없음";
  };

  const getEnrollmentInfo = (enrollmentId: string) => {
    const enrollment = enrollments.find(e => e.id === enrollmentId);
    if (!enrollment) return { studentName: "정보 없음", className: "정보 없음", tuition: 0 };
    
    const student = students.find(s => s.id === enrollment.studentId);
    const classItem = classes.find(c => c.id === enrollment.classId);
    
    return {
      studentName: student?.name || "정보 없음",
      className: classItem?.name || "정보 없음",
      tuition: enrollment.tuition || classItem?.defaultTuition || 0,
    };
  };

  const formatAmount = (amount: number) => {
    return `₩${amount.toLocaleString()}`;
  };

  if (paymentsLoading || enrollmentsLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">수납 관리</h1>
        </div>
        <div className="text-center py-8">
          <div className="text-muted-foreground">수납 목록을 불러오는 중...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6" data-testid="payments-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">수납 관리</h1>
          <p className="text-muted-foreground">
            수납 내역 {payments.length}건이 등록되어 있습니다
          </p>
        </div>
        
        {(userRole === 'owner' || userRole === 'teacher') && (
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-payment">
                <Plus className="h-4 w-4 mr-2" />
                수납 등록
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>새 수납 등록</DialogTitle>
                <DialogDescription>
                  새로운 수납 정보를 입력해주세요.
                </DialogDescription>
              </DialogHeader>
              <Form {...addForm}>
                <form onSubmit={addForm.handleSubmit(handleAddPayment)} className="space-y-4">
                  <FormField
                    control={addForm.control}
                    name="enrollmentId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>수강 등록</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-enrollment">
                              <SelectValue placeholder="수강 등록을 선택하세요" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {enrollments.filter(e => e.isActive).map((enrollment) => {
                              const info = getEnrollmentInfo(enrollment.id);
                              return (
                                <SelectItem key={enrollment.id} value={enrollment.id}>
                                  {info.studentName} - {info.className} (₩{info.tuition.toLocaleString()})
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="amount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>수납 금액</FormLabel>
                        <FormControl>
                          <Input 
                            type="number" 
                            placeholder="150000" 
                            data-testid="input-payment-amount"
                            {...field}
                            onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="paymentMonth"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>수납 월</FormLabel>
                        <FormControl>
                          <Input 
                            type="month" 
                            data-testid="input-payment-month"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="paidDate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>납입 일자</FormLabel>
                        <FormControl>
                          <Input 
                            type="date" 
                            data-testid="input-payment-date"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>비고</FormLabel>
                        <FormControl>
                          <Textarea placeholder="비고사항을 입력하세요" data-testid="input-payment-notes" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <DialogFooter>
                    <Button 
                      type="submit" 
                      disabled={addPaymentMutation.isPending}
                      data-testid="button-submit-add-payment"
                    >
                      {addPaymentMutation.isPending ? "등록 중..." : "등록"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        )}
        
        {userRole === 'superadmin' && (
          <div className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-lg flex items-center gap-2">
            <Info className="h-4 w-4" />
            <span>수납 등록은 학원장과 교사만 가능합니다</span>
          </div>
        )}
      </div>

      {/* Payments Grid */}
      {payments.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          <Receipt className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <div className="text-lg font-medium">등록된 수납 내역이 없습니다</div>
          <p className="text-muted-foreground mt-2">첫 번째 수납을 등록해보세요.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {payments.map((payment) => (
            <Card key={payment.id} className="hover-elevate" data-testid={`payment-card-${payment.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-lg" data-testid={`payment-amount-${payment.id}`}>
                    {formatAmount(payment.amount)}
                  </CardTitle>
                  <Badge variant="default" data-testid={`payment-month-${payment.id}`}>
                    {payment.paymentMonth}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <User className="h-4 w-4" />
                  <span data-testid={`payment-student-${payment.id}`}>
                    {getStudentName(payment.enrollmentId)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <BookOpen className="h-4 w-4" />
                  <span data-testid={`payment-class-${payment.id}`}>
                    {getClassName(payment.enrollmentId)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  <span data-testid={`payment-paid-date-${payment.id}`}>
                    납입일: {new Date(payment.paidDate).toLocaleDateString()}
                  </span>
                </div>
                {payment.notes && (
                  <div className="text-xs text-muted-foreground">
                    <span data-testid={`payment-notes-${payment.id}`}>비고: {payment.notes}</span>
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  등록일: {new Date(payment.createdAt).toLocaleDateString()}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Summary Stats */}
      {payments.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              수납 요약
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                {payments.length}건
              </div>
              <p className="text-sm text-muted-foreground">총 수납 건수</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {formatAmount(payments.reduce((sum, p) => sum + p.amount, 0))}
              </div>
              <p className="text-sm text-muted-foreground">총 수납 금액</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">
                {payments.length > 0 ? formatAmount(Math.round(payments.reduce((sum, p) => sum + p.amount, 0) / payments.length)) : formatAmount(0)}
              </div>
              <p className="text-sm text-muted-foreground">평균 수납 금액</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}