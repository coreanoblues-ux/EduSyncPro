import logoLight from "@/assets/pageone-logo.png";
import logoDark from "@/assets/pageone-logo-dark.png";

interface AcademyLogoProps {
  className?: string;
  onSecretClick?: () => void;
}

/**
 * PAGE ONE 로고.
 *
 * 원본 아트워크를 그대로 쓴다. 예전엔 SVG로 흉내 냈는데 자간·마크 비율이
 * 원본과 미묘하게 달라 브랜드 자산과 어긋났다. 배경이 투명한 PNG라
 * 사이드바/로그인 카드 어디에 얹어도 흰 상자가 생기지 않는다.
 *
 * 다크 모드용 파일을 따로 둔다. CSS 필터(invert)로 처리하면 오렌지까지
 * 파랗게 뒤집히므로, 무채색 워드마크만 밝게 바꾼 사본을 미리 만들어 두었다.
 */
export default function AcademyLogo({ className = "", onSecretClick }: AcademyLogoProps) {
  return (
    <div
      className={`flex flex-col items-center gap-1.5 ${className}`}
      data-testid="academy-logo"
    >
      <img
        src={logoLight}
        alt="PAGE ONE"
        className="h-8 w-auto select-none dark:hidden"
        draggable={false}
      />
      <img
        src={logoDark}
        alt=""
        aria-hidden="true"
        className="hidden h-8 w-auto select-none dark:block"
        draggable={false}
      />
      <span
        className="cursor-default text-[10px] font-medium leading-none tracking-[0.18em] text-muted-foreground"
        onClick={onSecretClick}
        data-testid="secret-admin-trigger"
      >
        학원관리시스템
      </span>
    </div>
  );
}
