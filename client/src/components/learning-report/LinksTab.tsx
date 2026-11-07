/**
 * ⑤ 부모님 링크 탭.
 *
 * 학생마다 링크 하나. "복사" 는 카톡에 그대로 붙여 넣을 안내 문구 + 주소를 함께 복사한다.
 * 부모님은 링크를 누르고 보호자 번호 뒤 4자리를 한 번 넣으면 된다(PLAN §4).
 *
 * 재발급은 옛 주소를 바로 막는다. 링크를 엉뚱한 사람에게 보냈을 때 쓰는 단 하나의 방법이라
 * 버튼은 늘 보이되, 누르기 전에 한 번 묻는다(먼저 보낸 카톡 링크가 죽는다는 것을 알리려고).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, Lock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { API, type Track, type WeekBundle } from "./shared";

/**
 * 부모님 화면(/p/:token)이 생기기 전에는 복사를 막는다. 지금 보내면 부모님이 빈 화면을 본다.
 * 5단계에서 부모님 화면을 붙일 때 true 로 바꾼다.
 */
export const PARENT_PAGE_READY = false;

type LinkRow = {
  studentId: string;
  name: string;
  phoneMasked: string | null;
  canIssue: boolean;
  link: { token: string; path: string; createdAt: string; lastViewedAt: string | null; viewCount: number; lockedUntil: string | null } | null;
};

function seenLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
  return sameDay ? `오늘 ${time}` : `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function LinksTab({ bundle, track }: { bundle: WeekBundle; track: Track }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const classId = bundle.class.id;
  const key = ["/api/learning-report/classes", classId, "links"];
  const { data: rows = [], isLoading } = useQuery<LinkRow[]>({ queryKey: key, staleTime: 0 });
  const { data: profile } = useQuery<{ academyName: string }>({ queryKey: ["/api/academy-profile"] });
  const refetch = () => qc.invalidateQueries({ queryKey: key });

  const message = (name: string, path: string) =>
    `[${profile?.academyName ?? "학원"}] ${name} 학생의 학습 리포트입니다.\n` +
    `아래 링크를 누르고 보호자 번호 뒤 4자리를 입력하시면 볼 수 있어요.\n` +
    `${window.location.origin}${path}`;

  const copy = async (r: LinkRow) => {
    if (!r.link) return;
    try {
      await navigator.clipboard.writeText(message(r.name, r.link.path));
      toast({ title: `${r.name} 안내 문구를 복사했습니다`, description: "카톡 대화창에 붙여 넣어 보내세요." });
    } catch {
      toast({ title: "복사하지 못했습니다", description: "브라우저가 복사를 막았습니다. 주소창 옆 권한을 확인해 주세요." });
    }
  };

  const issue = async (r: LinkRow) => {
    if (await track(apiRequest("POST", `${API}/students/${r.studentId}/link`))) refetch();
  };

  const reissue = async (r: LinkRow) => {
    if (!window.confirm(`${r.name} 링크를 새로 만들까요?\n\n예전에 보낸 링크는 바로 열리지 않게 됩니다. 링크를 잘못 보냈을 때만 쓰세요.`)) return;
    if (await track(apiRequest("POST", `${API}/students/${r.studentId}/link/reissue`))) {
      toast({ title: `${r.name} 링크를 새로 만들었습니다`, description: "새 링크를 복사해 다시 보내 주세요." });
      refetch();
    }
  };

  const issueAll = async () => {
    const targets = rows.filter((r) => !r.link && r.canIssue);
    for (const r of targets) await track(apiRequest("POST", `${API}/students/${r.studentId}/link`));
    refetch();
  };

  const missing = rows.filter((r) => !r.link && r.canIssue).length;
  const noPhone = rows.filter((r) => !r.canIssue).length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">부모님 링크</CardTitle>
          <span className="text-xs text-muted-foreground">부모님은 링크를 누르고 보호자 번호 뒤 4자리를 한 번 입력합니다</span>
          {missing > 0 && (
            <Button size="sm" variant="outline" className="ml-auto text-orange-600" onClick={issueAll} data-testid="button-issue-all">
              <Link2 className="mr-1 h-4 w-4" />
              링크 없는 {missing}명 모두 만들기
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!PARENT_PAGE_READY && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="notice-parent-page-not-ready">
            <b>부모님 화면은 다음 단계에서 열립니다.</b> 링크는 미리 만들어 둘 수 있지만, 지금 보내면 부모님이 빈 화면을 보게 되어 복사 버튼을 잠가 두었습니다.
          </div>
        )}
        {isLoading ? null : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">이 반에 수강 중인 학생이 없습니다.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-2 py-2 font-semibold">학생</th>
                <th className="px-2 py-2 font-semibold">확인용 번호</th>
                <th className="px-2 py-2 font-semibold">최근 열람</th>
                <th className="px-2 py-2 font-semibold">링크</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const locked = r.link?.lockedUntil && new Date(r.link.lockedUntil) > new Date();
                return (
                  <tr key={r.studentId} className="border-b" data-testid={`row-link-${r.studentId}`}>
                    <td className="whitespace-nowrap px-2 py-2 font-bold">{r.name}</td>
                    <td className="whitespace-nowrap px-2 py-2 font-mono text-xs">
                      {r.phoneMasked ?? <span className="font-sans font-semibold text-red-600">보호자 번호 없음</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs">
                      {locked ? (
                        <span className="inline-flex items-center gap-1 font-semibold text-red-600">
                          <Lock className="h-3 w-3" />
                          번호 5번 틀려 잠김 · {new Date(r.link!.lockedUntil!).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" })}까지
                        </span>
                      ) : r.link?.lastViewedAt ? (
                        <span>
                          <b className="text-green-700">● 열람</b> · {seenLabel(r.link.lastViewedAt)}
                          <span className="text-muted-foreground"> ({r.link.viewCount}회)</span>
                        </span>
                      ) : r.link ? (
                        <span className="text-muted-foreground">아직 안 봄</span>
                      ) : (
                        <span className="text-muted-foreground/60">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2">
                      {!r.canIssue ? (
                        <span className="text-xs text-muted-foreground">학생 정보에서 보호자 번호를 먼저 넣어 주세요</span>
                      ) : !r.link ? (
                        <Button size="sm" variant="outline" onClick={() => issue(r)} data-testid={`button-issue-${r.studentId}`}>
                          <Link2 className="mr-1 h-3.5 w-3.5" />
                          링크 만들기
                        </Button>
                      ) : (
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!PARENT_PAGE_READY}
                            title={PARENT_PAGE_READY ? "카톡 안내 문구와 링크를 복사" : "부모님 화면이 열리면 쓸 수 있습니다"}
                            onClick={() => copy(r)}
                            data-testid={`button-copy-${r.studentId}`}
                          >
                            <Copy className="mr-1 h-3.5 w-3.5" />
                            복사
                          </Button>
                          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => reissue(r)} data-testid={`button-reissue-${r.studentId}`}>
                            <RefreshCw className="mr-1 h-3.5 w-3.5" />
                            재발급
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          <b className="text-orange-600">재발급</b>을 누르면 예전 링크는 바로 막힙니다. 링크가 잘못 전달됐을 때만 쓰세요.
          {noPhone > 0 && ` · 보호자 번호가 없는 학생 ${noPhone}명은 링크를 만들 수 없습니다.`} · 결제·수납 정보는 리포트에 절대 나오지 않습니다.
        </p>
      </CardContent>
    </Card>
  );
}
