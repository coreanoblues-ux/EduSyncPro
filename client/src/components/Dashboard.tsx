import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Plus, Search, Settings } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useLocation } from "wouter";
import DashboardCard from "./DashboardCard";
import StudentCard from "./StudentCard";
import OverdueAlert from "./OverdueAlert";
import ClassLogForm from "./ClassLogForm";
import { CreditCard, Users, AlertTriangle, BookOpen } from "lucide-react";

interface DashboardProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
  tenant?: {
    id: string;
    name: string;
    status: 'pending' | 'active' | 'expired' | 'suspended';
  } | null;
}

// 학생 및 수강 정보 편집을 위한 스키마
const studentEditSchema = z.object({
  name: z.string().min(1, "학생 이름을 입력해주세요"),
  school: z.string().optional(),
  grade: z.string().optional(),
  parentPhone: z.string().optional(),
  notes: z.string().optional(),
  // 수강 정보
  classId: z.string().optional(),
  startDate: z.string().optional(),
  customTuition: z.number().optional(),
  dueDay: z.number().min(1).max(31).optional(),
});

type StudentEditData = z.infer<typeof studentEditSchema>;

export default function Dashboard({ userRole, tenant }: DashboardProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [showLogForm, setShowLogForm] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState<any>(null);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // 승인되지 않은 테넌트는 데이터를 불러오지 않음
  const isApproved = !tenant || tenant.status === 'active' || userRole === 'superadmin';
  
  // Fetch students data (for dashboard - 미납자 우선, 최신순, 최대 6명)
  const { data: students = [], isLoading: studentsLoading } = useQuery({
    queryKey: ['/api/dashboard/students'],
    enabled: isApproved,
  });

  // Fetch teachers data
  const { data: teachers = [] } = useQuery({
    queryKey: ['/api/teachers'],
    enabled: isApproved,
  });

  // Fetch classes data
  const { data: classes = [] } = useQuery({
    queryKey: ['/api/classes'],
    enabled: isApproved,
  });

  // Fetch enrollments data
  const { data: enrollments = [] } = useQuery({
    queryKey: ['/api/enrollments'],
    enabled: isApproved,
  });

  // Fetch payments data for overdue calculation
  const { data: payments = [] } = useQuery({
    queryKey: ['/api/payments'],
    enabled: isApproved,
  });

  // 학생 편집 뮤테이션
  const editStudentMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string, data: StudentEditData }) => {
      // 1. 학생 기본 정보 업데이트
      const studentUpdateData = {
        name: data.name,
        school: data.school,
        grade: data.grade,
        parentPhone: data.parentPhone,
        notes: data.notes,
      };
      
      const studentResponse = await apiRequest('PUT', `/api/students/${id}`, studentUpdateData);
      const updatedStudent = await studentResponse.json();
      
      // 2. 수강 정보 업데이트 (반이 선택된 경우)
      if (data.classId) {
        const enrollmentsArray = Array.isArray(enrollments) ? enrollments : [];
        const existingEnrollment = enrollmentsArray.find((e: any) => e.studentId === id);
        
        const enrollmentData = {
          studentId: id,
          classId: data.classId,
          startDate: data.startDate,
          tuition: data.customTuition,
          dueDay: data.dueDay || 8,
        };
        
        if (existingEnrollment) {
          // 기존 수강 정보 업데이트
          await apiRequest('PUT', `/api/enrollments/${existingEnrollment.id}`, enrollmentData);
        } else {
          // 새 수강 등록 생성
          await apiRequest('POST', '/api/enrollments', enrollmentData);
        }
      } else {
        // 반이 선택되지 않은 경우 기존 수강 정보 삭제 (옵션)
        const enrollmentsArray = Array.isArray(enrollments) ? enrollments : [];
        const existingEnrollment = enrollmentsArray.find((e: any) => e.studentId === id);
        if (existingEnrollment) {
          await apiRequest('DELETE', `/api/enrollments/${existingEnrollment.id}`);
        }
      }
      
      return updatedStudent;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/enrollments'] });
      setIsEditDialogOpen(false);
      setEditingStudent(null);
      toast({
        title: "학생 수정 완료",
        description: "학생 정보가 성공적으로 수정되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "학생 수정 실패",
        description: error.message || "학생 수정 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // 납부 처리 뮤테이션
  const paymentMutation = useMutation({
    mutationFn: async ({ studentId, month }: { studentId: string, month: string }) => {
      const response = await apiRequest('POST', '/api/payments', {
        studentId,
        month,
        amount: 0, // 금액은 시스템에서 자동 계산
      });
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/dashboard/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/payments'] });
      toast({
        title: "납부 처리 완료",
        description: "납부가 성공적으로 처리되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "납부 처리 실패",
        description: error.message || "납부 처리 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // todo: remove mock functionality
  const getDashboardData = () => {
    const classesArray = Array.isArray(classes) ? classes : [];
    
    const commonData = [
      {
        title: "미납자",
        value: `${overdueCount}명`,
        description: "기준일 경과",
        icon: AlertTriangle,
        trend: overdueCount === 0 ? { value: "없음", isPositive: true } : undefined
      },
      {
        title: "운영 반",
        value: `${classesArray.length}개`,
        description: "활성화된 반",
        icon: BookOpen
      }
    ];

    // 학원장과 슈퍼관리자만 전체 학생 수 볼 수 있음
    if (userRole === 'owner' || userRole === 'superadmin') {
      return [
        {
          title: "전체 학생 수",
          value: `${allStudentsArray.length}명`,
          description: "재원 학생",
          icon: Users,
          trend: allStudentsArray.length > 0 ? { value: "+3명", isPositive: true } : undefined
        },
        ...commonData
      ];
    }

    // 교사용 - 수납액과 전체 학생 수는 제한됨
    return [
      {
        title: "Total Students",
        value: "Access Restricted",
        description: "권한이 필요합니다",
        icon: Users,
        isRestricted: true
      },
      ...commonData
    ];
  };

  // Fetch all students data for total count (separate from dashboard students)
  const { data: allStudents = [] } = useQuery({
    queryKey: ['/api/students'],
    enabled: isApproved,
  });

  // Dashboard students already include all necessary data (미납자 우선, 최신순, 최대 6명)
  const studentData = Array.isArray(students) ? students : [];
  const allStudentsArray = Array.isArray(allStudents) ? allStudents : [];

  // Mock classes for now
  const mockClasses = Array.isArray(classes) ? classes : [];

  const filteredStudents = studentData.filter((student: any) =>
    student.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    student.className.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // 실제 미납자 수 계산
  const overdueCount = useMemo(() => {
    // 필요한 데이터가 모두 있는지 확인
    const enrollmentsArray = Array.isArray(enrollments) ? enrollments : [];
    const allStudentsArray = Array.isArray(allStudents) ? allStudents : [];
    const classesArray = Array.isArray(classes) ? classes : [];
    const paymentsArray = Array.isArray(payments) ? payments : [];

    if (!enrollmentsArray.length || !allStudentsArray.length || !classesArray.length) {
      return 0;
    }

    const currentDate = new Date();
    let overdueStudents = 0;

    // 각 활성 수강에 대해 미납 체크
    enrollmentsArray
      .filter((enrollment: any) => enrollment.isActive)
      .forEach((enrollment: any) => {
        const student = allStudentsArray.find((s: any) => s.id === enrollment.studentId);
        const classItem = classesArray.find((c: any) => c.id === enrollment.classId);
        
        if (!student || !classItem) return;

        const startDate = new Date(enrollment.startDate);
        const dueDay = enrollment.dueDay || 8;
        
        // 수강 시작일부터 현재까지 각 월을 체크
        let checkDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
        
        let hasOverdue = false;
        while (checkDate <= currentDate && !hasOverdue) {
          const checkYear = checkDate.getFullYear();
          const checkMonth = checkDate.getMonth() + 1;
          const paymentMonth = `${checkYear}-${checkMonth.toString().padStart(2, '0')}`;
          
          // 해당 월의 납입 기한 확인
          const dueDate = new Date(checkYear, checkMonth - 1, dueDay);
          if (currentDate > dueDate) {
            // 해당 월 납부 기록이 있는지 확인
            const hasPayment = paymentsArray.some((payment: any) => 
              payment.enrollmentId === enrollment.id && 
              payment.paymentMonth === paymentMonth
            );
            
            if (!hasPayment) {
              hasOverdue = true;
              overdueStudents++;
            }
          }
          
          // 다음 월로 이동
          checkDate.setMonth(checkDate.getMonth() + 1);
        }
      });

    return overdueStudents;
  }, [enrollments, allStudents, classes, payments]);

  // 편집 폼
  const editForm = useForm<StudentEditData>({
    resolver: zodResolver(studentEditSchema),
    defaultValues: {
      name: "",
      school: "",
      grade: "",
      parentPhone: "",
      notes: "",
      classId: "",
      startDate: "",
      customTuition: undefined,
      dueDay: 8,
    },
  });

  const handleStudentEdit = (id: string) => {
    const student = studentData.find((s: any) => s.id === id);
    if (!student) return;

    // 해당 학생의 수강 정보 찾기
    const enrollmentsArray = Array.isArray(enrollments) ? enrollments : [];
    const enrollment = enrollmentsArray.find((e: any) => e.studentId === id);
    
    setEditingStudent(student);
    editForm.reset({
      name: student.name,
      school: student.school || "",
      grade: student.grade || "",
      parentPhone: student.parentPhone || "",
      notes: student.notes || "",
      classId: enrollment?.classId || "",
      startDate: enrollment?.startDate || "",
      customTuition: enrollment?.tuition || undefined,
      dueDay: enrollment?.dueDay || student.dueDay || 8,
    });
    setIsEditDialogOpen(true);
  };

  const handlePayment = (id: string, month: 'current' | 'next') => {
    // 해당 학생이 속한 반 정보 찾기
    const student = studentData.find((s: any) => s.id === id);
    if (!student) return;
    
    // 학생의 반 정보와 함께 수납 섹션으로 이동
    const searchParams = new URLSearchParams();
    searchParams.set('studentId', id);
    searchParams.set('studentName', student.name);
    if (student.className && student.className !== '미배정') {
      searchParams.set('className', student.className);
    }
    
    setLocation(`/payments?${searchParams.toString()}`);
  };

  const handleEditSubmit = (data: StudentEditData) => {
    if (editingStudent) {
      editStudentMutation.mutate({ id: editingStudent.id, data });
    }
  };

  const handleViewOverdues = () => {
    setLocation('/overdues');
  };

  const handleLogSubmit = (log: any) => {
    console.log('Class log submitted:', log);
    setShowLogForm(false);
  };

  return (
    <div className="space-y-6 p-6" data-testid="dashboard">
      {/* 테넌트 상태 표시 */}
      {tenant && userRole !== 'superadmin' && (
        <div className="bg-muted/50 border rounded-lg p-4 mb-6">
          <div className="flex items-center gap-2">
            <span className="text-lg font-medium">{tenant.name}</span>
            {tenant.status === 'pending' ? (
              <span className="text-red-600 font-medium text-sm bg-red-50 px-2 py-1 rounded">
                미승인
              </span>
            ) : tenant.status === 'active' ? (
              <span className="text-green-600 font-medium text-sm bg-green-50 px-2 py-1 rounded">
                승인됨
              </span>
            ) : (
              <span className="text-gray-600 font-medium text-sm bg-gray-50 px-2 py-1 rounded">
                {tenant.status}
              </span>
            )}
          </div>
          {tenant.status === 'pending' && (
            <p className="text-sm text-muted-foreground mt-2">
              학원 승인 대기 중입니다. 승인 후 모든 기능을 사용할 수 있습니다.
            </p>
          )}
        </div>
      )}

      {/* Overdue Alert */}
      <OverdueAlert overdueCount={overdueCount} onViewOverdues={handleViewOverdues} />

      {/* Dashboard Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {getDashboardData().map((card, index) => (
          <DashboardCard key={index} {...card} />
        ))}
      </div>

      {/* Action Buttons */}
      <div className="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
        <div className="flex gap-2">
          <Button 
            disabled={!isApproved}
            onClick={() => setLocation('/students')}
            data-testid="button-add-student"
          >
            <Plus className="h-4 w-4 mr-2" />
            학생 추가
          </Button>
          <Button 
            variant="outline"
            disabled={!isApproved}
            onClick={() => setShowLogForm(!showLogForm)}
            data-testid="button-add-log"
          >
            <Plus className="h-4 w-4 mr-2" />
            반 일지 작성
          </Button>
          {userRole === 'superadmin' && (
            <Button 
              variant="secondary"
              onClick={() => setLocation('/superadmin')}
              data-testid="button-pending-academies"
            >
              <Settings className="h-4 w-4 mr-2" />
              Pending 학원확인
            </Button>
          )}
        </div>

        {/* Search */}
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="학생명 또는 반명으로 검색..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            disabled={!isApproved}
            data-testid="input-search"
          />
        </div>
      </div>

      {/* Class Log Form */}
      {showLogForm && (
        <div className="border-t pt-6">
          <ClassLogForm classes={mockClasses} onSubmit={handleLogSubmit} />
        </div>
      )}

      {/* Students Grid */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">학생 관리</h2>
        {!isApproved ? (
          <div className="text-center py-8 border-2 border-dashed border-muted-foreground/25 rounded-lg">
            <div className="text-muted-foreground">
              <p className="text-lg font-medium">학원 승인 대기 중</p>
              <p className="text-sm mt-1">승인 후 학생 관리 기능을 사용할 수 있습니다.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredStudents.map((student) => (
                <StudentCard
                  key={student.id}
                  student={student}
                  onEdit={handleStudentEdit}
                  onPayment={handlePayment}
                />
              ))}
            </div>
            
            {filteredStudents.length === 0 && isApproved && (
              <div className="text-center py-8 text-muted-foreground">
                검색 결과가 없습니다.
              </div>
            )}
          </>
        )}
      </div>

      {/* 학생 편집 다이얼로그 */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-lg h-[600px] flex flex-col">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>학생 정보 수정</DialogTitle>
            <DialogDescription>
              학생의 기본 정보와 수강 정보를 수정할 수 있습니다.
            </DialogDescription>
          </DialogHeader>
          
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(handleEditSubmit)} className="flex flex-col flex-1">
              <div className="space-y-4 overflow-y-scroll h-[400px] pr-2 dialog-scrollable">
                {/* 기본 정보 */}
                <div className="space-y-3">
                  <h4 className="text-sm font-medium">기본 정보</h4>
                  
                  <FormField
                    control={editForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>학생 이름</FormLabel>
                        <FormControl>
                          <Input placeholder="학생 이름을 입력하세요" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={editForm.control}
                    name="school"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>학교</FormLabel>
                        <FormControl>
                          <Input placeholder="학교명을 입력하세요" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={editForm.control}
                    name="grade"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>학년</FormLabel>
                        <FormControl>
                          <Input placeholder="예: 중1, 고2" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={editForm.control}
                    name="parentPhone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>학부모 연락처</FormLabel>
                        <FormControl>
                          <Input placeholder="연락처를 입력하세요" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={editForm.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>특이사항</FormLabel>
                        <FormControl>
                          <Textarea placeholder="특이사항을 입력하세요" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* 수강 정보 */}
                <div className="border-t pt-4 space-y-3">
                  <h4 className="text-sm font-medium">수강 정보</h4>
                  
                  <FormField
                    control={editForm.control}
                    name="classId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>수강할 반</FormLabel>
                        <Select 
                          onValueChange={(value) => field.onChange(value === "none" ? undefined : value)}
                          value={field.value ?? "none"}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="반을 선택하세요" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">반 미배정</SelectItem>
                            {Array.isArray(classes) && classes.filter((c: any) => c.isActive !== false).map((classItem: any) => (
                              <SelectItem key={classItem.id} value={classItem.id}>
                                {classItem.name} (기본 ₩{classItem.defaultTuition?.toLocaleString()})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  {editForm.watch("classId") && (
                    <>
                      <FormField
                        control={editForm.control}
                        name="startDate"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>수강 시작일</FormLabel>
                            <FormControl>
                              <Input type="date" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      
                      <FormField
                        control={editForm.control}
                        name="customTuition"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>개별 수강료</FormLabel>
                            <FormControl>
                              <Input 
                                type="number" 
                                placeholder="기본 수강료와 다를 경우만 입력"
                                value={field.value || ""}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  if (value === "") {
                                    field.onChange(undefined);
                                  } else {
                                    const numValue = parseInt(value);
                                    field.onChange(isNaN(numValue) ? undefined : numValue);
                                  }
                                }}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      
                      <FormField
                        control={editForm.control}
                        name="dueDay"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>납입 기준일</FormLabel>
                            <FormControl>
                              <Input 
                                type="number" 
                                min="1" 
                                max="31"
                                placeholder="8" 
                                value={field.value || ""}
                                onChange={(e) => {
                                  const value = e.target.value;
                                  if (value === "") {
                                    field.onChange(8);
                                  } else {
                                    const numValue = parseInt(value);
                                    field.onChange(isNaN(numValue) ? 8 : numValue);
                                  }
                                }}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </>
                  )}
                </div>
              </div>
              
              <DialogFooter className="flex-shrink-0">
                <Button 
                  type="submit" 
                  disabled={editStudentMutation.isPending}
                >
                  {editStudentMutation.isPending ? "수정 중..." : "수정 완료"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}