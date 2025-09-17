import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, BookOpen, Calendar, FileText, GraduationCap, User, Info, Pencil } from "lucide-react";
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
import { LessonLog, Class, User as UserType } from "@shared/schema";

const lessonLogFormSchema = z.object({
  classId: z.string().min(1, "반을 선택해주세요"),
  date: z.string().min(1, "수업 일자를 입력해주세요"),
  progress: z.string().optional(),
  homework: z.string().optional(), 
  notes: z.string().optional(),
});

type LessonLogFormData = z.infer<typeof lessonLogFormSchema>;

interface LessonLogsProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
}

export default function LessonLogs({ userRole }: LessonLogsProps) {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedClassFilter, setSelectedClassFilter] = useState<string>('all');
  const { toast } = useToast();

  // Fetch lesson logs
  const { data: lessonLogs = [], isLoading: lessonLogsLoading } = useQuery<LessonLog[]>({
    queryKey: ['/api/lesson-logs'],
  });

  // Fetch classes for dropdown and display
  const { data: classes = [], isLoading: classesLoading } = useQuery<Class[]>({
    queryKey: ['/api/classes'],
  });

  // Fetch users to map createdBy
  const { data: users = [] } = useQuery<UserType[]>({
    queryKey: ['/api/users'],
  });

  // Add lesson log mutation
  const addLessonLogMutation = useMutation({
    mutationFn: async (data: LessonLogFormData) => {
      const payload = {
        ...data,
        date: new Date(data.date),
      };
      const response = await apiRequest('POST', '/api/lesson-logs', payload);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/lesson-logs'] });
      setIsAddDialogOpen(false);
      addForm.reset();
      toast({
        title: "수업 일지 등록 완료",
        description: "새 수업 일지가 성공적으로 등록되었습니다.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "수업 일지 등록 실패",
        description: error.message || "수업 일지 등록 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  // Form for adding lesson log
  const addForm = useForm<LessonLogFormData>({
    resolver: zodResolver(lessonLogFormSchema),
    defaultValues: {
      classId: "",
      date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
      progress: "",
      homework: "",
      notes: "",
    },
  });

  const handleAddLessonLog = (data: LessonLogFormData) => {
    addLessonLogMutation.mutate(data);
  };

  const getClassName = (classId: string) => {
    const classItem = classes.find(c => c.id === classId);
    return classItem?.name || "반 정보 없음";
  };

  const getCreatorName = (createdBy: string) => {
    const user = users.find(u => u.id === createdBy);
    return user?.name || "사용자 정보 없음";
  };

  const getFilteredLessonLogs = () => {
    if (selectedClassFilter === 'all') return lessonLogs;
    return lessonLogs.filter(log => log.classId === selectedClassFilter);
  };

  const formatDate = (dateString: string | Date) => {
    const date = dateString instanceof Date ? dateString : new Date(dateString);
    return date.toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: 'long', 
      day: 'numeric',
      weekday: 'short'
    });
  };

  if (lessonLogsLoading || classesLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">반별 일지</h1>
        </div>
        <div className="text-center py-8">
          <div className="text-muted-foreground">반별 일지를 불러오는 중...</div>
        </div>
      </div>
    );
  }

  const filteredLogs = getFilteredLessonLogs();

  return (
    <div className="space-y-6 p-6" data-testid="lesson-logs-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">반별 일지</h1>
          <p className="text-muted-foreground">
            수업 일지 {filteredLogs.length}건이 등록되어 있습니다
          </p>
        </div>
        
        {(userRole === 'owner' || userRole === 'teacher') && (
          <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-lesson-log">
                <Plus className="h-4 w-4 mr-2" />
                일지 작성
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>새 수업 일지 작성</DialogTitle>
                <DialogDescription>
                  수업 일지 정보를 입력해주세요.
                </DialogDescription>
              </DialogHeader>
              <Form {...addForm}>
                <form onSubmit={addForm.handleSubmit(handleAddLessonLog)} className="space-y-4">
                  <FormField
                    control={addForm.control}
                    name="classId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>반 선택</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-class">
                              <SelectValue placeholder="반을 선택하세요" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {classes.filter(c => c.isActive !== false).map((classItem) => (
                              <SelectItem key={classItem.id} value={classItem.id}>
                                {classItem.name}
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
                    name="date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>수업 일자</FormLabel>
                        <FormControl>
                          <Input 
                            type="date"
                            data-testid="input-lesson-date"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="progress"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>진도 사항</FormLabel>
                        <FormControl>
                          <Textarea 
                            placeholder="오늘 진행한 수업 내용과 진도를 입력하세요" 
                            rows={3}
                            data-testid="input-lesson-progress"
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={addForm.control}
                    name="homework"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>숙제</FormLabel>
                        <FormControl>
                          <Textarea 
                            placeholder="학생들에게 내준 숙제를 입력하세요" 
                            rows={2}
                            data-testid="input-lesson-homework"
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
                        <FormLabel>특이사항</FormLabel>
                        <FormControl>
                          <Textarea 
                            placeholder="수업 중 특별한 사항이나 메모를 입력하세요" 
                            rows={2}
                            data-testid="input-lesson-notes"
                            {...field} 
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <DialogFooter>
                    <Button 
                      type="submit" 
                      disabled={addLessonLogMutation.isPending}
                      data-testid="button-submit-add-lesson-log"
                    >
                      {addLessonLogMutation.isPending ? "등록 중..." : "등록"}
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
            <span>수업 일지 작성은 학원장과 교사만 가능합니다</span>
          </div>
        )}
      </div>

      {/* Filter Controls */}
      <div className="flex items-center gap-4">
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
        <Badge variant="secondary" data-testid="filtered-count">
          {filteredLogs.length}건
        </Badge>
      </div>

      {/* Lesson Logs Grid */}
      {filteredLogs.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          <Pencil className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <div className="text-lg font-medium">
            {selectedClassFilter === 'all' ? '등록된 수업 일지가 없습니다' : '해당 반의 수업 일지가 없습니다'}
          </div>
          <p className="text-muted-foreground mt-2">첫 번째 수업 일지를 작성해보세요.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Sort by date descending */}
          {[...filteredLogs]
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
            .map((log) => (
            <Card key={log.id} className="hover-elevate" data-testid={`lesson-log-card-${log.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg" data-testid={`lesson-log-class-${log.id}`}>
                      {getClassName(log.classId)}
                    </CardTitle>
                    <Badge variant="outline" data-testid={`lesson-log-date-${log.id}`}>
                      <Calendar className="h-3 w-3 mr-1" />
                      {formatDate(log.date)}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <User className="h-4 w-4" />
                    <span data-testid={`lesson-log-creator-${log.id}`}>
                      작성: {getCreatorName(log.createdBy)}
                    </span>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {log.progress && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      <BookOpen className="h-4 w-4" />
                      진도 사항
                    </div>
                    <div className="pl-6 text-sm" data-testid={`lesson-log-progress-${log.id}`}>
                      {log.progress}
                    </div>
                  </div>
                )}
                {log.homework && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      <GraduationCap className="h-4 w-4" />
                      숙제
                    </div>
                    <div className="pl-6 text-sm" data-testid={`lesson-log-homework-${log.id}`}>
                      {log.homework}
                    </div>
                  </div>
                )}
                {log.notes && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      <FileText className="h-4 w-4" />
                      특이사항
                    </div>
                    <div className="pl-6 text-sm" data-testid={`lesson-log-notes-${log.id}`}>
                      {log.notes}
                    </div>
                  </div>
                )}
                <div className="text-xs text-muted-foreground pt-2 border-t">
                  등록일: {new Date(log.createdAt).toLocaleDateString('ko-KR')} {new Date(log.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Summary Stats */}
      {lessonLogs.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BookOpen className="h-5 w-5" />
              수업 일지 요약
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="text-center">
              <div className="text-2xl font-bold text-primary">
                {lessonLogs.length}건
              </div>
              <p className="text-sm text-muted-foreground">총 일지 수</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {classes.filter(c => c.isActive !== false).length}개
              </div>
              <p className="text-sm text-muted-foreground">활성 반</p>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">
                {filteredLogs.length}건
              </div>
              <p className="text-sm text-muted-foreground">현재 필터 결과</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}