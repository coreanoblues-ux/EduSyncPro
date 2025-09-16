interface AcademyLogoProps {
  className?: string;
}

export default function AcademyLogo({ className = "" }: AcademyLogoProps) {
  return (
    <div className={`flex items-center gap-3 ${className}`} data-testid="academy-logo">
      <img 
        src="/attached_assets/학원로고_1757999123307.jpg" 
        alt="시대영재 학원관리" 
        className="h-8 w-auto object-contain"
      />
      <span className="text-xs text-muted-foreground ml-1">학원관리</span>
    </div>
  );
}