interface AcademyLogoProps {
  className?: string;
  onSecretClick?: () => void;
}

/**
 * PAGE ONE 로고.
 *
 * 비트맵 대신 SVG로 그려 두었다. 사이드바·로그인·회원가입에서 크기가 제각각인데
 * SVG는 어느 배율에서도 흐려지지 않고, 글자색이 다크 모드를 따라간다.
 *
 * 마크(펼친 책 + 오렌지 1)와 워드마크를 분리해 두어 사이드바가 접히면
 * 워드마크만 숨기고 마크를 파비콘처럼 남길 수 있다.
 */
export default function AcademyLogo({ className = "", onSecretClick }: AcademyLogoProps) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`} data-testid="academy-logo">
      {/* 마크: 펼친 책(표지 + 속장) 위에 오렌지 숫자 1 */}
      <svg
        viewBox="0 0 56 56"
        className="h-9 w-9 shrink-0"
        fill="none"
        aria-hidden="true"
      >
        {/* 표지 — 왼쪽이 앞으로 나온 원근이라 왼쪽 변이 더 길다 */}
        <path
          d="M9 7 L33 14 L33 45 L9 52 Z"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinejoin="round"
          className="text-foreground"
        />
        {/* 속장 — 표지 안쪽에 한 겹 더 */}
        <path
          d="M15 13 L29 17 L29 42 L15 46"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          className="text-foreground/70"
        />
        {/* 숫자 1 */}
        <path d="M35 17 L48 10 L48 53 L40 53 L40 22 L35 25 Z" className="fill-orange-500" />
      </svg>

      <span className="truncate text-[19px] font-black uppercase leading-none tracking-tight">
        <span className="text-foreground">Page </span>
        <span
          className="cursor-pointer text-orange-500 transition-opacity hover:opacity-70"
          onClick={onSecretClick}
          data-testid="secret-admin-trigger"
        >
          O
        </span>
        <span className="text-foreground">ne</span>
      </span>
    </div>
  );
}
