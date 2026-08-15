import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useLocation } from "wouter";
import DashboardCard from "./DashboardCard";
import QuickInput from "./QuickInput";
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  Clock,
  Flame,
  ListChecks,
  MessageSquarePlus,
  Phone,
  Settings,
  Sunrise,
  Users,
} from "lucide-react";
import { computeOverdues } from "@/lib/overdues";
import { taskSeverity } from "@/lib/tasks";
import { apiRequest } from "@/lib/queryClient";
import { daysBetween, todayKst } from "@shared/day";
import type { Class, Consultation, Enrollment, Payment, Student, Task } from "@shared/schema";

interface DashboardProps {
  userRole: 'owner' | 'teacher' | 'superadmin';
  tenant?: {
    id: string;
    name: string;
    status: 'pending' | 'active' | 'expired' | 'suspended';
  } | null;
}

/** 대시보드에 한 번에 보여줄 줄 수. 넘치면 해당 페이지로 넘긴다. */
const PREVIEW_LIMIT = 5;
/** 미납은 타일이라 한 줄에 두 개씩 들어간다. 반 폭에서 2열 × 3줄이 딱 떨어진다. */
const OVERDUE_PREVIEW_LIMIT = 6;
/** 할 일은 한 줄씩이라 미납 타일 3줄과 높이를 맞추면 여섯 줄쯤 된다. */
const TASK_PREVIEW_LIMIT = 6;

