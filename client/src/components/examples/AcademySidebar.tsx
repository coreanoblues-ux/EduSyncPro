import { SidebarProvider } from "@/components/ui/sidebar";
import AcademySidebar from '../AcademySidebar';

export default function AcademySidebarExample() {
  const style = {
    "--sidebar-width": "20rem",
    "--sidebar-width-icon": "4rem",
  };

  return (
    <SidebarProvider style={style as React.CSSProperties}>
      <div className="flex h-96 w-full">
        <AcademySidebar />
      </div>
    </SidebarProvider>
  );
}