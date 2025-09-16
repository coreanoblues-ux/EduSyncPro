import logoImg from "@assets/generated_images/Korean_academy_management_logo_b58ab1ff.png";

interface AcademyLogoProps {
  className?: string;
}

export default function AcademyLogo({ className = "" }: AcademyLogoProps) {
  return (
    <div className={`flex items-center gap-3 ${className}`} data-testid="academy-logo">
      <img 
        src={logoImg} 
        alt="시대영재 학원관리" 
        className="h-8 w-6 object-contain"
      />
      <div className="flex flex-col">
        <span className="text-sm font-bold text-primary">시대영재</span>
        <span className="text-xs text-muted-foreground">학원관리</span>
      </div>
    </div>
  );
}