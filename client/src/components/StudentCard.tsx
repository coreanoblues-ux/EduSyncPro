import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { User, Edit, Phone, CreditCard } from "lucide-react";

interface StudentCardProps {
  student: {
    id: string;
    name: string;
    grade: string;
    school: string;
    className: string;
    dueDay: number;
    tuition: number;
    paymentStatus: 'paid' | 'overdue' | 'pending';
    parentPhone: string;
  };
  onEdit: (id: string) => void;
  onPayment: (id: string, month: 'current' | 'next') => void;
}

export default function StudentCard({ student, onEdit, onPayment }: StudentCardProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'paid': return 'bg-green-100 text-green-800';
      case 'overdue': return 'bg-red-100 text-red-800';
      case 'pending': return 'bg-yellow-100 text-yellow-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'paid': return '납부완료';
      case 'overdue': return '미납';
      case 'pending': return '대기';
      default: return '확인필요';
    }
  };

  return (
    <Card className="hover-elevate" data-testid={`student-card-${student.id}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base font-medium flex items-center gap-2">
          <User className="h-4 w-4" />
          {student.name}
        </CardTitle>
        <Badge className={getStatusColor(student.paymentStatus)}>
          {getStatusText(student.paymentStatus)}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-muted-foreground">학년:</span>
            <span className="ml-1 font-medium">{student.grade}</span>
          </div>
          <div>
            <span className="text-muted-foreground">학교:</span>
            <span className="ml-1 font-medium">{student.school}</span>
          </div>
          <div>
            <span className="text-muted-foreground">반:</span>
            <span className="ml-1 font-medium">{student.className}</span>
          </div>
          <div>
            <span className="text-muted-foreground">기준일:</span>
            <span className="ml-1 font-medium">{student.dueDay}일</span>
          </div>
        </div>
        
        <div className="text-sm">
          <span className="text-muted-foreground">수강료:</span>
          <span className="ml-1 font-bold text-primary">
            ₩{student.tuition.toLocaleString('ko-KR')}
          </span>
        </div>

        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Phone className="h-3 w-3" />
          {student.parentPhone}
        </div>

        <div className="flex gap-2 pt-2">
          <Button 
            size="sm" 
            variant="outline" 
            onClick={() => onEdit(student.id)}
            data-testid={`button-edit-${student.id}`}
          >
            <Edit className="h-3 w-3 mr-1" />
            수정
          </Button>
          <Button 
            size="sm" 
            onClick={() => onPayment(student.id, 'current')}
            data-testid={`button-pay-current-${student.id}`}
          >
            <CreditCard className="h-3 w-3 mr-1" />
            이번달 납부
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}