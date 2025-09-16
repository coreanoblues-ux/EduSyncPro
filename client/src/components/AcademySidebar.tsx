import { Home, Users, BookOpen, GraduationCap, CreditCard, Calendar, Bell } from "lucide-react";
import { Link, useLocation } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import AcademyLogo from "./AcademyLogo";

const menuItems = [
  { title: "대시보드", url: "/", icon: Home },
  { title: "교사 관리", url: "/teachers", icon: GraduationCap },
  { title: "반 관리", url: "/classes", icon: BookOpen },
  { title: "학생 관리", url: "/students", icon: Users },
  { title: "수납 관리", url: "/payments", icon: CreditCard },
  { title: "반별 일지", url: "/logs", icon: Calendar },
  { title: "미납 알림", url: "/overdues", icon: Bell },
];

export default function AcademySidebar() {
  const [location] = useLocation();

  return (
    <Sidebar data-testid="academy-sidebar">
      <SidebarContent>
        <div className="p-4 border-b">
          <AcademyLogo />
        </div>
        
        <SidebarGroup>
          <SidebarGroupLabel>학원 관리</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {menuItems.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton 
                    asChild
                    data-active={location === item.url}
                    data-testid={`nav-${item.title}`}
                  >
                    <Link href={item.url}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}