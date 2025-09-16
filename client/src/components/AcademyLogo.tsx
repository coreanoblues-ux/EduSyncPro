interface AcademyLogoProps {
  className?: string;
  onSecretClick?: () => void;
}

export default function AcademyLogo({ className = "", onSecretClick }: AcademyLogoProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`} data-testid="academy-logo">
      {/* Orange accent bars inspired by the original logo */}
      <div className="flex flex-col gap-0.5">
        <div className="w-1 h-4 bg-orange-500 rounded-sm"></div>
        <div className="w-1 h-3 bg-orange-400 rounded-sm"></div>
        <div className="w-1 h-2 bg-orange-300 rounded-sm"></div>
      </div>
      
      <div className="flex flex-col leading-tight">
        <div className="flex items-baseline gap-1">
          <span className="text-lg font-black text-gray-900 dark:text-white tracking-tight">
            시대영재
          </span>
          <span className="text-xs font-medium text-muted-foreground">
            학원관리
          </span>
        </div>
        <span className="text-xs font-medium text-orange-600 dark:text-orange-400 tracking-wider uppercase">
          s<span 
            className="cursor-pointer hover:text-orange-500 transition-colors"
            onClick={onSecretClick}
            data-testid="secret-admin-trigger"
          >y</span>stem
        </span>
      </div>
    </div>
  );
}