import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LucideIcon } from "lucide-react";

interface DashboardCardProps {
  title: string;
  value: string;
  description: string;
  icon: LucideIcon;
  trend?: {
    value: string;
    isPositive: boolean;
  };
  className?: string;
}

export default function DashboardCard({ 
  title, 
  value, 
  description, 
  icon: Icon, 
  trend,
  className = "" 
}: DashboardCardProps) {
  return (
    <Card className={className} data-testid={`dashboard-card-${title}`}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        <div className="flex items-center gap-2 text-xs">
          <p className="text-muted-foreground">{description}</p>
          {trend && (
            <span className={trend.isPositive ? "text-green-600" : "text-red-600"}>
              {trend.isPositive ? "↗" : "↘"} {trend.value}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}