import { useState } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import NotFound from "@/pages/not-found";
import LoginForm from "@/components/LoginForm";
import Dashboard from "@/components/Dashboard";
import AcademySidebar from "@/components/AcademySidebar";
import ThemeToggle from "@/components/ThemeToggle";

type UserRole = 'owner' | 'teacher' | 'superadmin';

interface User {
  email: string;
  role: UserRole;
  name: string;
}

function Router({ user }: { user: User | null }) {
  if (!user) return null;
  
  return (
    <Switch>
      <Route path="/" component={() => <Dashboard userRole={user.role} />} />
      <Route path="/teachers" component={() => <div className="p-6">교사 관리 페이지 (구현 예정)</div>} />
      <Route path="/classes" component={() => <div className="p-6">반 관리 페이지 (구현 예정)</div>} />
      <Route path="/students" component={() => <div className="p-6">학생 관리 페이지 (구현 예정)</div>} />
      <Route path="/payments" component={() => <div className="p-6">수납 관리 페이지 (구현 예정)</div>} />
      <Route path="/logs" component={() => <div className="p-6">반별 일지 페이지 (구현 예정)</div>} />
      <Route path="/overdues" component={() => <div className="p-6">미납 알림 페이지 (구현 예정)</div>} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  // todo: remove mock functionality
  const [user, setUser] = useState<User | null>(null);

  const handleLogin = (credentials: { email: string; password: string; role: string }) => {
    // Mock login - in real app this would make API call
    const mockUser: User = {
      email: credentials.email,
      role: credentials.role as UserRole,
      name: credentials.role === 'owner' ? '김원장님' : 
            credentials.role === 'teacher' ? '이선생님' : '관리자님'
    };
    setUser(mockUser);
  };

  const handleLogout = () => {
    setUser(null);
  };

  const sidebarStyle = {
    "--sidebar-width": "20rem",
    "--sidebar-width-icon": "4rem",
  };

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {!user ? (
          <LoginForm onLogin={handleLogin} />
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
                  <Router user={user} />
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
