import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
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

  // todo: remove mock functionality
  const getDashboardData = () => {
    const baseData = [
      {
        title: "전체 학생 수",
        value: "87명",
        description: "재원 학생",
        icon: Users,
        trend: { value: "+3명", isPositive: true }
      },
      {
        title: "미납자",
        value: "5명",
        description: "기준일 경과",
        icon: AlertTriangle,
        trend: { value: "-2명", isPositive: true }
      },
      {
        title: "운영 반",
        value: "12개",
        description: "활성화된 반",
        icon: BookOpen
      }
    ];

    // 학원장과 슈퍼관리자만 수납액 정보 볼 수 있음
    if (userRole === 'owner' || userRole === 'superadmin') {
      return [
        {
          title: "이번달 수납액",
          value: "₩2,450,000",
          description: "전월 대비",
          icon: CreditCard,
          trend: { value: "+12%", isPositive: true }
        },
        ...baseData
      ];
    }

    return baseData;
  };

  const mockDashboardData = getDashboardData();

  const mockStudents = [
    {
      id: "1",
      name: "김영수",
      grade: "중2",
      school: "서울중학교",
      className: "영어 중급반",
      dueDay: 8,
      tuition: 150000,
      paymentStatus: 'paid' as const,
      parentPhone: "010-1234-5678"
    },
    {
      id: "2",
      name: "이민지",
      grade: "고1",
      school: "강남고등학교",
      className: "수학 고급반",
      dueDay: 15,
      tuition: 180000,
      paymentStatus: 'overdue' as const,
      parentPhone: "010-9876-5432"
    },
    {
      id: "3",
      name: "박지훈",
      grade: "중3",
      school: "중앙중학교",
      className: "영어 초급반",
      dueDay: 5,
      tuition: 120000,
      paymentStatus: 'pending' as const,
      parentPhone: "010-5555-1234"
    }
  ];

  const mockClasses = [
    { id: "1", name: "영어 초급반" },
    { id: "2", name: "영어 중급반" },
    { id: "3", name: "수학 고급반" },
    { id: "4", name: "과학 실험반" }
  ];

  const filteredStudents = mockStudents.filter(student =>
    student.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    student.className.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const overdueCount = mockStudents.filter(s => s.paymentStatus === 'overdue').length;

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
        {mockDashboardData.map((card, index) => (
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