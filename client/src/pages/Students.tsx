import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Plus, Edit, Trash2, User, School, Users, Phone, Info, UserMinus, UserPlus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Student, Class, InsertEnrollment } from "@shared/schema";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const studentFormSchema = z.object({
  // 1. 이름 - 필수 필드
  name: z.string().min(1, "학생 이름을 입력해주세요"),
  // 2. 반선택 - 선택사항
  classId: z.string().optional(),
  // 3. 형제할인 - 선택사항
  siblingDiscount: z.string().optional(),
  siblingDiscountRate: z.enum(["5", "10"]).optional(), // none 제거하고 undefined 사용
  // 4. 학년 - 선택사항
  grade: z.string().optional(),
  // 5. 등록일 - 반이 선택된 경우 필수
  startDate: z.string().optional(),
  // 6. 학부모 전화번호 - 선택사항
  parentPhone: z.string().optional(),
  // 7. 학교 - 선택사항
  school: z.string().optional(),
  // 8. 기타 비고란 - 선택사항
  notes: z.string().optional(),
  // 추가 필드들 (반 선택시 자동 처리)
  customTuition: z.number().optional(),
  dueDay: z.number().min(1).max(31).optional(),
}).refine((data) => {
  // 반이 선택되었다면 시작일(등록일)이 필수
  if (data.classId && data.classId.trim() !== "") {
    return data.startDate && data.startDate.trim() !== "";
  }
  return true;
}, {
  message: "반을 선택했다면 등록일을 입력해주세요",
  path: ["startDate"],
});

type StudentFormData = z.infer<typeof studentFormSchema>;

interface StudentsProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
}

