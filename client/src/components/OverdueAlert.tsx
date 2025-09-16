import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertTriangle, X } from "lucide-react";
import { useState } from "react";

interface OverdueAlertProps {
  overdueCount: number;
  onViewOverdues: () => void;
}

export default function OverdueAlert({ overdueCount, onViewOverdues }: OverdueAlertProps) {
  const [isVisible, setIsVisible] = useState(overdueCount > 0);

  if (!isVisible || overdueCount === 0) return null;

  return (
    <Alert className="mb-4 border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-950" data-testid="overdue-alert">
      <AlertTriangle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
      <AlertDescription className="flex items-center justify-between">
        <span className="text-orange-800 dark:text-orange-200">
          <strong>경고:</strong> {overdueCount}명의 미납자가 발생했습니다.
        </span>
        <div className="flex gap-2">
          <Button 
            size="sm" 
            variant="outline"
            onClick={onViewOverdues}
            data-testid="button-view-overdues"
          >
            미납자 보기
          </Button>
          <Button 
            size="sm" 
            variant="ghost"
            onClick={() => setIsVisible(false)}
            data-testid="button-close-alert"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}