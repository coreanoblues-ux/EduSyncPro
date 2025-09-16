import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Plus, Search, Settings } from "lucide-react";
import { Input } from "@/components/ui/input";
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

export default function Dashboard({ userRole, tenant }: DashboardProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [showLogForm, setShowLogForm] = useState(false);
  const [, setLocation] = useLocation();

  // 승인되지 않은 테넌트는 데이터를 불러오지 않음
  const isApproved = !tenant || tenant.status === 'active' || userRole === 'superadmin';
  
  // Fetch students data
  const { data: students = [], isLoading: studentsLoading } = useQuery({
    queryKey: ['/api/students'],
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

  // todo: remove mock functionality
  const getDashboardData = () => {
    const studentsArray = Array.isArray(students) ? students : [];
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

    // 학원장과 슈퍼관리자만 수납액과 전체 학생 수 볼 수 있음
    if (userRole === 'owner' || userRole === 'superadmin') {
      return [
        {
          title: "이번달 수납액",
          value: "₩0", // todo: calculate from payments
          description: "전월 대비",
          icon: CreditCard,
          trend: { value: "준비중", isPositive: true }
        },
        {
          title: "전체 학생 수",
          value: `${studentsArray.length}명`,
          description: "재원 학생",
          icon: Users,
          trend: studentsArray.length > 0 ? { value: "+3명", isPositive: true } : undefined
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

  // todo: remove mock functionality - Replace with real data when payment system is implemented
  const studentsArray = Array.isArray(students) ? students : [];
  const mockStudentData = studentsArray.map((student: any) => ({
    id: student.id,
    name: student.name,
    grade: student.grade || "미설정",
    school: student.school || "미설정",
    className: "반 미배정", // Will be updated when enrollment system is connected
    dueDay: 8, // Default value
    tuition: 150000, // Default value
    paymentStatus: 'pending' as const,
    parentPhone: student.parentPhone || "미설정"
  }));

  // Mock classes for now
  const mockClasses = Array.isArray(classes) ? classes : [];

  const filteredStudents = mockStudentData.filter((student: any) =>
    student.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    student.className.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const overdueCount = 0; // Will be calculated when payment system is implemented

  const handleStudentEdit = (id: string) => {
    console.log(`Edit student ${id}`);
  };

  const handlePayment = (id: string, month: 'current' | 'next') => {
    console.log(`Payment for student ${id} - ${month} month`);
  };

  const handleViewOverdues = () => {
    console.log('View overdues clicked');
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
    </div>
  );
}