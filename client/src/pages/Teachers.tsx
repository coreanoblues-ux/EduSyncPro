import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Edit, Trash2, Users, Phone, Mail, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Teacher } from "@shared/schema";

const teacherFormSchema = z.object({
  userId: z.string().optional(),
  name: z.string().min(1, "이름을 입력해주세요"),
  subject: z.string().min(1, "담당 과목을 입력해주세요"),
  phone: z.string().optional(),
});

type TeacherFormData = z.infer<typeof teacherFormSchema>;

interface TeachersProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
}

export default function Teachers({ userRole }: TeachersProps) {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingTeacher, setEditingTeacher] = useState<Teacher | null>(null);
  const { toast } = useToast();

  // Fetch teachers
  const { data: teachers = [], isLoading } = useQuery<Teacher[]>({
    queryKey: ['/api/teachers'],
  });

  // Add teacher mutation
  const addTeacherMutation = useMutation({
    mutationFn: async (data: TeacherFormData) => {
      const response = await apiRequest('POST', '/api/teachers', data);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/teachers'] });
      setIsAddDialogOpen(false);
      toast({
        title: "교사 등록 완료",
        description: "새 교사가 성공적으로 등록되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "교사 등록 실패",
        description: error.message || "교사 등록 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // Edit teacher mutation
  const editTeacherMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string, data: TeacherFormData }) => {
      const response = await apiRequest('PUT', `/api/teachers/${id}`, data);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/teachers'] });
      setIsEditDialogOpen(false);
      setEditingTeacher(null);
      toast({
        title: "교사 수정 완료",
        description: "교사 정보가 성공적으로 수정되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "교사 수정 실패",
        description: error.message || "교사 수정 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // Delete teacher mutation
  const deleteTeacherMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/teachers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/teachers'] });
      toast({
        title: "교사 삭제 완료",
        description: "교사가 성공적으로 삭제되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "교사 삭제 실패",
        description: error.message || "교사 삭제 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // Form for adding teacher
  const addForm = useForm<TeacherFormData>({
    resolver: zodResolver(teacherFormSchema),
    defaultValues: {
      name: "",
      subject: "",
      phone: "",
    },
  });

  // Form for editing teacher
  const editForm = useForm<TeacherFormData>({
    resolver: zodResolver(teacherFormSchema),
    defaultValues: {
      name: "",
      subject: "",
      phone: "",
    },
  });

  const handleAddTeacher = (data: TeacherFormData) => {
    addTeacherMutation.mutate(data);
  };

  const handleEditTeacher = (data: TeacherFormData) => {
    if (editingTeacher) {
      editTeacherMutation.mutate({ id: editingTeacher.id, data });
    }
  };

  const handleDeleteTeacher = (id: string) => {
    deleteTeacherMutation.mutate(id);
  };

  const openEditDialog = (teacher: Teacher) => {
    setEditingTeacher(teacher);
    editForm.reset({
      name: teacher.name,
      subject: teacher.subject,
      phone: teacher.phone || "",
    });
    setIsEditDialogOpen(true);
  };

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">교사 관리</h1>
        </div>
        <div className="text-center py-8">
          <div className="text-muted-foreground">교사 목록을 불러오는 중...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6" data-testid="teachers-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">교사 관리</h1>
          <p className="text-muted-foreground">
            교사 {teachers.length}명이 등록되어 있습니다
          </p>
        </div>
        
        {(userRole === 'owner' || userRole === 'superadmin') && (
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-teacher">
                <Plus className="h-4 w-4 mr-2" />
                교사 추가
              </Button>
            </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>새 교사 등록</DialogTitle>
              <DialogDescription>
                새로운 교사 정보를 입력해주세요.
              </DialogDescription>
            </DialogHeader>
            <Form {...addForm}>
              <form onSubmit={addForm.handleSubmit(handleAddTeacher)} className="space-y-4">
                <FormField
                  control={addForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>이름</FormLabel>
                      <FormControl>
                        <Input placeholder="교사 이름을 입력하세요" data-testid="input-teacher-name" {...field} />
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
                      <FormLabel>담당 과목</FormLabel>
                      <FormControl>
                        <Input placeholder="담당 과목을 입력하세요" data-testid="input-teacher-subject" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={addForm.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>연락처 (선택사항)</FormLabel>
                      <FormControl>
                        <Input placeholder="연락처를 입력하세요" data-testid="input-teacher-phone" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button 
                    type="submit" 
                    disabled={addTeacherMutation.isPending}
                    data-testid="button-submit-add-teacher"
                  >
                    {addTeacherMutation.isPending ? "등록 중..." : "등록"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
        )}
        
        {userRole === 'teacher' && (
          <div className="text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-lg">
            📝 교사 등록/수정/삭제는 학원장만 가능합니다
          </div>
        )}
      </div>

      {/* Teachers Grid */}
      {teachers.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <div className="text-lg font-medium">등록된 교사가 없습니다</div>
          <p className="text-muted-foreground mt-2">첫 번째 교사를 등록해보세요.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {teachers.map((teacher) => (
            <Card key={teacher.id} className="hover-elevate" data-testid={`teacher-card-${teacher.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-lg">{teacher.name}</CardTitle>
                  <Badge 
                    variant={teacher.isActive ? "default" : "secondary"}
                    data-testid={`teacher-status-${teacher.id}`}
                  >
                    {teacher.isActive ? "활성" : "비활성"}
                  </Badge>
                </div>
                {(userRole === 'owner' || userRole === 'superadmin') && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openEditDialog(teacher)}
                      data-testid={`button-edit-teacher-${teacher.id}`}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          size="icon"
                          variant="ghost"
                          data-testid={`button-delete-teacher-${teacher.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>교사 삭제</AlertDialogTitle>
                          <AlertDialogDescription>
                            정말로 {teacher.name} 교사를 삭제하시겠습니까?
                            이 작업은 되돌릴 수 없습니다.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>취소</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteTeacher(teacher.id)}
                            data-testid={`button-confirm-delete-teacher-${teacher.id}`}
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
                  <span>{teacher.subject}</span>
                </div>
                {teacher.phone && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Phone className="h-4 w-4" />
                    <span>{teacher.phone}</span>
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  등록일: {new Date(teacher.createdAt).toLocaleDateString()}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>교사 정보 수정</DialogTitle>
            <DialogDescription>
              교사 정보를 수정해주세요.
            </DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(handleEditTeacher)} className="space-y-4">
              <FormField
                control={editForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>이름</FormLabel>
                    <FormControl>
                      <Input placeholder="교사 이름을 입력하세요" data-testid="input-edit-teacher-name" {...field} />
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
                    <FormLabel>담당 과목</FormLabel>
                    <FormControl>
                      <Input placeholder="담당 과목을 입력하세요" data-testid="input-edit-teacher-subject" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>연락처 (선택사항)</FormLabel>
                    <FormControl>
                      <Input placeholder="연락처를 입력하세요" data-testid="input-edit-teacher-phone" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button 
                  type="submit" 
                  disabled={editTeacherMutation.isPending}
                  data-testid="button-submit-edit-teacher"
                >
                  {editTeacherMutation.isPending ? "수정 중..." : "수정"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}