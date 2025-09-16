import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserPlus, ArrowLeft } from "lucide-react";
import AcademyLogo from "./AcademyLogo";

interface SignupFormProps {
  onSignup: (signupData: {
    email: string;
    password: string;
    name: string;
    academyName: string;
    ownerName: string;
    ownerPhone: string;
  }) => Promise<void>;
  onBackToLogin: () => void;
}

export default function SignupForm({ onSignup, onBackToLogin }: SignupFormProps) {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    name: '',
    academyName: '',
    ownerName: '',
    ownerPhone: ''
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    
    try {
      await onSignup(formData);
    } catch (error: any) {
      setError(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleInputChange = (field: string, value: string) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md" data-testid="signup-form">
        <CardHeader className="space-y-4 text-center">
          <div className="flex justify-center">
            <AcademyLogo />
          </div>
          <div>
            <CardTitle className="text-2xl">학원 등록</CardTitle>
            <CardDescription>
              새로운 학원을 등록하고 관리 시스템을 시작하세요
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="text-sm text-destructive bg-destructive/10 p-3 rounded">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="academyName">학원명</Label>
              <Input
                id="academyName"
                type="text"
                placeholder="예: 시대영재학원"
                value={formData.academyName}
                onChange={(e) => handleInputChange('academyName', e.target.value)}
                required
                data-testid="input-academy-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ownerName">대표자명</Label>
              <Input
                id="ownerName"
                type="text"
                placeholder="대표자 성함"
                value={formData.ownerName}
                onChange={(e) => handleInputChange('ownerName', e.target.value)}
                required
                data-testid="input-owner-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ownerPhone">대표자 연락처</Label>
              <Input
                id="ownerPhone"
                type="tel"
                placeholder="010-1234-5678"
                value={formData.ownerPhone}
                onChange={(e) => handleInputChange('ownerPhone', e.target.value)}
                required
                data-testid="input-owner-phone"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">관리자명</Label>
              <Input
                id="name"
                type="text"
                placeholder="시스템 관리자 성함"
                value={formData.name}
                onChange={(e) => handleInputChange('name', e.target.value)}
                required
                data-testid="input-admin-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">관리자 이메일</Label>
              <Input
                id="email"
                type="email"
                placeholder="admin@academy.com"
                value={formData.email}
                onChange={(e) => handleInputChange('email', e.target.value)}
                required
                data-testid="input-admin-email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">비밀번호</Label>
              <Input
                id="password"
                type="password"
                placeholder="6자 이상 입력하세요"
                value={formData.password}
                onChange={(e) => handleInputChange('password', e.target.value)}
                required
                minLength={6}
                data-testid="input-admin-password"
              />
            </div>

            <Button 
              type="submit" 
              className="w-full" 
              disabled={isLoading}
              data-testid="button-submit-signup"
            >
              {isLoading ? (
                "등록 중..."
              ) : (
                <>
                  <UserPlus className="h-4 w-4 mr-2" />
                  학원 등록하기
                </>
              )}
            </Button>
          </form>
          
          <div className="mt-4 text-center">
            <Button 
              variant="ghost" 
              onClick={onBackToLogin}
              className="w-full"
              data-testid="button-back-to-login"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              로그인으로 돌아가기
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}