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
}

export default function Dashboard({ userRole }: DashboardProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [showLogForm, setShowLogForm] = useState(false);
  const [, setLocation] = useLocation();

  // Fetch students data
  const { data: students = [], isLoading: studentsLoading } = useQuery({
    queryKey: ['/api/students'],
  });

  // Fetch teachers data
  const { data: teachers = [] } = useQuery({
    queryKey: ['/api/teachers'],
  });

  // Fetch classes data
  const { data: classes = [] } = useQuery({
    queryKey: ['/api/classes'],
  });

  // todo: remove mock functionality
  const getDashboardData = () => {
    const baseData = [
      {
        title: "전체 학생 수",
        value: `${students.length}명`,
        description: "재원 학생",
        icon: Users,
        trend: students.length > 0 ? { value: "+3명", isPositive: true } : undefined
      },
      {
        title: "미납자",
        value: `${overdueCount}명`,
        description: "기준일 경과",
        icon: AlertTriangle,
        trend: overdueCount === 0 ? { value: "없음", isPositive: true } : undefined
      },
      {
        title: "운영 반",
        value: `${classes.length}개`,
        description: "활성화된 반",
        icon: BookOpen
      }
    ];

    // 학원장과 슈퍼관리자만 수납액 정보 볼 수 있음
    if (userRole === 'owner' || userRole === 'superadmin') {
      return [
        {
          title: "이번달 수납액",
          value: "₩0", // todo: calculate from payments
          description: "전월 대비",
          icon: CreditCard,
          trend: { value: "준비중", isPositive: true }
        },
        ...baseData
      ];
    }

    return baseData;
  };

  // todo: remove mock functionality - Replace with real data when payment system is implemented
  const mockStudentData = students.map((student: any) => ({
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
          <Button data-testid="button-add-student">
            <Plus className="h-4 w-4 mr-2" />
            학생 추가
          </Button>
          <Button 
            variant="outline"
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
        
        {filteredStudents.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            검색 결과가 없습니다.
          </div>
        )}
      </div>
    </div>
  );
}