import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Plus, Edit, Trash2, User, School, Users, Phone, Info, UserMinus, UserPlus, Search, BookOpen } from "lucide-react";
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
import { Student, Class, Teacher, InsertEnrollment } from "@shared/schema";
import { labelClassesByTeacher } from "@shared/classLabel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * 학원 학생 대부분이 영어라 영어는 배지 없이 이름만 보여준다.
 * 국어 등 그 외 과목만 이름 옆에 배지가 붙어 눈에 띄게 한다.
 */
const DEFAULT_SUBJECT = "영어";

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
  // 반 추가 대상 학생 (EditStudent는 기존 수강을 덮어써서 두 번째 반을 만들 수 없다)
  const [addClassTarget, setAddClassTarget] = useState<Student | null>(null);
  const [addClassId, setAddClassId] = useState<string>("");
  const [addClassStartDate, setAddClassStartDate] = useState<string>("");
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
  const { data: teachers = [] } = useQuery<Teacher[]>({
    queryKey: ['/api/teachers'],
  });

  // 반은 담당 교사끼리 붙여서 보여준다. 원장이 "누구 반"으로 찾기 때문이다.
  const classOptions = useMemo(
    () => labelClassesByTeacher(classes.filter((c) => c.isActive !== false), teachers),
    [classes, teachers]
  );

  /**
   * 카드 한 장 = 수강 한 건.
   *
   * 한 학생이 국어와 영어를 함께 들으면 "김윤후 [국어]", "김윤후 [영어]" 두 장이 뜬다.
   * 학생당 한 장만 보여주면 두 번째 과목이 화면에서 사라져, 원장이 반별로 학생을
   * 훑을 때 실제 수강 인원과 눈에 보이는 인원이 어긋난다.
   */
  interface StudentCardData {
    student: Student;
    enrollment: any | null;
    cls: any | null;
    teacherName: string | null;
    /** 이 학생이 듣는 전체 과목 — 삭제·휴원이 어디까지 영향을 주는지 알려주는 데 쓴다 */
    subjects: string[];
    /** 학생당 첫 카드에만 "반 추가" 버튼을 둔다 (카드마다 있으면 중복 조작처럼 보인다) */
    isPrimary: boolean;
  }

  const cards = useMemo<StudentCardData[]>(() => {
    const enrollmentsArray = Array.isArray(enrollments) ? enrollments : [];
    const classesArray = Array.isArray(classes) ? classes : [];
    const teachersArray = Array.isArray(teachers) ? teachers : [];

    const classById = new Map(classesArray.map((c: any) => [c.id, c]));
    const teacherById = new Map(teachersArray.map((t: any) => [t.id, t]));

    return students.flatMap((student: any) => {
      const mine = enrollmentsArray.filter(
        (e: any) => e.studentId === student.id && e.isActive
      );
      const subjects = mine
        .map((e: any) => classById.get(e.classId)?.subject)
        .filter(Boolean) as string[];

      // 반이 배정되지 않은 학생도 목록에서 사라지면 안 된다.
      // (수강 건수로만 카드를 만들면 미배정 학생이 통째로 안 보인다)
      if (mine.length === 0) {
        return [{ student, enrollment: null, cls: null, teacherName: null, subjects: [], isPrimary: true }];
      }

      return mine
        .map((e: any) => {
          const cls = classById.get(e.classId) ?? null;
          return {
            student,
            enrollment: e,
            cls,
            teacherName: cls?.teacherId ? teacherById.get(cls.teacherId)?.name ?? null : null,
            subjects,
            isPrimary: false,
          };
        })
        // 배지 없는 기본 과목(영어) 카드를 먼저 두어 "강단우" 다음에 "강단우 [국어]"가 오게 한다.
        .sort((a: StudentCardData, b: StudentCardData) => {
          const rank = (c: StudentCardData) => (c.cls?.subject === DEFAULT_SUBJECT ? 0 : 1);
          return rank(a) - rank(b);
        })
        .map((c: StudentCardData, i: number) => ({ ...c, isPrimary: i === 0 }));
    });
  }, [students, enrollments, classes, teachers]);

  // 검색은 카드 단위로 건다. "영어"로 검색하면 그 학생의 영어 카드만 남는다.
  const filteredCards = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return cards;

    return cards.filter(({ student, cls, teacherName }) => {
      if (student.name.toLowerCase().includes(q)) return true;
      if (cls?.name?.toLowerCase().includes(q)) return true;
      if (cls?.subject?.toLowerCase().includes(q)) return true;
      if (teacherName?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [searchTerm, cards]);

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


  // 기존 학생에게 반을 하나 더 붙인다. 국어·영어를 함께 듣는 학생이 두 장의 카드를 갖게 된다.
  const addEnrollmentMutation = useMutation({
    mutationFn: async ({ studentId, classId, startDate }: { studentId: string; classId: string; startDate: string }) => {
      const selectedClass = classes.find((c) => c.id === classId);
      await apiRequest('POST', '/api/enrollments', {
        studentId,
        classId,
        startDate,
        tuition: selectedClass?.defaultTuition ?? null,
        dueDay: 8,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/enrollments'] });
      setAddClassTarget(null);
      toast({
        title: "반 추가 완료",
        description: "학생에게 새로운 반이 추가되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "반 추가 실패",
        description: error.message || "반 추가 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // 이미 듣고 있는 반은 목록에서 뺀다. 같은 반을 두 번 등록하면 카드가 중복으로 뜬다.
  const alreadyEnrolledClassIds = useMemo(() => {
    if (!addClassTarget) return new Set<string>();
    const enrollmentsArray = Array.isArray(enrollments) ? enrollments : [];
    return new Set<string>(
      enrollmentsArray
        .filter((e: any) => e.studentId === addClassTarget.id && e.isActive)
        .map((e: any) => e.classId)
    );
  }, [addClassTarget, enrollments]);

  const openAddClassDialog = (student: Student) => {
    setAddClassId("");
    setAddClassStartDate(new Date().toISOString().slice(0, 10));
    setAddClassTarget(student);
  };

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
              학생 {students.length}명 · 수강 {cards.filter((c) => c.enrollment).length}건
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
                            {classOptions.map((classItem) => (
                              <SelectItem key={classItem.id} value={classItem.id}>
                                {classItem.label} (기본 ₩{classItem.defaultTuition?.toLocaleString()})
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
            {searchTerm ? `${filteredCards.length}건 (검색 결과)` : `총 ${filteredCards.length}건`}
          </div>
        </div>
        {filteredCards.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          <User className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <div className="text-lg font-medium">등록된 학생이 없습니다</div>
          <p className="text-muted-foreground mt-2">첫 번째 학생을 등록해보세요.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredCards.map(({ student, enrollment, cls, teacherName, subjects, isPrimary }) => {
            const cardKey = `${student.id}-${enrollment?.id ?? "none"}`;
            // 삭제·휴원은 학생 단위라 다른 과목 카드까지 함께 사라진다. 그 사실을 문구로 알린다.
            const scopeNote =
              subjects.length > 1 ? ` 수강 중인 ${subjects.join("·")} ${subjects.length}개 반이 모두 함께 처리됩니다.` : "";
            return (
            <Card key={cardKey} className="hover-elevate" data-testid={`student-card-${cardKey}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-lg" data-testid={`student-name-${cardKey}`}>
                    {student.name}
                  </CardTitle>
                  {/*
                    영어가 기본 과목이라 배지를 붙이지 않는다. 국어처럼 기본이 아닌
                    과목만 이름 옆에 배지로 드러내서 "강단우" / "강단우 [국어]"
                    두 장이 한눈에 구분되게 한다.
                  */}
                  {cls && cls.subject !== DEFAULT_SUBJECT && (
                    <Badge variant="outline" className="text-sm font-semibold" data-testid={`student-subject-${cardKey}`}>
                      {cls.subject}
                    </Badge>
                  )}
                  {!cls && (
                    <Badge variant="outline" className="text-sm text-muted-foreground">
                      반 미배정
                    </Badge>
                  )}
                  <Badge
                    variant={student.isActive ? "default" : "secondary"}
                    data-testid={`student-status-${cardKey}`}
                  >
                    {student.isActive ? "활성" : "비활성"}
                  </Badge>
                </div>
                {(userRole === 'owner' || userRole === 'teacher') && (
                  <div className="flex items-center gap-1">
                    {/* 반 추가 버튼 — 학생당 한 번만 노출한다 */}
                    {isPrimary && student.isActive && (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="반 추가"
                        onClick={() => openAddClassDialog(student)}
                        data-testid={`button-add-class-${student.id}`}
                      >
                        <BookOpen className="h-4 w-4 text-blue-500" />
                      </Button>
                    )}

                    {/* 수정 버튼 */}
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openEditDialog(student)}
                      data-testid={`button-edit-student-${cardKey}`}
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
                            data-testid={`button-deactivate-student-${cardKey}`}
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
                              {scopeNote}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel data-testid={`button-cancel-deactivate-student-${cardKey}`}>
                              취소
                            </AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleDeactivateStudent(student.id)}
                              data-testid={`button-confirm-deactivate-student-${cardKey}`}
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
                            data-testid={`button-activate-student-${cardKey}`}
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
                            <AlertDialogCancel data-testid={`button-cancel-activate-student-${cardKey}`}>
                              취소
                            </AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleActivateStudent(student.id)}
                              data-testid={`button-confirm-activate-student-${cardKey}`}
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
                          data-testid={`button-delete-student-${cardKey}`}
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
                            {scopeNote}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel data-testid={`button-cancel-delete-student-${cardKey}`}>
                            취소
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDeleteStudent(student.id)}
                            data-testid={`button-confirm-delete-student-${cardKey}`}
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
                {/* 과목만으로는 어느 반인지 모른다. 같은 과목이 여러 반으로 갈리기 때문. */}
                {cls && (
                  <div className="flex items-start gap-2 text-sm">
                    <BookOpen className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <div>
                      <div className="font-medium" data-testid={`student-class-${cardKey}`}>{cls.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {cls.schedule}
                        {teacherName ? ` · ${teacherName} 선생님` : ""}
                      </div>
                    </div>
                  </div>
                )}
                {student.school && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <School className="h-4 w-4" />
                    <span data-testid={`student-school-${cardKey}`}>{student.school}</span>
                  </div>
                )}
                {student.grade && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Users className="h-4 w-4" />
                    <span data-testid={`student-grade-${cardKey}`}>{student.grade}</span>
                  </div>
                )}
                {student.parentPhone && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Phone className="h-4 w-4" />
                    <span data-testid={`student-parent-phone-${cardKey}`}>{student.parentPhone}</span>
                  </div>
                )}
                {student.siblingGroup && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Users className="h-4 w-4" />
                    <span data-testid={`student-sibling-group-${cardKey}`}>형제그룹: {student.siblingGroup}</span>
                  </div>
                )}
                {student.notes && (
                  <div className="text-xs text-muted-foreground">
                    <span data-testid={`student-notes-${cardKey}`}>{student.notes}</span>
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  {enrollment
                    ? `수강 시작: ${new Date(enrollment.startDate).toLocaleDateString()}`
                    : `등록일: ${new Date(student.createdAt).toLocaleDateString()}`}
                </div>
              </CardContent>
            </Card>
            );
          })}
        </div>
      )}
      </div>

      {/* 반 추가 다이얼로그 — 기존 수강을 건드리지 않고 수강 건만 하나 더 만든다 */}
      <Dialog open={!!addClassTarget} onOpenChange={(open) => !open && setAddClassTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>반 추가</DialogTitle>
            <DialogDescription>
              {addClassTarget?.name} 학생에게 반을 하나 더 추가합니다. 기존 반은 그대로 유지됩니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>반</Label>
              <Select value={addClassId} onValueChange={setAddClassId}>
                <SelectTrigger data-testid="select-add-class">
                  <SelectValue placeholder="반을 선택하세요" />
                </SelectTrigger>
                <SelectContent>
                  {classes
                    .filter((c) => !alreadyEnrolledClassIds.has(c.id))
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        [{c.subject}] {c.name} · {c.schedule}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>수강 시작일</Label>
              <Input
                type="date"
                value={addClassStartDate}
                onChange={(e) => setAddClassStartDate(e.target.value)}
                data-testid="input-add-class-start-date"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddClassTarget(null)}>
              취소
            </Button>
            <Button
              disabled={!addClassId || !addClassStartDate || addEnrollmentMutation.isPending}
              onClick={() =>
                addClassTarget &&
                addEnrollmentMutation.mutate({
                  studentId: addClassTarget.id,
                  classId: addClassId,
                  startDate: addClassStartDate,
                })
              }
              data-testid="button-confirm-add-class"
            >
              추가
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}