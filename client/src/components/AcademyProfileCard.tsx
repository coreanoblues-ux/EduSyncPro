import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export const ACADEMY_PROFILE_QUERY_KEY = ["/api/academy-profile"];

type AcademyProfile = {
  academyName: string;
  sharePhone: string | null;
  fallbackPhone: string | null;
};

/**
 * 학부모 눈에 닿는 학원 정보 두 칸 — 학원 이름과 결과지 전화번호.
 *
 * ── 이름을 왜 화면에서 고치게 하는가 ──
 *   학원 이름은 가입할 때 한 번 적고 나면 고칠 자리가 없었다. 그런데 그 값이
 *   화면 오른쪽 위 배지, 카카오톡 메시지 첫 줄("안녕하세요, ○○입니다"),
 *   결과지 맨 위 워드마크와 맨 아래 서명 — 넷 모두에 쓰인다. 상호가 바뀌면
 *   옛 이름이 학부모 전원에게 계속 나가는데 원장이 손쓸 방법이 없었다.
 *   코드에 박힌 글자가 아니라 **학원 계정에 저장된 값**이라, 고치는 즉시
 *   네 곳이 한꺼번에 바뀐다.
 *
 * ── 전화번호 칸이 왜 따로 필요한가 ──
 *   가입할 때 적은 연락처는 **대표자 개인 번호**(보통 원장 휴대폰)다. 그 번호가
 *   결과지에 찍히면 개인 번호가 학부모 전원에게 나간다. 학원 유선번호와는
 *   다른 칸이어야 한다.
 *
 * ── 왜 두 군데(설정 + 레벨테스트 기록)에 두는가 ──
 *   처음에는 레벨테스트 화면에만 있었다. 두 값이 실제로 쓰이는 곳(학부모
 *   결과지 링크) 옆에 둬야 존재를 알 수 있기 때문이다. 그런데 "학원 이름"은
 *   레벨테스트만의 설정이 아니라 학원 전체의 설정이라, 찾는 사람은 "설정"
 *   메뉴를 먼저 뒤진다. 그래서 같은 컴포넌트를 설정 화면에도 붙였다.
 *   **파일은 이 한 곳**이고 두 화면은 가져다 쓸 뿐이라, 고칠 때 한 쪽만
 *   고쳐지는 사고는 없다.
 *
 * ── 왜 원장에게만 보이는가 ──
 *   학부모 전원에게 나가는 값이라 서버도 owner 만 고치게 막아 뒀다.
 */
export function AcademyProfileCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [phoneDraft, setPhoneDraft] = useState<string | null>(null);

  const { data } = useQuery<AcademyProfile>({ queryKey: ACADEMY_PROFILE_QUERY_KEY });

  // 서버 값이 도착하면 입력칸에 넣는다. 원장이 타이핑을 시작한 뒤
  // (draft !== null) 에는 덮어쓰지 않는다 — 입력 중에 글자가 사라지면 안 된다.
  useEffect(() => {
    if (data && nameDraft === null) setNameDraft(data.academyName ?? "");
    if (data && phoneDraft === null) setPhoneDraft(data.sharePhone ?? "");
  }, [data, nameDraft, phoneDraft]);

  const save = useMutation({
    mutationFn: async (patch: { name: string; phone: string }) =>
      (await apiRequest("PATCH", "/api/academy-profile", patch)).json(),
    onSuccess: (res: { message?: string }) => {
      qc.invalidateQueries({ queryKey: ACADEMY_PROFILE_QUERY_KEY });
      // 화면 오른쪽 위 배지는 /api/auth/me 가 준 학원 이름을 보여 준다.
      // 같이 새로 받아야 저장한 이름이 바로 반영된다 (App.tsx 의 배지가
      // 이 queryKey 를 구독하고 있다).
      qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: res?.message ?? "저장했습니다." });
    },
    onError: (e: Error) =>
      toast({ title: "저장 실패", description: e.message, variant: "destructive" }),
  });

  const name = nameDraft ?? "";
  const phone = phoneDraft ?? "";
  const unchanged = data
    ? name.trim() === (data.academyName ?? "") && phone.trim() === (data.sharePhone ?? "")
    : true;

  return (
    <Card data-testid="card-academy-profile">
      <CardContent className="py-4">
        <div className="text-sm font-medium flex items-center gap-2">
          <Building2 className="w-4 h-4 text-primary" />
          학부모에게 보이는 학원 정보
        </div>

        <div className="flex flex-wrap items-end gap-3 mt-3">
          <div className="min-w-[220px]">
            <Label htmlFor="academy-name" className="text-xs text-muted-foreground">
              학원 이름
            </Label>
            <Input
              id="academy-name"
              value={name}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="예: 페이지원영어학원"
              className="mt-1 max-w-xs"
              data-testid="input-academy-name"
            />
          </div>
          <div className="min-w-[220px]">
            <Label htmlFor="academy-phone" className="text-xs text-muted-foreground">
              학원 전화번호
            </Label>
            <Input
              id="academy-phone"
              value={phone}
              onChange={(e) => setPhoneDraft(e.target.value)}
              placeholder="예: 062-456-0990"
              className="mt-1 max-w-xs"
              data-testid="input-academy-phone"
            />
          </div>
          <Button
            onClick={() => save.mutate({ name: name.trim(), phone: phone.trim() })}
            disabled={save.isPending || unchanged || name.trim() === ""}
            data-testid="button-save-academy-profile"
          >
            저장
          </Button>
        </div>

        <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
          학원 이름은 <strong>카카오톡 메시지 첫 줄</strong>과 <strong>결과지 맨 위·맨 아래</strong>,
          그리고 화면 오른쪽 위 배지에 함께 쓰입니다.
          <br />
          전화번호는 학부모가 결과지 맨 아래 <strong>학원에 전화하기</strong> 버튼을 누를 때 걸리는
          번호입니다.
          {data?.fallbackPhone && (
            <>
              {" "}
              비워 두면 가입할 때 적은 번호({data.fallbackPhone})가 대신 나갑니다. 그 번호가 원장님
              개인 휴대폰이면 학원 번호를 적어 주세요.
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
