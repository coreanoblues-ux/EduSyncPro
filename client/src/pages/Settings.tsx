import { Settings as SettingsIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { AcademyProfileCard } from "@/components/AcademyProfileCard";

/**
 * 설정.
 *
 * 학원 전체에 걸치는 값들을 모아 두는 화면. 지금은 "학부모에게 보이는 학원
 * 정보"(이름·전화번호) 하나지만, 앞으로 학원 단위 설정이 생기면 여기에 쌓는다.
 *
 * 카드 자체는 @/components/AcademyProfileCard 한 파일이고, 레벨테스트 기록
 * 화면에도 같은 컴포넌트가 붙어 있다 (값이 실제로 쓰이는 자리 옆에도 둔다).
 *
 * 수정은 원장만 할 수 있다 — 서버(PATCH /api/academy-profile)도 owner 만
 * 받도록 막혀 있으므로, 여기서 강사에게 입력칸을 보여 줘 봤자 저장이 안 된다.
 * 괜히 열어 두고 저장 실패를 보게 하느니 처음부터 안내문을 보여 준다.
 */
export default function Settings({
  userRole,
}: {
  userRole: "owner" | "teacher" | "superadmin";
}) {
  return (
    <div className="p-4 sm:p-6 space-y-4" data-testid="page-settings">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <SettingsIcon className="w-6 h-6 text-primary" />
          설정
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          학원 전체에 적용되는 정보를 관리합니다.
        </p>
      </div>

      {userRole === "owner" ? (
        <AcademyProfileCard />
      ) : (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            학원 이름과 전화번호는 원장 계정만 바꿀 수 있습니다.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
