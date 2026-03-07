import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Edit, Trash2, BookOpen, Users, Calendar, DollarSign, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Class, Teacher } from "@shared/schema";

const classFormSchema = z.object({
  teacherId: z.string().min(1, "담당 교사를 선택해주세요"),
  name: z.string().min(1, "반 이름을 입력해주세요"),
  subject: z.string().min(1, "과목을 입력해주세요"),
  schedule: z.string().min(1, "수업 일정을 입력해주세요"),
  defaultTuition: z.number().min(0, "수강료는 0 이상이어야 합니다"),
  maxStudents: z.number().min(1, "최대 인원은 1명 이상이어야 합니다").default(20),
});

type ClassFormData = z.infer<typeof classFormSchema>;

interface ClassesProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
}

export default function Classes({ userRole }: ClassesProps) {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingClass, setEditingClass] = useState<Class | null>(null);
  const { toast } = useToast();

  // Fetch classes
  const { data: classes = [], isLoading } = useQuery<Class[]>({
    queryKey: ['/api/classes'],
  });

  // Fetch teachers for dropdown
  const { data: teachers = [] } = useQuery<Teacher[]>({
    queryKey: ['/api/teachers'],
  });

  // Add class mutation
  const addClassMutation = useMutation({
    mutationFn: async (data: ClassFormData) => {
      const response = await apiRequest('POST', '/api/classes', data);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/classes'] });
      setIsAddDialogOpen(false);
      addForm.reset();
      toast({
        title: "반 등록 완료",
        description: "새 반이 성공적으로 등록되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "반 등록 실패",
        description: error.message || "반 등록 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // Edit class mutation
  const editClassMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string, data: ClassFormData }) => {
      const response = await apiRequest('PUT', `/api/classes/${id}`, data);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/classes'] });
      setIsEditDialogOpen(false);
      setEditingClass(null);
      toast({
        title: "반 수정 완료",
        description: "반 정보가 성공적으로 수정되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "반 수정 실패",
        description: error.message || "반 수정 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // Delete class mutation
  const deleteClassMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await apiRequest('DELETE', `/api/classes/${id}`);
      return await response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/classes'] });
      toast({
        title: data.hardDeleted ? "반 완전 삭제 완료" : "반 비활성 처리 완료",
        description: data.message,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "반 삭제 실패",
        description: error.message || "반 삭제 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // Form for adding class
  const addForm = useForm<ClassFormData>({
    resolver: zodResolver(classFormSchema),
    defaultValues: {
      teacherId: "",
      name: "",
      subject: "",
      schedule: "",
      defaultTuition: 150000,
      maxStudents: 20,
    },
  });

  // Form for editing class
  const editForm = useForm<ClassFormData>({
    resolver: zodResolver(classFormSchema),
    defaultValues: {
      teacherId: "",
      name: "",
      subject: "",
      schedule: "",
      defaultTuition: 150000,
      maxStudents: 20,
    },
  });

  const handleAddClass = (data: ClassFormData) => {
    addClassMutation.mutate(data);
  };

  const handleEditClass = (data: ClassFormData) => {
    if (editingClass) {
      editClassMutation.mutate({ id: editingClass.id, data });
    }
  };

  const handleDeleteClass = (id: string) => {
    deleteClassMutation.mutate(id);
  };

  const openEditDialog = (classItem: Class) => {
    setEditingClass(classItem);
    editForm.reset({
      teacherId: classItem.teacherId,
      name: classItem.name,
      subject: classItem.subject,
      schedule: classItem.schedule,
      defaultTuition: classItem.defaultTuition,
      maxStudents: classItem.maxStudents || 20,
    });
    setIsEditDialogOpen(true);
  };

  const getTeacherName = (teacherId: string) => {
    const teacher = teachers.find(t => t.id === teacherId);
    return teacher?.name || "담당교사 미지정";
  };

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">반 관리</h1>
        </div>
        <div className="text-center py-8">
          <div className="text-muted-foreground">반 목록을 불러오는 중...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6" data-testid="classes-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">반 관리</h1>
          <p className="text-muted-foreground">
            반 {classes.length}개가 등록되어 있습니다
          </p>
        </div>
        
        {(userRole === 'owner' || userRole === 'superadmin') && (
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-class">
                <Plus className="h-4 w-4 mr-2" />
                반 추가
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>새 반 등록</DialogTitle>
                <DialogDescription>
                  새로운 반 정보를 입력해주세요.
                </DialogDescription>
              </DialogHeader>
              <Form {...addForm}>
                <form onSubmit={addForm.handleSubmit(handleAddClass)} className="space-y-4">
                  <FormField
                    control={addForm.control}
                    name="teacherId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>담당 교사</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-teacher">
                              <SelectValue placeholder="교사를 선택하세요" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {teachers.filter(t => t.isActive).map((teacher) => (
                              <SelectItem key={teacher.id} value={teacher.id}>
                                {teacher.name} - {teacher.subject}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>반 이름</FormLabel>
                        <FormControl>
                          <Input placeholder="반 이름을 입력하세요" data-testid="input-class-name" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="subject"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>과목</FormLabel>
                        <FormControl>
                          <Input placeholder="과목을 입력하세요" data-testid="input-class-subject" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="schedule"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>수업 일정</FormLabel>
                        <FormControl>
                          <Input placeholder="예: 월수금 19:00-21:00" data-testid="input-class-schedule" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="defaultTuition"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>기본 수강료</FormLabel>
                        <FormControl>
                          <Input 
                            type="number" 
                            placeholder="150000" 
                            data-testid="input-class-tuition"
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
                    name="maxStudents"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>최대 인원</FormLabel>
                        <FormControl>
                          <Input 
                            type="number" 
                            placeholder="20" 
                            data-testid="input-class-max-students"
                            {...field}
                            onChange={(e) => field.onChange(parseInt(e.target.value) || 20)}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <DialogFooter>
                    <Button 
                      type="submit" 
                      disabled={addClassMutation.isPending}
                      data-testid="button-submit-add-class"
                    >
                      {addClassMutation.isPending ? "등록 중..." : "등록"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        )}
        
        {userRole === 'teacher' && (
          <div className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-lg flex items-center gap-2">
            <Info className="h-4 w-4" />
            <span>반 등록/수정/삭제는 학원장만 가능합니다</span>
          </div>
        )}
      </div>

      {/* Classes Grid */}
      {classes.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          <BookOpen className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <div className="text-lg font-medium">등록된 반이 없습니다</div>
          <p className="text-muted-foreground mt-2">첫 번째 반을 등록해보세요.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {classes.map((classItem) => (
            <Card key={classItem.id} className="hover-elevate" data-testid={`class-card-${classItem.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-lg">{classItem.name}</CardTitle>
                  <Badge 
                    variant={classItem.isActive ? "default" : "secondary"}
                    data-testid={`class-status-${classItem.id}`}
                  >
                    {classItem.isActive ? "활성" : "비활성"}
                  </Badge>
                </div>
                {(userRole === 'owner' || userRole === 'superadmin') && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openEditDialog(classItem)}
                      data-testid={`button-edit-class-${classItem.id}`}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          data-testid={`button-delete-class-${classItem.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>반 삭제</AlertDialogTitle>
                          <AlertDialogDescription>
                            정말로 {classItem.name} 반을 삭제하시겠습니까?
                            이 작업은 되돌릴 수 없습니다.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel data-testid={`button-cancel-delete-class-${classItem.id}`}>
                            취소
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteClass(classItem.id)}
                            data-testid={`button-confirm-delete-class-${classItem.id}`}
                          >
                            삭제
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <BookOpen className="h-4 w-4" />
                  <span>{classItem.subject}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Users className="h-4 w-4" />
                  <span>담당: {getTeacherName(classItem.teacherId)}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  <span>{classItem.schedule}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <DollarSign className="h-4 w-4" />
                  <span>₩{classItem.defaultTuition.toLocaleString()} (최대 {classItem.maxStudents}명)</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  생성일: {new Date(classItem.createdAt).toLocaleDateString()}
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
            <DialogTitle>반 정보 수정</DialogTitle>
            <DialogDescription>
              반 정보를 수정해주세요.
            </DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(handleEditClass)} className="space-y-4">
              <FormField
                control={editForm.control}
                name="teacherId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>담당 교사</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-edit-teacher">
                          <SelectValue placeholder="교사를 선택하세요" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {teachers.filter(t => t.isActive).map((teacher) => (
                          <SelectItem key={teacher.id} value={teacher.id}>
                            {teacher.name} - {teacher.subject}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>반 이름</FormLabel>
                    <FormControl>
                      <Input placeholder="반 이름을 입력하세요" data-testid="input-edit-class-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="subject"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>과목</FormLabel>
                    <FormControl>
                      <Input placeholder="과목을 입력하세요" data-testid="input-edit-class-subject" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="schedule"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>수업 일정</FormLabel>
                    <FormControl>
                      <Input placeholder="예: 월수금 19:00-21:00" data-testid="input-edit-class-schedule" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="defaultTuition"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>기본 수강료</FormLabel>
                    <FormControl>
                      <Input 
                        type="number" 
                        placeholder="150000" 
                        data-testid="input-edit-class-tuition"
                        {...field}
                        onChange={(e) => field.onChange(parseInt(e.target.value) || 0)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="maxStudents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>최대 인원</FormLabel>
                    <FormControl>
                      <Input 
                        type="number" 
                        placeholder="20" 
                        data-testid="input-edit-class-max-students"
                        {...field}
                        onChange={(e) => field.onChange(parseInt(e.target.value) || 20)}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button 
                  type="submit" 
                  disabled={editClassMutation.isPending}
                  data-testid="button-submit-edit-class"
                >
                  {editClassMutation.isPending ? "수정 중..." : "수정"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}