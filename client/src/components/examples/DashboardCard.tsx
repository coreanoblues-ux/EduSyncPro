import { CreditCard, Users, AlertTriangle, BookOpen } from "lucide-react";
import DashboardCard from '../DashboardCard';

export default function DashboardCardExample() {
  // todo: remove mock functionality
  const mockCards = [
    {
      title: "이번달 수납액",
      value: "₩2,450,000",
      description: "전월 대비",
      icon: CreditCard,
      trend: { value: "+12%", isPositive: true }
    },
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

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {mockCards.map((card, index) => (
        <DashboardCard key={index} {...card} />
      ))}
    </div>
  );
}