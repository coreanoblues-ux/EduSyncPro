import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Edit, Trash2, User, School, Users, Phone, Info, UserMinus, UserPlus } from "lucide-react";
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
  name: z.string().min(1, "학생 이름을 입력해주세요"),
  school: z.string().optional(),
  grade: z.string().optional(),
  gender: z.string().optional(),
  parentPhone: z.string().optional(),
  siblingGroup: z.string().optional(),
  notes: z.string().optional(),
  // 반 선택 관련 필드 추가
  classId: z.string().optional(),
  startDate: z.string().optional(),
  customTuition: z.number().optional(),
  dueDay: z.number().min(1).max(31).optional(),
});

type StudentFormData = z.infer<typeof studentFormSchema>;

interface StudentsProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
}

export default function Students({ userRole }: StudentsProps) {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const { toast } = useToast();

  // Fetch students
  const { data: students = [], isLoading } = useQuery<Student[]>({
    queryKey: ['/api/students'],
  });

  // Fetch classes for selection
  const { data: classes = [], isLoading: classesLoading } = useQuery<Class[]>({
    queryKey: ['/api/classes'],
  });

  // Add student mutation
  const addStudentMutation = useMutation({
    mutationFn: async (data: StudentFormData) => {
      // 학생 생성
      const studentResponse = await apiRequest('POST', '/api/students', {
        name: data.name,
        school: data.school,
        grade: data.grade,
        gender: data.gender,
        parentPhone: data.parentPhone,
        siblingGroup: data.siblingGroup,
        notes: data.notes,
      });
      const newStudent = await studentResponse.json();
      
      // 반이 선택되었다면 수강 등록도 생성
      if (data.classId && data.startDate) {
        const enrollmentData: Omit<InsertEnrollment, 'tenantId' | 'isActive'> = {
          studentId: newStudent.id,
          classId: data.classId,
          startDate: new Date(data.startDate),
          tuition: data.customTuition,
          dueDay: data.dueDay || 8,
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

  // Edit student mutation
  const editStudentMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string, data: StudentFormData }) => {
      const response = await apiRequest('PUT', `/api/students/${id}`, data);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
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
      school: "",
      grade: "",
      gender: "",
      parentPhone: "",
      siblingGroup: "",
      notes: "",
      classId: "",
      startDate: "",
      customTuition: undefined,
      dueDay: 8,
    },
  });

  // Form for editing student
  const editForm = useForm<StudentFormData>({
    resolver: zodResolver(studentFormSchema),
    defaultValues: {
      name: "",
      school: "",
      grade: "",
      gender: "",
      parentPhone: "",
      siblingGroup: "",
      notes: "",
    },
  });

  const handleAddStudent = (data: StudentFormData) => {
    addStudentMutation.mutate(data);
  };

  const handleEditStudent = (data: StudentFormData) => {
    if (editingStudent) {
      editStudentMutation.mutate({ id: editingStudent.id, data });
    }
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
    setEditingStudent(student);
    editForm.reset({
      name: student.name,
      school: student.school || "",
      grade: student.grade || "",
      gender: student.gender || "",
      parentPhone: student.parentPhone || "",
      siblingGroup: student.siblingGroup || "",
      notes: student.notes || "",
    });
    setIsEditDialogOpen(true);
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
                <FormField
                  control={addForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>학생 이름</FormLabel>
                      <FormControl>
                        <Input placeholder="학생 이름을 입력하세요" data-testid="input-student-name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addForm.control}
                  name="school"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>학교</FormLabel>
                      <FormControl>
                        <Input placeholder="학교명을 입력하세요" data-testid="input-student-school" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addForm.control}
                  name="grade"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>학년</FormLabel>
                      <FormControl>
                        <Input placeholder="예: 중1, 고2" data-testid="input-student-grade" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addForm.control}
                  name="gender"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>성별</FormLabel>
                      <FormControl>
                        <Input placeholder="남 또는 여" data-testid="input-student-gender" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addForm.control}
                  name="parentPhone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>학부모 연락처</FormLabel>
                      <FormControl>
                        <Input placeholder="연락처를 입력하세요" data-testid="input-student-parent-phone" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addForm.control}
                  name="siblingGroup"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>형제 그룹</FormLabel>
                      <FormControl>
                        <Input placeholder="형제할인을 위한 그룹명" data-testid="input-student-sibling-group" {...field} />
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
                      <FormLabel>특이사항</FormLabel>
                      <FormControl>
                        <Textarea placeholder="특이사항을 입력하세요" data-testid="input-student-notes" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                {/* 수강 등록 섹션 */}
                <div className="border-t pt-4 mt-4">
                  <div className="mb-3">
                    <h4 className="text-sm font-medium">수강 등록 (선택사항)</h4>
                    <p className="text-xs text-muted-foreground">학생 등록과 동시에 반에 수강 등록할 수 있습니다.</p>
                  </div>
                  
                  <FormField
                    control={addForm.control}
                    name="classId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>수강할 반</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-class">
                              <SelectValue placeholder="반을 선택하세요 (선택사항)" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {classes.filter(c => c.isActive !== false).map((classItem) => (
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
                  
                  {addForm.watch("classId") && (
                    <>
                      <FormField
                        control={addForm.control}
                        name="startDate"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>수강 시작일</FormLabel>
                            <FormControl>
                              <Input 
                                type="date" 
                                data-testid="input-start-date"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      
                      <FormField
                        control={addForm.control}
                        name="customTuition"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>개별 수강료 (선택사항)</FormLabel>
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
                            <FormLabel>납입 기준일</FormLabel>
                            <FormControl>
                              <Input 
                                type="number" 
                                min="1" 
                                max="31"
                                placeholder="8" 
                                data-testid="input-due-day"
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
        
        {userRole === 'superadmin' && (
          <div className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-lg flex items-center gap-2">
            <Info className="h-4 w-4" />
            <span>학생 등록/수정/삭제는 학원장과 교사만 가능합니다</span>
          </div>
        )}
      </div>

      {/* Students Grid */}
      {students.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          <User className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <div className="text-lg font-medium">등록된 학생이 없습니다</div>
          <p className="text-muted-foreground mt-2">첫 번째 학생을 등록해보세요.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {students.map((student) => (
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

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>학생 정보 수정</DialogTitle>
            <DialogDescription>
              학생 정보를 수정해주세요.
            </DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(handleEditStudent)} className="space-y-4">
              <FormField
                control={editForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>학생 이름</FormLabel>
                    <FormControl>
                      <Input placeholder="학생 이름을 입력하세요" data-testid="input-edit-student-name" {...field} />
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
                      <Input placeholder="학교명을 입력하세요" data-testid="input-edit-student-school" {...field} />
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
                      <Input placeholder="예: 중1, 고2" data-testid="input-edit-student-grade" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="gender"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>성별</FormLabel>
                    <FormControl>
                      <Input placeholder="남 또는 여" data-testid="input-edit-student-gender" {...field} />
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
                      <Input placeholder="연락처를 입력하세요" data-testid="input-edit-student-parent-phone" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="siblingGroup"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>형제 그룹</FormLabel>
                    <FormControl>
                      <Input placeholder="형제할인을 위한 그룹명" data-testid="input-edit-student-sibling-group" {...field} />
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
                      <Textarea placeholder="특이사항을 입력하세요" data-testid="input-edit-student-notes" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button 
                  type="submit" 
                  disabled={editStudentMutation.isPending}
                  data-testid="button-submit-edit-student"
                >
                  {editStudentMutation.isPending ? "수정 중..." : "수정"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}