export default function Students({ userRole }: StudentsProps) {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // Fetch students
  const { data: students = [], isLoading } = useQuery<Student[]>({
    queryKey: ['/api/students'],
  });

  // Fetch classes for selection
  const { data: classes = [], isLoading: classesLoading } = useQuery<Class[]>({
    queryKey: ['/api/classes'],
  });

  // Fetch enrollments for editing student enrollment info
  const { data: enrollments = [] } = useQuery({
    queryKey: ['/api/enrollments'],
  });

  // Fetch teachers for search functionality
  const { data: teachers = [] } = useQuery({
    queryKey: ['/api/teachers'],
  });

  // 향상된 검색 기능: 학생명, 반명, 선생님 이름으로 검색
  const filteredStudents = useMemo(() => {
    if (!searchTerm.trim()) return students;

    const searchLower = searchTerm.toLowerCase();
    const enrollmentsArray = Array.isArray(enrollments) ? enrollments : [];
    const classesArray = Array.isArray(classes) ? classes : [];
    const teachersArray = Array.isArray(teachers) ? teachers : [];

    return students.filter((student: any) => {
      // 1. 학생명으로 검색
      if (student.name.toLowerCase().includes(searchLower)) return true;
      
      // 2. 학생의 수강 정보를 찾기
      const studentEnrollment = enrollmentsArray.find((e: any) => e.studentId === student.id && e.isActive);
      if (studentEnrollment) {
        // 3. 반명으로 검색
        const studentClass = classesArray.find((c: any) => c.id === studentEnrollment.classId);
        if (studentClass) {
          // 반명으로 검색
          if (studentClass.name.toLowerCase().includes(searchLower)) return true;
          
          // 4. 선생님 이름으로 검색
          if (studentClass.teacherId) {
            const teacher = teachersArray.find((t: any) => t.id === studentClass.teacherId);
            if (teacher && teacher.name.toLowerCase().includes(searchLower)) return true;
          }
        }
      }
      
      return false;
    });
  }, [searchTerm, students, enrollments, classes, teachers]);

  // Add student mutation
  const addStudentMutation = useMutation({
    mutationFn: async (data: StudentFormData) => {
      // 학생 생성
      const studentResponse = await apiRequest('POST', '/api/students', {
        name: data.name,
        school: data.school,
        grade: data.grade,
        parentPhone: data.parentPhone,
        siblingGroup: data.siblingDiscount,
        notes: data.notes,
      });
      const newStudent = await studentResponse.json();
      
      // 반이 선택되었다면 수강 등록도 생성
      if (data.classId && data.startDate && data.startDate.trim()) {
        // 기본 수강료 계산
        const selectedClass = classes.find(c => c.id === data.classId);
        const baseTuition = data.customTuition ?? selectedClass?.defaultTuition ?? 0;
        
        // 할인율 적용
        let finalTuition = baseTuition;
        if (data.siblingDiscountRate) {
          const discountRate = parseInt(data.siblingDiscountRate) / 100;
          finalTuition = Math.round(baseTuition * (1 - discountRate));
        }
        
        const enrollmentData = {
          studentId: newStudent.id,
          classId: data.classId,
          startDate: data.startDate, // 문자열 그대로 보내기
          tuition: finalTuition ?? null, // 할인이 적용된 최종 수강료
          dueDay: data.dueDay,
        };
        
        await apiRequest('POST', '/api/enrollments', enrollmentData);
      }
      
      return newStudent;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/enrollments'] });
      setIsAddDialogOpen(false);
      addForm.reset();
      const createdEnrollment = !!(variables.classId && variables.startDate);
      const enrollmentMessage = createdEnrollment ? " 및 수강 등록이" : "이";
      toast({
        title: "학생 등록 완료",
        description: `새 학생${enrollmentMessage} 성공적으로 완료되었습니다.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "학생 등록 실패",
        description: error.message || "학생 등록 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });


  // Delete student mutation
  const deleteStudentMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/students/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "학생 완전 삭제 완료",
        description: "학생이 데이터베이스에서 완전히 삭제되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "학생 삭제 실패",
        description: error.message || "학생 삭제 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // 학생 휴원 처리 (비활성화)
  const deactivateStudentMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('PATCH', `/api/students/${id}/deactivate`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "휴원 처리 완료",
        description: "학생이 휴원 처리되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "휴원 처리 실패",
        description: error.message || "휴원 처리 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // 학생 재등록 처리 (활성화)
  const activateStudentMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('PATCH', `/api/students/${id}/activate`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      toast({
        title: "재등록 완료",
        description: "학생이 성공적으로 재등록되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "재등록 실패",
        description: error.message || "재등록 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // Form for adding student
  const addForm = useForm<StudentFormData>({
    resolver: zodResolver(studentFormSchema),
    defaultValues: {
      name: "",
      classId: undefined,
      siblingDiscount: "",
      siblingDiscountRate: undefined,
      grade: "",
      startDate: "",
      parentPhone: "",
      school: "",
      notes: "",
      customTuition: undefined,
      dueDay: undefined,
    },
  });

  // Form for editing student

  const handleAddStudent = (data: StudentFormData) => {
    addStudentMutation.mutate(data);
  };


  const handleDeleteStudent = (id: string) => {
    deleteStudentMutation.mutate(id);
  };

  const handleDeactivateStudent = (id: string) => {
    deactivateStudentMutation.mutate(id);
  };

  const handleActivateStudent = (id: string) => {
    activateStudentMutation.mutate(id);
  };

  const openEditDialog = (student: Student) => {
    setLocation(`/students/edit/${student.id}`);
  };

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">학생 관리</h1>
        </div>
        <div className="text-center py-8">
          <div className="text-muted-foreground">학생 목록을 불러오는 중...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6" data-testid="students-page">
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">학생 관리</h1>
            <p className="text-muted-foreground">
              학생 {students.length}명이 등록되어 있습니다
            </p>
          </div>
          
          {(userRole === 'owner' || userRole === 'teacher') && (
            <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-student">
                <Plus className="h-4 w-4 mr-2" />
                학생 추가
              </Button>
            </DialogTrigger>
          <DialogContent className="max-w-lg h-[600px] flex flex-col">
            <DialogHeader className="flex-shrink-0">
              <DialogTitle>새 학생 등록</DialogTitle>
              <DialogDescription>
                새로운 학생 정보를 입력해주세요.
              </DialogDescription>
            </DialogHeader>
            <Form {...addForm}>
              <form onSubmit={addForm.handleSubmit(handleAddStudent)} className="flex flex-col flex-1">
                <div className="space-y-4 overflow-y-scroll h-[400px] pr-2 dialog-scrollable">
                {/* 1. 이름 - 필수 필드 */}
                <FormField
                  control={addForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-medium">이름 *</FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="학생 이름을 입력하세요" 
                          data-testid="input-student-name" 
                          {...field} 
                          className="text-base"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* 2. 반선택 - 자동 수강료 통합 */}
                <FormField
                  control={addForm.control}
                  name="classId"
                  render={({ field }) => {
                    const selectedClass = classes.find(c => c.id === field.value);
                    return (
                      <FormItem>
                        <FormLabel className="text-base font-medium">반선택</FormLabel>
                        <Select 
                          onValueChange={(value) => {
                            field.onChange(value === "none" ? undefined : value);
                            // 반 선택시 기본 수강료 자동 설정
                            if (value && value !== "none") {
                              const selectedClass = classes.find(c => c.id === value);
                              if (selectedClass?.defaultTuition) {
                                addForm.setValue('customTuition', selectedClass.defaultTuition);
                              }
                            }
                          }} 
                          value={field.value ?? "none"}
                        >
                          <FormControl>
                            <SelectTrigger data-testid="select-class" className="text-base">
                              <SelectValue placeholder="반을 선택하세요 (선택사항)" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">반을 선택하지 않음</SelectItem>
                            {classes.filter(c => c.isActive !== false).sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((classItem) => (
                              <SelectItem key={classItem.id} value={classItem.id}>
                                {classItem.name} (기본 ₩{classItem.defaultTuition?.toLocaleString()})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {selectedClass && (
                          <div className="text-sm text-muted-foreground mt-2">
                            선택된 반: {selectedClass.name} | 수강료: ₩{selectedClass.defaultTuition?.toLocaleString()}
                          </div>
                        )}
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />
                
                {/* 3. 형제할인 */}
                <div className="space-y-3">
                  <FormField
                    control={addForm.control}
                    name="siblingDiscount"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-base font-medium">형제할인</FormLabel>
                        <FormControl>
                          <Input 
                            placeholder="형제할인 그룹명 (예: 김가족)" 
                            data-testid="input-student-sibling-discount" 
                            {...field} 
                            className="text-base"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={addForm.control}
                    name="siblingDiscountRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-sm font-normal text-muted-foreground">할인율 적용</FormLabel>
                        <Select 
                          onValueChange={(value) => field.onChange(value === "none" ? undefined : value)}
                          value={field.value ?? "none"}
                        >
                          <FormControl>
                            <SelectTrigger data-testid="select-sibling-discount-rate" className="text-base">
                              <SelectValue placeholder="할인율 선택 (선택사항)" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">할인 없음</SelectItem>
                            <SelectItem value="5">5% 할인</SelectItem>
                            <SelectItem value="10">10% 할인</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                
                {/* 4. 학년 */}
                <FormField
                  control={addForm.control}
                  name="grade"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-medium">학년</FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="예: 중1, 고2, 초6" 
                          data-testid="input-student-grade" 
                          {...field} 
                          className="text-base"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                {/* 5. 등록일 */}
                <FormField
                  control={addForm.control}
                  name="startDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-medium">등록일 {addForm.watch("classId") && "*"}</FormLabel>
                      <FormControl>
                        <Input 
                          type="date" 
                          data-testid="input-start-date"
                          {...field}
                          className="text-base"
                        />
                      </FormControl>
                      {addForm.watch("classId") && (
                        <div className="text-xs text-muted-foreground">
                          반을 선택했으므로 등록일이 필수입니다
                        </div>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                {/* 6. 학부모 전화번호 */}
                <FormField
                  control={addForm.control}
                  name="parentPhone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-medium">학부모 전화번호</FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="010-1234-5678" 
                          data-testid="input-parent-phone" 
                          {...field} 
                          className="text-base"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                {/* 7. 학교 */}
                <FormField
                  control={addForm.control}
                  name="school"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-medium">학교</FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="학교명을 입력하세요" 
                          data-testid="input-student-school" 
                          {...field} 
                          className="text-base"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                {/* 8. 기타 비고란 */}
                <FormField
                  control={addForm.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-medium">기타 비고란</FormLabel>
                      <FormControl>
                        <Textarea 
                          placeholder="특이사항이나 추가 정보를 입력하세요" 
                          data-testid="input-student-notes" 
                          {...field} 
                          className="text-base min-h-[80px]"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                {/* 추가 설정 (반 선택시에만 표시) */}
                {addForm.watch("classId") && (
                  <div className="border-t pt-4 space-y-3">
                    <h4 className="text-sm font-medium text-muted-foreground">수강 설정</h4>
                    
                    <FormField
                      control={addForm.control}
                      name="customTuition"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm">개별 수강료 (선택사항)</FormLabel>
                          <FormControl>
                            <Input 
                              type="number" 
                              placeholder="기본 수강료와 다를 경우만 입력"
                              data-testid="input-custom-tuition"
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
                              className="text-base"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    
                    <FormField
                      control={addForm.control}
                      name="dueDay"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-sm">납입 기준일</FormLabel>
                          <FormControl>
                            <Input 
                              type="number" 
                              min="1" 
                              max="31"
                              placeholder="납입 기준일을 입력하세요 (1-31)" 
                              data-testid="input-due-day"
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
                              className="text-base"
                            />
                          </FormControl>
                          <div className="text-xs text-muted-foreground">
                            매월 납입 기준일 (1-31일)
                          </div>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                )}
                </div>
                
                <DialogFooter className="flex-shrink-0">
                  <Button 
                    type="submit" 
                    disabled={addStudentMutation.isPending}
                    data-testid="button-submit-add-student"
                  >
                    {addStudentMutation.isPending ? "등록 중..." : "등록"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
          </Dialog>
        )}
        </div>
        
        {userRole === 'superadmin' && (
          <div className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-lg flex items-center gap-2">
            <Info className="h-4 w-4" />
            <span>학생 등록/수정/삭제는 학원장과 교사만 가능합니다</span>
          </div>
        )}
        
        {/* Search Input */}
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="학생명, 반명, 선생님 이름으로 검색..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
            data-testid="input-search-students"
          />
        </div>
      </div>

      {/* Students Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">학생 목록</h2>
          <div className="text-sm text-muted-foreground">
            {searchTerm ? `${filteredStudents.length}명 (검색 결과)` : `총 ${students.length}명`}
          </div>
        </div>
        {filteredStudents.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          <User className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <div className="text-lg font-medium">등록된 학생이 없습니다</div>
          <p className="text-muted-foreground mt-2">첫 번째 학생을 등록해보세요.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredStudents.map((student) => (
            <Card key={student.id} className="hover-elevate" data-testid={`student-card-${student.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-lg" data-testid={`student-name-${student.id}`}>
                    {student.name}
                  </CardTitle>
                  <Badge 
                    variant={student.isActive ? "default" : "secondary"}
                    data-testid={`student-status-${student.id}`}
                  >
                    {student.isActive ? "활성" : "비활성"}
                  </Badge>
                </div>
                {(userRole === 'owner' || userRole === 'teacher') && (
                  <div className="flex items-center gap-1">
                    {/* 수정 버튼 */}
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openEditDialog(student)}
                      data-testid={`button-edit-student-${student.id}`}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    
                    {/* 활성 학생에게만 휴원 버튼 표시 */}
                    {student.isActive && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            data-testid={`button-deactivate-student-${student.id}`}
                          >
                            <UserMinus className="h-4 w-4 text-orange-500" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>학생 휴강</AlertDialogTitle>
                            <AlertDialogDescription>
                              정말로 {student.name} 학생을 휴강 처리하시겠습니까?
                              휴강된 학생은 재수강을 통해 다시 활성화할 수 있습니다.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel data-testid={`button-cancel-deactivate-student-${student.id}`}>
                              취소
                            </AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDeactivateStudent(student.id)}
                              data-testid={`button-confirm-deactivate-student-${student.id}`}
                            >
                              휴강 처리
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                    
                    {/* 비활성 학생에게만 재등록 버튼 표시 */}
                    {!student.isActive && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            data-testid={`button-activate-student-${student.id}`}
                          >
                            <UserPlus className="h-4 w-4 text-green-500" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>학생 재수강</AlertDialogTitle>
                            <AlertDialogDescription>
                              정말로 {student.name} 학생을 재수강하시겠습니까?
                              재수강하면 해당 학생이 다시 활성화됩니다.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel data-testid={`button-cancel-activate-student-${student.id}`}>
                              취소
                            </AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleActivateStudent(student.id)}
                              data-testid={`button-confirm-activate-student-${student.id}`}
                            >
                              재수강
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                    
                    {/* 완전 삭제 버튼 */}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          data-testid={`button-delete-student-${student.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>학생 퇴원</AlertDialogTitle>
                          <AlertDialogDescription>
                            정말로 {student.name} 학생을 퇴원 처리하시겠습니까?
                            이 작업은 되돌릴 수 없으며, 모든 데이터가 영구적으로 삭제됩니다.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel data-testid={`button-cancel-delete-student-${student.id}`}>
                            취소
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteStudent(student.id)}
                            data-testid={`button-confirm-delete-student-${student.id}`}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            퇴원
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {student.school && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <School className="h-4 w-4" />
                    <span data-testid={`student-school-${student.id}`}>{student.school}</span>
                  </div>
                )}
                {student.grade && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Users className="h-4 w-4" />
                    <span data-testid={`student-grade-${student.id}`}>{student.grade}</span>
                  </div>
                )}
                {student.parentPhone && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Phone className="h-4 w-4" />
                    <span data-testid={`student-parent-phone-${student.id}`}>{student.parentPhone}</span>
                  </div>
                )}
                {student.siblingGroup && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Users className="h-4 w-4" />
                    <span data-testid={`student-sibling-group-${student.id}`}>형제그룹: {student.siblingGroup}</span>
                  </div>
                )}
                {student.notes && (
                  <div className="text-xs text-muted-foreground">
                    <span data-testid={`student-notes-${student.id}`}>{student.notes}</span>
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  등록일: {new Date(student.createdAt).toLocaleDateString()}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}