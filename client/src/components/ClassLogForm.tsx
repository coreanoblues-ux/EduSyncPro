import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, Save } from "lucide-react";

interface ClassLogFormProps {
  onSubmit: (log: {
    classId: string;
    date: string;
    progress: string;
    homework: string;
    notes: string;
  }) => void;
  classes: { id: string; name: string }[];
}

export default function ClassLogForm({ onSubmit, classes }: ClassLogFormProps) {
  const [formData, setFormData] = useState({
    classId: '',
    date: new Date().toISOString().split('T')[0],
    progress: '',
    homework: '',
    notes: ''
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
    // Reset form
    setFormData({
      classId: '',
      date: new Date().toISOString().split('T')[0],
      progress: '',
      homework: '',
      notes: ''
    });
  };

  return (
    <Card className="w-full max-w-2xl" data-testid="class-log-form">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Calendar className="h-5 w-5" />
          반별 일지 작성
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="class-select">반 선택</Label>
              <Select 
                value={formData.classId} 
                onValueChange={(value) => setFormData({...formData, classId: value})}
              >
                <SelectTrigger data-testid="select-class">
                  <SelectValue placeholder="반을 선택하세요" />
                </SelectTrigger>
                <SelectContent>
                  {classes.map((cls) => (
                    <SelectItem key={cls.id} value={cls.id}>
                      {cls.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="date">날짜</Label>
              <Input
                id="date"
                type="date"
                value={formData.date}
                onChange={(e) => setFormData({...formData, date: e.target.value})}
                data-testid="input-date"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="progress">진도</Label>
            <Input
              id="progress"
              placeholder="오늘 진행한 수업 내용을 입력하세요"
              value={formData.progress}
              onChange={(e) => setFormData({...formData, progress: e.target.value})}
              data-testid="input-progress"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="homework">숙제</Label>
            <Input
              id="homework"
              placeholder="다음 시간까지의 숙제를 입력하세요"
              value={formData.homework}
              onChange={(e) => setFormData({...formData, homework: e.target.value})}
              data-testid="input-homework"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="notes">특이사항</Label>
            <Textarea
              id="notes"
              placeholder="학생별 특이사항이나 기타 메모를 입력하세요"
              value={formData.notes}
              onChange={(e) => setFormData({...formData, notes: e.target.value})}
              className="min-h-20"
              data-testid="textarea-notes"
            />
          </div>

          <Button type="submit" className="w-full" data-testid="button-save-log">
            <Save className="h-4 w-4 mr-2" />
            일지 저장
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}