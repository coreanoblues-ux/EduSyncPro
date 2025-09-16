import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { UserPlus, ArrowLeft, GraduationCap, Building } from "lucide-react";
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
  onTeacherSignup: (signupData: {
    academyEmail: string;
    email: string;
    password: string;
    name: string;
    subject: string;
    phone?: string;
  }) => Promise<void>;
  onBackToLogin: () => void;
}

export default function SignupForm({ onSignup, onTeacherSignup, onBackToLogin }: SignupFormProps) {
  const [signupType, setSignupType] = useState<'academy' | 'teacher'>('academy');
  
  // Academy signup form data
  const [academyFormData, setAcademyFormData] = useState({
    email: '',
    password: '',
    name: '',
    academyName: '',
    ownerName: '',
    ownerPhone: ''
  });

  // Teacher signup form data
  const [teacherFormData, setTeacherFormData] = useState({
    academyEmail: '',
    email: '',
    password: '',
    name: '',
    subject: '',
    phone: ''
  });

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    
    try {
      if (signupType === 'academy') {
        await onSignup(academyFormData);
      } else {
        await onTeacherSignup(teacherFormData);
      }
    } catch (error: any) {
      setError(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAcademyInputChange = (field: string, value: string) => {
    setAcademyFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleTeacherInputChange = (field: string, value: string) => {
    setTeacherFormData(prev => ({ ...prev, [field]: value }));
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md" data-testid="signup-form">
        <CardHeader className="space-y-4 text-center">
          <div className="flex justify-center">
            <AcademyLogo />
          </div>
          <div>
            <CardTitle className="text-2xl">
              {signupType === 'academy' ? '학원 등록' : '교사 가입'}
            </CardTitle>
            <CardDescription>
              {signupType === 'academy' 
                ? '새로운 학원을 등록하고 관리 시스템을 시작하세요'
                : '기존 학원에 교사로 가입하세요'
              }
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

            {/* Signup Type Selection */}
            <div className="space-y-3">
              <Label>가입 유형</Label>
              <RadioGroup
                value={signupType}
                onValueChange={(value: 'academy' | 'teacher') => setSignupType(value)}
                className="flex flex-col space-y-2"
              >
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="academy" id="academy" />
                  <Label htmlFor="academy" className="flex items-center cursor-pointer">
                    <Building className="w-4 h-4 mr-2" />
                    학원장 (새 학원 등록)
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <RadioGroupItem value="teacher" id="teacher" />
                  <Label htmlFor="teacher" className="flex items-center cursor-pointer">
                    <GraduationCap className="w-4 h-4 mr-2" />
                    교사 (기존 학원 가입)
                  </Label>
                </div>
              </RadioGroup>
            </div>

            {/* Academy Signup Form */}
            {signupType === 'academy' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="academyName">학원명</Label>
                  <Input
                    id="academyName"
                    type="text"
                    placeholder="예: 시대영재학원"
                    value={academyFormData.academyName}
                    onChange={(e) => handleAcademyInputChange('academyName', e.target.value)}
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
                    value={academyFormData.ownerName}
                    onChange={(e) => handleAcademyInputChange('ownerName', e.target.value)}
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
                    value={academyFormData.ownerPhone}
                    onChange={(e) => handleAcademyInputChange('ownerPhone', e.target.value)}
                    required
                    data-testid="input-owner-phone"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="adminName">관리자명</Label>
                  <Input
                    id="adminName"
                    type="text"
                    placeholder="시스템 관리자 성함"
                    value={academyFormData.name}
                    onChange={(e) => handleAcademyInputChange('name', e.target.value)}
                    required
                    data-testid="input-admin-name"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="adminEmail">관리자 이메일</Label>
                  <Input
                    id="adminEmail"
                    type="email"
                    placeholder="admin@academy.com"
                    value={academyFormData.email}
                    onChange={(e) => handleAcademyInputChange('email', e.target.value)}
                    required
                    data-testid="input-admin-email"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="adminPassword">비밀번호</Label>
                  <Input
                    id="adminPassword"
                    type="password"
                    placeholder="6자 이상 입력하세요"
                    value={academyFormData.password}
                    onChange={(e) => handleAcademyInputChange('password', e.target.value)}
                    required
                    minLength={6}
                    data-testid="input-admin-password"
                  />
                </div>
              </>
            )}

            {/* Teacher Signup Form */}
            {signupType === 'teacher' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="academyEmail">학원장 이메일</Label>
                  <Input
                    id="academyEmail"
                    type="email"
                    placeholder="academy_owner@academy.com"
                    value={teacherFormData.academyEmail}
                    onChange={(e) => handleTeacherInputChange('academyEmail', e.target.value)}
                    required
                    data-testid="input-academy-email"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="teacherName">교사 이름</Label>
                  <Input
                    id="teacherName"
                    type="text"
                    placeholder="교사 성함"
                    value={teacherFormData.name}
                    onChange={(e) => handleTeacherInputChange('name', e.target.value)}
                    required
                    data-testid="input-teacher-name"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="teacherEmail">교사 이메일</Label>
                  <Input
                    id="teacherEmail"
                    type="email"
                    placeholder="teacher@academy.com"
                    value={teacherFormData.email}
                    onChange={(e) => handleTeacherInputChange('email', e.target.value)}
                    required
                    data-testid="input-teacher-email"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="teacherPassword">비밀번호</Label>
                  <Input
                    id="teacherPassword"
                    type="password"
                    placeholder="6자 이상 입력하세요"
                    value={teacherFormData.password}
                    onChange={(e) => handleTeacherInputChange('password', e.target.value)}
                    required
                    minLength={6}
                    data-testid="input-teacher-password"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="subject">담당 과목</Label>
                  <Input
                    id="subject"
                    type="text"
                    placeholder="예: 수학, 영어, 국어"
                    value={teacherFormData.subject}
                    onChange={(e) => handleTeacherInputChange('subject', e.target.value)}
                    required
                    data-testid="input-subject"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="teacherPhone">연락처 (선택)</Label>
                  <Input
                    id="teacherPhone"
                    type="tel"
                    placeholder="010-1234-5678"
                    value={teacherFormData.phone}
                    onChange={(e) => handleTeacherInputChange('phone', e.target.value)}
                    data-testid="input-teacher-phone"
                  />
                </div>
              </>
            )}

            <Button 
              type="submit" 
              className="w-full" 
              disabled={isLoading}
              data-testid="button-submit-signup"
            >
              {isLoading ? (
                signupType === 'academy' ? "학원 등록 중..." : "교사 가입 중..."
              ) : (
                <>
                  <UserPlus className="h-4 w-4 mr-2" />
                  {signupType === 'academy' ? '학원 등록하기' : '교사 가입하기'}
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