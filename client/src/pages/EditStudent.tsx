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
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft } from "lucide-react";

const editStudentSchema = z.object({
  // 1. 이름 - 필수 필드
  name: z.string().min(1, "학생 이름을 입력해주세요"),
  // 2. 반선택 - 선택사항
  classId: z.string().optional(),
  // 3. 형제할인 - 선택사항
  siblingDiscount: z.string().optional(),
  siblingDiscountRate: z.enum(["5", "10"]).optional(),
  // 4. 학년 - 선택사항
  grade: z.string().optional(),
  // 5. 등록일 - 반이 선택된 경우 필수
  startDate: z.string().optional(),
  // 6. 납입 기준일 - 선택사항
  dueDay: z.number().min(1).max(31).optional(),
  // 7. 학부모 전화번호 - 선택사항
  parentPhone: z.string().optional(),
  // 8. 학교 - 선택사항
  school: z.string().optional(),
  // 9. 기타 비고란 - 선택사항
  notes: z.string().optional(),
  // 추가 필드들 (반 선택시 자동 처리)
  customTuition: z.number().optional(),
}).refine((data) => {
  // 반이 선택되었다면 시작일(등록일)이 필수
  if (data.classId) {
    return data.startDate && data.startDate !== "";
  }
  return true;
}, {
  message: "반을 선택했다면 등록일을 입력해주세요",
  path: ["startDate"],
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
  const { data: classes = [] } = useQuery({
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
      name: "",
      classId: undefined,
      siblingDiscount: "",
      siblingDiscountRate: undefined,
      grade: "",
      startDate: "",
      dueDay: undefined,
      parentPhone: "",
      school: "",
      notes: "",
      customTuition: undefined,
    },
  });

  // 학생 데이터가 로드되면 폼 업데이트
  useEffect(() => {
    if (student) {
      form.reset({
        name: student.name || "",
        classId: currentEnrollment?.classId || undefined,
        siblingDiscount: student.siblingGroup || "",
        siblingDiscountRate: undefined, // 할인율은 계산된 값이므로 초기값 없음
        grade: student.grade || "",
        startDate: currentEnrollment?.startDate || "",
        dueDay: currentEnrollment?.dueDay || undefined,
        parentPhone: student.parentPhone || "",
        school: student.school || "",
        notes: student.notes || "",
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
        school: data.school,
        grade: data.grade,
        parentPhone: data.parentPhone,
        siblingGroup: data.siblingDiscount,
        notes: data.notes,
      };
      
      const studentResponse = await apiRequest('PUT', `/api/students/${id}`, studentUpdateData);
      const updatedStudent = await studentResponse.json();
      
      // 2. 수강 정보 업데이트 (반이 선택된 경우)
      if (data.classId) {
        // 기본 수강료 계산
        const selectedClass = Array.isArray(classes) ? classes.find((c: any) => c.id === data.classId) : null;
        const baseTuition = data.customTuition ?? selectedClass?.defaultTuition ?? 0;
        
        // 할인율 적용
        let finalTuition = baseTuition;
        if (data.siblingDiscountRate) {
          const discountRate = parseInt(data.siblingDiscountRate) / 100;
          finalTuition = Math.round(baseTuition * (1 - discountRate));
        }
        
        const enrollmentData = {
          studentId: id,
          classId: data.classId,
          startDate: data.startDate,
          tuition: finalTuition,
          dueDay: data.dueDay,
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

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>학생 정보 수정</CardTitle>
          <CardDescription>
            학생의 기본 정보와 수강 정보를 수정할 수 있습니다.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              {/* 1. 이름 - 필수 필드 */}
              <FormField
                control={form.control}
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
                control={form.control}
                name="classId"
                render={({ field }) => {
                  const selectedClass = Array.isArray(classes) ? classes.find((c: any) => c.id === field.value) : null;
                  return (
                    <FormItem>
                      <FormLabel className="text-base font-medium">반선택</FormLabel>
                      <Select 
                        onValueChange={(value) => {
                          field.onChange(value === "none" ? undefined : value);
                          // 반 선택시 기본 수강료 자동 설정
                          if (value && value !== "none" && Array.isArray(classes)) {
                            const selectedClass = classes.find((c: any) => c.id === value);
                            if (selectedClass?.defaultTuition) {
                              form.setValue('customTuition', selectedClass.defaultTuition);
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
                          {Array.isArray(classes) && classes.filter((c: any) => c.isActive !== false).map((classItem: any) => (
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
                  control={form.control}
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
                  control={form.control}
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
                control={form.control}
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
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-base font-medium">
                      등록일 {form.watch("classId") && "*"}
                    </FormLabel>
                    <FormControl>
                      <Input 
                        type="date" 
                        data-testid="input-start-date"
                        {...field}
                        className="text-base"
                      />
                    </FormControl>
                    {form.watch("classId") && (
                      <div className="text-xs text-muted-foreground">
                        반을 선택했으므로 등록일이 필수입니다
                      </div>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* 6. 납입 기준일 */}
              {form.watch("classId") && (
                <FormField
                  control={form.control}
                  name="dueDay"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-base font-medium">납입 기준일</FormLabel>
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
                              field.onChange(8);
                            } else {
                              const numValue = parseInt(value);
                              field.onChange(isNaN(numValue) ? 8 : numValue);
                            }
                          }}
                          className="text-base"
                        />
                      </FormControl>
                      <div className="text-xs text-muted-foreground">
                        매월 납입 기준일 (기본값: 8일)
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
              
              {/* 7. 학부모 전화번호 */}
              <FormField
                control={form.control}
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
              
              {/* 8. 학교 */}
              <FormField
                control={form.control}
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
              
              {/* 9. 기타 비고란 */}
              <FormField
                control={form.control}
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
              {form.watch("classId") && (
                <div className="border-t pt-4 space-y-3">
                  <h4 className="text-sm font-medium text-muted-foreground">수강 설정</h4>
                  
                  <FormField
                    control={form.control}
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
                </div>
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