import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LogIn, Eye, EyeOff, UserPlus, Shield } from "lucide-react";
import AcademyLogo from "./AcademyLogo";

interface LoginFormProps {
  onLogin: (credentials: { email: string; password: string; role: string }) => void;
  onSignup?: () => void;
  onAdminLogin?: (password: string) => Promise<void>;
}

export default function LoginForm({ onLogin, onSignup, onAdminLogin }: LoginFormProps) {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    role: ''
  });
  const [showSuperAdmin, setShowSuperAdmin] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [adminLoginLoading, setAdminLoginLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    
    try {
      await onLogin(formData);
    } catch (error) {
      console.error('Login failed:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAdminLogin = async () => {
    if (!adminPassword) {
      alert("관리자 비밀번호를 입력하세요.");
      return;
    }

    setAdminLoginLoading(true);
    try {
      if (onAdminLogin) {
        await onAdminLogin(adminPassword);
      }
      setShowAdminModal(false);
      setAdminPassword("");
    } catch (error: any) {
      console.error('Admin login failed:', error);
      alert(error.message || "관리자 로그인에 실패했습니다.");
      setAdminPassword("");
    } finally {
      setAdminLoginLoading(false);
    }
  };

  const handleSecretClick = () => {
    setShowAdminModal(true);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md" data-testid="login-form">
        <CardHeader className="space-y-4 text-center">
          <div className="flex justify-center">
            <AcademyLogo onSecretClick={handleSecretClick} />
          </div>
          <div>
            <CardTitle className="text-2xl">로그인</CardTitle>
            <CardDescription>
              학원 관리 시스템에 접속하세요
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">이메일</Label>
              <Input
                id="email"
                type="email"
                placeholder="your@email.com"
                value={formData.email}
                onChange={(e) => setFormData({...formData, email: e.target.value})}
                required
                data-testid="input-email"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password">비밀번호</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="비밀번호를 입력하세요"
                  value={formData.password}
                  onChange={(e) => setFormData({...formData, password: e.target.value})}
                  required
                  data-testid="input-password"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                  onClick={() => setShowPassword(!showPassword)}
                  data-testid="button-toggle-password"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">역할</Label>
              <Select 
                value={formData.role} 
                onValueChange={(value) => {
                  setFormData({
                    ...formData, 
                    role: value,
                    email: value === 'superadmin' ? 'admin@system.local' : formData.email,
                    password: value === 'superadmin' ? 'wchung00' : formData.password
                  });
                }}
              >
                <SelectTrigger data-testid="select-role">
                  <SelectValue placeholder="역할을 선택하세요" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="owner">학원장</SelectItem>
                  <SelectItem value="teacher">교사</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button 
              type="submit" 
              className="w-full" 
              disabled={isLoading}
              data-testid="button-login"
            >
              {isLoading ? (
                "로그인 중..."
              ) : (
                <>
                  <LogIn className="h-4 w-4 mr-2" />
                  로그인
                </>
              )}
            </Button>
          </form>
          
          {onSignup && (
            <div className="mt-4 text-center">
              <Button 
                variant="ghost" 
                onClick={onSignup}
                className="w-full"
                data-testid="button-signup"
              >
                <UserPlus className="h-4 w-4 mr-2" />
                회원가입
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 관리자 로그인 모달 */}
      <Dialog open={showAdminModal} onOpenChange={setShowAdminModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-orange-500" />
              시스템 관리자 인증
            </DialogTitle>
            <DialogDescription>
              관리자 비밀번호를 입력하세요
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="adminPassword">관리자 비밀번호</Label>
              <Input
                id="adminPassword"
                type="password"
                placeholder="관리자 비밀번호 입력"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAdminLogin()}
                data-testid="input-admin-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowAdminModal(false);
                setAdminPassword("");
              }}
            >
              취소
            </Button>
            <Button 
              onClick={handleAdminLogin}
              disabled={adminLoginLoading || !adminPassword}
              data-testid="button-admin-login"
            >
              {adminLoginLoading ? "인증 중..." : "관리자 로그인"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}