function formatDate(value: string | Date) {
  return new Date(value).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

export default function Dashboard({ userRole, tenant }: DashboardProps) {
  const [, setLocation] = useLocation();

  // 승인되지 않은 테넌트는 데이터를 불러오지 않음
  const isApproved = !tenant || tenant.status === 'active' || userRole === 'superadmin';

  const { data: classes = [] } = useQuery<Class[]>({
    queryKey: ['/api/classes'],
    enabled: isApproved,
  });

  const { data: enrollments = [] } = useQuery<Enrollment[]>({
    queryKey: ['/api/enrollments'],
    enabled: isApproved,
  });

  const { data: payments = [] } = useQuery<Payment[]>({
    queryKey: ['/api/payments'],
    enabled: isApproved,
  });

  const { data: students = [] } = useQuery<Student[]>({
    queryKey: ['/api/students'],
    enabled: isApproved,
  });

  const { data: consultations = [] } = useQuery<Consultation[]>({
    queryKey: ['/api/consultations'],
    enabled: isApproved,
  });

  const { data: tasks = [] } = useQuery<Task[]>({
    queryKey: ['/api/tasks'],
    enabled: isApproved,
  });

  const qc = useQueryClient();
  const completeTask = useMutation({
    mutationFn: async (id: string) => apiRequest("PATCH", `/api/tasks/${id}`, { completed: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/tasks'] }),
  });

  const today = todayKst();

  // 대시보드는 "지금 손대야 하는 것"만 보여준다. 내일 이후 일정은 탭에서 본다.
  const openTasks = useMemo(
    () =>
      tasks
        .filter((t) => !t.completedAt && t.dueDate <= today)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [tasks, today]
  );

  // 아직 학생이 되지 않은 사람들. 여기가 비면 다음 달 매출이 빈다.
  const newConsultations = useMemo(
    () =>
      consultations
        .filter((c) => c.status === "상담문의")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [consultations]
  );

  const waiting = useMemo(
    () =>
      consultations
        .filter((c) => c.status === "대기등록")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [consultations]
  );

  const overdues = useMemo(
    () => computeOverdues(enrollments, payments, students, classes),
    [enrollments, payments, students, classes]
  );

  // 오래 밀린 순으로 보여준다. 3개월 밀린 학생이 1개월 밑에 묻히면 안 된다.
  const overduesBySeverity = useMemo(
    () => [...overdues].sort((a, b) => b.overdueMonths.length - a.overdueMonths.length),
    [overdues]
  );

  const summaryCards = useMemo(() => {
    const common = [
      {
        title: "신규 상담",
        value: `${newConsultations.length}건`,
        description: "아직 등록 전",
        icon: MessageSquarePlus,
      },
      {
        title: "대기 등록",
        value: `${waiting.length}건`,
        description: "자리 나면 연락",
        icon: Clock,
      },
      {
        title: "미납",
        value: `${overdues.length}건`,
        description: "기준일 경과",
        icon: AlertTriangle,
      },
    ];

    if (userRole === 'owner' || userRole === 'superadmin') {
      return [
        ...common,
        {
          title: "재원 학생",
          value: `${students.length}명`,
          description: `운영 반 ${classes.length}개`,
          icon: Users,
        },
      ];
    }

    return [
      ...common,
      {
        title: "재원 학생",
        value: "권한 필요",
        description: "학원장만 볼 수 있습니다",
        icon: Users,
        isRestricted: true,
      },
    ];
  }, [newConsultations.length, waiting.length, overdues.length, students.length, classes.length, userRole]);

  if (!isApproved) {
    return (
      <div className="space-y-6 p-6" data-testid="dashboard">
        <TenantBanner tenant={tenant} userRole={userRole} />
        <div className="rounded-lg border-2 border-dashed border-muted-foreground/25 py-12 text-center">
          <p className="text-lg font-medium">학원 승인 대기 중</p>
          <p className="mt-1 text-sm text-muted-foreground">
            승인 후 모든 기능을 사용할 수 있습니다.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6" data-testid="dashboard">
      <TenantBanner tenant={tenant} userRole={userRole} />

      {/* 자연어 AI 입력 — 승인된 학원에서만 노출 */}
      {userRole !== 'superadmin' && <QuickInput />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summaryCards.map((card) => (
          <DashboardCard key={card.title} {...card} />
        ))}
      </div>

      {userRole === 'superadmin' && (
        <Button variant="secondary" onClick={() => setLocation('/superadmin')} data-testid="button-pending-academies">
          <Settings className="mr-2 h-4 w-4" />
          Pending 학원확인
        </Button>
      )}

      {/*
        원장이 아침에 확인해야 하는 순서대로 세로로 쌓는다.
        1) 새로 들어온 상담  2) 자리 기다리는 대기  3) 돈이 안 들어온 미납
      */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="신규 상담"
          count={newConsultations.length}
          icon={MessageSquarePlus}
          accent="text-blue-600 dark:text-blue-400"
          emptyText="새로 들어온 상담이 없습니다."
          onMore={() => setLocation('/consultations')}
          testId="dashboard-new-consultations"
        >
          {newConsultations.slice(0, PREVIEW_LIMIT).map((c) => (
            <ConsultationRow key={c.id} consultation={c} />
          ))}
        </SectionCard>

        <SectionCard
          title="대기 등록"
          count={waiting.length}
          icon={Clock}
          accent="text-amber-600 dark:text-amber-400"
          emptyText="대기 중인 학생이 없습니다."
          onMore={() => setLocation('/consultations')}
          testId="dashboard-waiting"
        >
          {waiting.slice(0, PREVIEW_LIMIT).map((c) => (
            <ConsultationRow key={c.id} consultation={c} />
          ))}
        </SectionCard>
      </div>

      {/*
        아래 줄은 왼쪽 미납 · 오른쪽 퇴근전 할 일로 반씩 나눈다.
        미납이 폭을 다 쓰면 이름과 금액 사이가 한 뼘씩 벌어져 텅 빈 것처럼 보였고,
        오른쪽이 비어 있느니 퇴근 전에 끝내야 할 일을 같이 띄우는 편이 낫다.
      */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="미납"
          count={overdues.length}
          icon={AlertTriangle}
          accent="text-red-600 dark:text-red-400"
          emptyText="미납 건이 없습니다."
          onMore={() => setLocation('/overdues')}
          testId="dashboard-overdues"
          layout="grid"
        >
          {overduesBySeverity.slice(0, OVERDUE_PREVIEW_LIMIT).map((o) => (
            <div
              key={o.enrollment.id}
              className="rounded-md border px-3 py-2 hover-elevate"
              data-testid={`dashboard-overdue-${o.enrollment.id}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium">{o.student.name}</span>
                <span className="shrink-0 text-sm font-semibold text-red-600 dark:text-red-400">
                  {o.totalOverdueAmount.toLocaleString()}원
                </span>
              </div>
              <div className="mt-1 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                <BookOpen className="h-3 w-3 shrink-0" />
                <span className="truncate">{o.class.name}</span>
                <Badge variant="destructive" className="ml-auto shrink-0 text-[10px]">
                  {o.overdueMonths.length}개월 · {o.latestOverdueMonth}
                </Badge>
              </div>
              {o.student.parentPhone && (
                <a
                  href={`tel:${o.student.parentPhone}`}
                  className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:underline"
                >
                  <Phone className="h-3 w-3" />
                  {o.student.parentPhone}
                </a>
              )}
            </div>
          ))}
        </SectionCard>

        <SectionCard
          title="퇴근전 할 일"
          count={openTasks.length}
          icon={ListChecks}
          accent="text-emerald-600 dark:text-emerald-400"
          emptyText="퇴근 전에 할 일이 없습니다."
          onMore={() => setLocation('/todos')}
          testId="dashboard-tasks"
        >
          {openTasks.slice(0, TASK_PREVIEW_LIMIT).map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              today={today}
              onComplete={() => completeTask.mutate(t.id)}
              disabled={completeTask.isPending}
            />
          ))}
        </SectionCard>
      </div>
    </div>
  );
}

/** 대시보드에서는 완료만 누를 수 있다. 미루기·삭제는 탭에서 한다. */
function TaskRow({
  task,
  today,
  onComplete,
  disabled,
}: {
  task: Task;
  today: string;
  onComplete: () => void;
  disabled: boolean;
}) {
  const daysLate = Math.max(daysBetween(task.dueDate, today), 0);
  const s = taskSeverity(daysLate);

  return (
    <div
      className={`flex items-center gap-3 rounded-md px-2 py-2 ${daysLate > 0 ? `border ${s.card}` : "hover-elevate"}`}
      data-testid={`dashboard-task-${task.id}`}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onComplete}
        aria-label="완료"
        data-testid={`dashboard-task-complete-${task.id}`}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-muted-foreground/40 text-transparent transition-colors hover:border-emerald-600 hover:bg-emerald-600 hover:text-white"
      >
        <Check className="h-4 w-4" />
      </button>
      <span className={`min-w-0 flex-1 truncate text-sm font-medium ${s.title}`}>{task.title}</span>
      {task.slot === "출근전" && daysLate === 0 && (
        <Sunrise className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      )}
      {daysLate > 0 && (
        <Badge className={`shrink-0 gap-1 text-[10px] ${s.badge}`}>
          {s.level >= 3 && <Flame className="h-3 w-3" />}
          {daysLate}일 밀림
        </Badge>
      )}
    </div>
  );
}

function TenantBanner({
  tenant,
  userRole,
}: {
  tenant: DashboardProps["tenant"];
  userRole: DashboardProps["userRole"];
}) {
  if (!tenant || userRole === 'superadmin') return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="text-2xl font-bold tracking-tight">{tenant.name}</h1>
      {tenant.status === 'active' ? (
        <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">
          승인됨
        </Badge>
      ) : tenant.status === 'pending' ? (
        <Badge variant="destructive">미승인</Badge>
      ) : (
        <Badge variant="secondary">{tenant.status}</Badge>
      )}
    </div>
  );
}

function SectionCard({
  title,
  count,
  icon: Icon,
  accent,
  emptyText,
  onMore,
  testId,
  layout = "list",
  children,
}: {
  title: string;
  count: number;
  icon: typeof AlertTriangle;
  accent: string;
  emptyText: string;
  onMore: () => void;
  testId: string;
  /** 폭이 넓은 카드는 "grid"로 타일을 깔아야 가로 여백이 남지 않는다 */
  layout?: "list" | "grid";
  children: React.ReactNode;
}) {
  const shown = Array.isArray(children) ? children.length : count;

  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className={`h-4 w-4 ${accent}`} />
          {title}
          <span className="text-sm font-normal text-muted-foreground">{count}</span>
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={onMore} data-testid={`${testId}-more`}>
          전체보기
          <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        {count === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <>
            <div
              className={
                layout === "grid" ? "grid gap-2 sm:grid-cols-2" : "divide-y"
              }
            >
              {children}
            </div>
            {count > shown && (
              <p className="pt-2 text-center text-xs text-muted-foreground">
                외 {count - shown}건
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ConsultationRow({ consultation }: { consultation: Consultation }) {
  const name = consultation.studentName || consultation.guardianName || "이름 미상";

  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover-elevate"
      data-testid={`dashboard-consultation-${consultation.id}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{name}</span>
          {consultation.studentGrade && (
            <span className="text-xs text-muted-foreground">{consultation.studentGrade}</span>
          )}
          {consultation.subject && (
            <Badge variant="outline" className="text-[10px]">
              {consultation.subject}
            </Badge>
          )}
        </div>
        {consultation.followUp && (
          <p className="truncate text-xs text-muted-foreground">{consultation.followUp}</p>
        )}
      </div>
      <div className="shrink-0 text-right">
        {consultation.phone && (
          <a
            href={`tel:${consultation.phone}`}
            className="flex items-center gap-1 text-sm hover:underline"
          >
            <Phone className="h-3 w-3" />
            {consultation.phone}
          </a>
        )}
        <div className="text-xs text-muted-foreground">{formatDate(consultation.createdAt)}</div>
      </div>
    </div>
  );
}
