import { useState, useEffect } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import NotFound from "@/pages/not-found";
import Teachers from "@/pages/Teachers";
import Classes from "@/pages/Classes";
import Students from "@/pages/Students";
import Payments from "@/pages/Payments";
import LessonLogs from "@/pages/LessonLogs";
import LoginForm from "@/components/LoginForm";
import SignupForm from "@/components/SignupForm";
import Dashboard from "@/components/Dashboard";
import SuperAdminDashboard from "@/components/SuperAdminDashboard";
import AcademySidebar from "@/components/AcademySidebar";
import ThemeToggle from "@/components/ThemeToggle";

type UserRole = 'owner' | 'teacher' | 'superadmin';

interface User {
  id: string;
  email: string;
  role: UserRole;
  name: string;
}

interface Tenant {
  id: string;
  name: string;
  accountNumber: string;
  status: 'pending' | 'active' | 'expired' | 'suspended';
}

function Router({ user, tenant }: { user: User | null; tenant: Tenant | null }) {
  if (!user) return null;
  
  return (
    <Switch>
      <Route path="/" component={() => <Dashboard userRole={user.role} tenant={tenant} />} />
      <Route path="/teachers" component={() => <Teachers userRole={user.role} />} />
      <Route path="/classes" component={() => <Classes userRole={user.role} />} />
      <Route path="/students" component={() => <Students userRole={user.role} />} />
      <Route path="/payments" component={() => <Payments userRole={user.role} />} />
      <Route path="/logs" component={() => <LessonLogs userRole={user.role} />} />
      <Route path="/overdues" component={() => <div className="p-6">미납 알림 페이지 (구현 예정)</div>} />
      {user.role === 'superadmin' && (
        <Route path="/superadmin" component={() => <SuperAdminDashboard />} />
      )}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSignupMode, setIsSignupMode] = useState(false);

  // Check if user is already logged in
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/me', {
          credentials: 'include'
        });
        
        if (response.ok) {
          const data = await response.json();
          setUser(data.user);
          setTenant(data.tenant);
        }
      } catch (error) {
        console.error('Auth check failed:', error);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, []);

  const handleLogin = async (credentials: { email: string; password: string; role: string }) => {
    try {
      const response = await fetch('/api/auth/signin', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(credentials),
      });

      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        setTenant(data.tenant);
      } else {
        const error = await response.json();
        throw new Error(error.error || '로그인에 실패했습니다.');
      }
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    }
  };

  const handleSignup = async (signupData: {
    email: string;
    password: string;
    name: string;
    academyName: string;
    ownerName: string;
    ownerPhone: string;
  }) => {
    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(signupData),
      });

      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        setTenant(data.tenant);
        setIsSignupMode(false);
      } else {
        const error = await response.json();
        throw new Error(error.error || '회원가입에 실패했습니다.');
      }
    } catch (error) {
      console.error('Signup failed:', error);
      throw error;
    }
  };

  const handleTeacherSignup = async (signupData: {
    academyEmail: string;
    email: string;
    password: string;
    name: string;
    subject: string;
    phone?: string;
  }) => {
    try {
      const response = await fetch('/api/auth/signup/teacher', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(signupData),
      });

      if (response.ok) {
        const data = await response.json();
        
        if (data.needsApproval) {
          // Teacher created but needs academy approval - show message and stay on signup
          alert(`${data.message}\n로그인하시려면 학원 승인을 기다려주세요.`);
          setIsSignupMode(false); // Go back to login
        } else {
          // Teacher is active, can login immediately
          setUser(data.user);
          setTenant(data.tenant);
          setIsSignupMode(false);
        }
      } else {
        const error = await response.json();
        throw new Error(error.error || '교사 가입에 실패했습니다.');
      }
    } catch (error) {
      console.error('Teacher signup failed:', error);
      throw error;
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/signout', {
        method: 'POST',
        credentials: 'include'
      });
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      setUser(null);
      setTenant(null);
    }
  };

  if (isLoading) {
    return (
      <QueryClientProvider client={queryClient}>
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <div className="text-lg font-semibold">시대영재 학원관리</div>
            <div className="text-sm text-muted-foreground mt-2">로딩 중...</div>
          </div>
        </div>
      </QueryClientProvider>
    );
  }

  const sidebarStyle = {
    "--sidebar-width": "20rem",
    "--sidebar-width-icon": "4rem",
  };

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {!user ? (
          isSignupMode ? (
            <SignupForm 
              onSignup={handleSignup}
              onTeacherSignup={handleTeacherSignup}
              onBackToLogin={() => setIsSignupMode(false)} 
            />
          ) : (
            <LoginForm 
              onLogin={handleLogin}
              onSignup={() => setIsSignupMode(true)}
            />
          )
        ) : (
          <SidebarProvider style={sidebarStyle as React.CSSProperties}>
            <div className="flex h-screen w-full">
              <AcademySidebar />
              <div className="flex flex-col flex-1 overflow-hidden">
                <header className="flex items-center justify-between p-4 border-b bg-background">
                  <div className="flex items-center gap-4">
                    <SidebarTrigger data-testid="button-sidebar-toggle" />
                    <div className="hidden sm:block">
                      <span className="text-sm text-muted-foreground">
                        안녕하세요, <span className="font-medium text-foreground">{user.name}</span>
                        {tenant && (
                          <span className="ml-2 text-xs bg-primary/10 text-primary px-2 py-1 rounded">
                            {tenant.name}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ThemeToggle />
                    <button 
                      onClick={handleLogout}
                      className="text-sm text-muted-foreground hover:text-foreground px-3 py-1 rounded-md hover:bg-muted transition-colors"
                      data-testid="button-logout"
                    >
                      로그아웃
                    </button>
                  </div>
                </header>
                <main className="flex-1 overflow-auto bg-muted/30">
                  <Router user={user} tenant={tenant} />
                </main>
              </div>
            </div>
          </SidebarProvider>
        )}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
