import { useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useParams, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft } from "lucide-react";

const editStudentSchema = z.object({
  name: z.string().min(1, "학생 이름을 입력해주세요"),
  classId: z.string().optional(),
  startDate: z.string().optional(),
  customTuition: z.number().optional(),
});

type EditStudentFormData = z.infer<typeof editStudentSchema>;

export default function EditStudent() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // 학생 정보 조회
  const { data: students } = useQuery({
    queryKey: ['/api/students']
  });

  // 반 정보 조회
  const { data: classes } = useQuery({
    queryKey: ['/api/classes']
  });

  // 수강 정보 조회
  const { data: enrollments } = useQuery({
    queryKey: ['/api/enrollments']
  });

  const student = Array.isArray(students) ? students.find((s: any) => s.id === id) : null;
  const enrollmentsArray = Array.isArray(enrollments) ? enrollments : [];
  const currentEnrollment = enrollmentsArray.find((e: any) => e.studentId === id);

  const form = useForm<EditStudentFormData>({
    resolver: zodResolver(editStudentSchema),
    defaultValues: {
      name: student?.name || "",
      classId: currentEnrollment?.classId || "unassigned",
      startDate: currentEnrollment?.startDate || "",
      customTuition: currentEnrollment?.tuition || undefined,
    },
  });

  // 학생 데이터가 로드되면 폼 업데이트
  useEffect(() => {
    if (student) {
      form.reset({
        name: student.name || "",
        classId: currentEnrollment?.classId || "unassigned",
        startDate: currentEnrollment?.startDate || "",
        customTuition: currentEnrollment?.tuition || undefined,
      });
    }
  }, [student, currentEnrollment, form]);

  // 학생 수정 mutation
  const editStudentMutation = useMutation({
    mutationFn: async (data: EditStudentFormData) => {
      // 1. 학생 기본 정보 업데이트
      const studentUpdateData = {
        name: data.name,
      };
      
      const studentResponse = await apiRequest('PUT', `/api/students/${id}`, studentUpdateData);
      const updatedStudent = await studentResponse.json();
      
      // 2. 수강 정보 업데이트 (반이 선택된 경우)
      if (data.classId && data.classId !== "unassigned") {
        const enrollmentData = {
          studentId: id,
          classId: data.classId,
          startDate: data.startDate,
          tuition: data.customTuition,
          dueDay: currentEnrollment?.dueDay || 8,
        };
        
        if (currentEnrollment) {
          // 기존 수강 정보 업데이트
          await apiRequest('PUT', `/api/enrollments/${currentEnrollment.id}`, enrollmentData);
        } else {
          // 새 수강 등록 생성
          await apiRequest('POST', '/api/enrollments', enrollmentData);
        }
      } else {
        // 반이 선택되지 않은 경우 기존 수강 정보 삭제
        if (currentEnrollment) {
          await apiRequest('DELETE', `/api/enrollments/${currentEnrollment.id}`);
        }
      }
      
      return updatedStudent;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/students'] });
      queryClient.invalidateQueries({ queryKey: ['/api/enrollments'] });
      toast({
        title: "학생 수정 완료",
        description: "학생 정보가 성공적으로 수정되었습니다.",
      });
      setLocation('/students');
    },
    onError: (error: Error) => {
      toast({
        title: "학생 수정 실패",
        description: error.message || "학생 수정 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: EditStudentFormData) => {
    editStudentMutation.mutate(data);
  };

  if (!student) {
    return (
      <div className="container mx-auto p-6">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="sm" onClick={() => setLocation('/students')} data-testid="button-back">
            <ArrowLeft className="w-4 h-4 mr-2" />
            돌아가기
          </Button>
        </div>
        <Card>
          <CardContent className="p-6">
            <p>학생을 찾을 수 없습니다.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6">
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" size="sm" onClick={() => setLocation('/students')} data-testid="button-back">
          <ArrowLeft className="w-4 h-4 mr-2" />
          돌아가기
        </Button>
        <h1 className="text-2xl font-bold">학생 정보 수정</h1>
      </div>

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>학생 정보 수정</CardTitle>
          <CardDescription>
            학생의 기본 정보와 수강 정보를 수정할 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
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
                control={form.control}
                name="classId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>수강할 반</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-class">
                          <SelectValue placeholder="반을 선택하세요" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="unassigned">반 미배정</SelectItem>
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

              {form.watch("classId") && form.watch("classId") !== "unassigned" && (
                <FormField
                  control={form.control}
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
              )}

              {form.watch("classId") && form.watch("classId") !== "unassigned" && (
                <FormField
                  control={form.control}
                  name="customTuition"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>개별 수강료 (선택사항)</FormLabel>
                      <FormControl>
                        <Input 
                          type="number" 
                          placeholder="개별 수강료를 입력하세요"
                          data-testid="input-custom-tuition"
                          value={field.value || ""}
                          onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <div className="flex gap-2 pt-4">
                <Button 
                  type="submit" 
                  disabled={editStudentMutation.isPending}
                  data-testid="button-submit"
                >
                  {editStudentMutation.isPending ? "수정 중..." : "수정 완료"}
                </Button>
                <Button 
                  type="button" 
                  variant="outline"
                  onClick={() => setLocation('/students')}
                  data-testid="button-cancel"
                >
                  취소
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}