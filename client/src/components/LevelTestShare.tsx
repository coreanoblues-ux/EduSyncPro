/**
 * 학부모에게 결과지 링크를 보내는 버튼 묶음 (3층).
 *
 * 상담 화면과 레벨테스트 기록 화면이 함께 쓴다. 두 화면에 각각 복사해 두면
 * 한쪽만 고쳐져 동작이 갈리므로 컴포넌트로 묶는다.
 *
 * ════════════════════════════════════════════════════════════════════════
 * 화면을 이렇게 만든 이유
 * ════════════════════════════════════════════════════════════════════════
 * · **버튼이 늘 두 개를 넘지 않는다.** 원장이 통화 중에 누르는 버튼이다.
 *   "만들기" 전에는 버튼 하나, 만든 뒤에는 "메시지 복사" 와 "끄기" 뿐이다.
 *
 * · **"열어 봄 N회" 를 버튼 옆에 붙인다.** 이 숫자가 이 기능의 절반이다.
 *   0회면 아직 안 본 것이고, 그게 전화할 이유가 된다. 따로 들어가서 봐야
 *   하는 자리에 두면 아무도 안 본다.
 *
 * · **복사 버튼이 복사하는 것은 "링크" 가 아니라 "메시지 전문" 이다.**
 *   원장이 카카오톡에 붙여 넣으면 그대로 보낼 수 있는 글이어야 한다.
 *   링크만 복사하면 원장이 매번 인사말을 다시 타이핑한다. 문구 규칙은
 *   shared/shareMessage.ts 에 있다 (거기에 "왜 발송 API 를 안 붙였는가" 도 적어 뒀다).
 *
 * · **복사가 실패해도 길이 있다.** 브라우저 권한·보안 설정 때문에
 *   navigator.clipboard 가 막히는 환경이 있다. 그때 "복사 실패" 로 끝내면
 *   원장은 할 수 있는 일이 없다. 그래서 창 안에 글을 그대로 띄워 두고
 *   손으로 긁어 복사할 수 있게 한다.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Copy, Check, EyeOff, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { LEVEL_TESTS_QUERY_KEY, type LevelTestRow } from "@/hooks/useLevelTests";
import { buildShareMessage } from "@shared/shareMessage";

/** 링크 상태 판단. 서버(server/lib/shareLink.ts 의 shareState)와 같은 규칙이다. */
function linkState(row: LevelTestRow): "active" | "expired" | "revoked" | "none" {
  if (!row.shareToken) return "none";
  if (row.shareRevokedAt) return "revoked";
  if (row.shareExpiresAt && new Date(row.shareExpiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

/**
 * 클립보드에 쓴다. 성공했는지 돌려준다.
 *
 * navigator.clipboard 는 보안 컨텍스트(https 또는 localhost)에서만 동작한다.
 * 운영은 https 라 문제가 없지만, 실패를 조용히 넘기면 원장은 "복사됐다" 는
 * 말만 보고 빈 클립보드를 붙여 넣는다. 그래서 결과를 반드시 확인한다.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 아래 예비 수단으로 넘어간다.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function formatWhen(value: Date | string | null): string {
  if (!value) return "";
  const d = new Date(value);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function LevelTestShare({ row }: { row: LevelTestRow }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  /**
   * 학원 이름은 메시지 첫 줄("안녕하세요, ○○학원입니다")에 들어간다.
   * /api/auth/me 는 로그인 확인에 이미 쓰이는 주소라 대개 캐시에서 온다.
   * 실패해도 기능이 멈추지 않게 "학원" 으로 떨어뜨린다.
   */
  const { data: me } = useQuery<{ tenant: { name: string } | null }>({
    queryKey: ["/api/auth/me"],
  });
  const academyName = me?.tenant?.name ?? "학원";

  const state = linkState(row);
  const graded = row.totalScore != null && !row.pendingCount;

  // 주소는 브라우저가 보고 있는 출처에서 만든다. 서버가 자기 주소를 추측하면
  // 프록시 뒤에서 틀리는 경우가 있다(railway 내부 호스트가 섞인다).
  const url = row.shareToken ? `${window.location.origin}/r/${row.shareToken}` : "";

  const message = buildShareMessage({
    academyName,
    studentName: row.studentName,
    testDate: row.testDate,
    examTitle: row.examTitle,
    totalScore: row.totalScore,
    questionCount: row.questionCount,
    correctCount: row.correctCount,
    url,
    expiresAt: row.shareExpiresAt,
  });

  const issue = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", `/api/level-tests/${row.id}/share`, {});
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: LEVEL_TESTS_QUERY_KEY });
      setOpen(true);
    },
    onError: (err: Error) => {
      toast({
        title: "링크를 만들지 못했습니다",
        description: err.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      });
    },
  });

  const revoke = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/level-tests/${row.id}/share`);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: LEVEL_TESTS_QUERY_KEY });
      setOpen(false);
      toast({
        title: "링크를 닫았습니다",
        description: "이제 이 주소로는 결과지가 열리지 않습니다.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "링크를 닫지 못했습니다",
        description: err.message.replace(/^\d+:\s*/, ""),
        variant: "destructive",
      });
    },
  });

  async function onCopy() {
    const ok = await copyText(message);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({ title: "메시지를 복사했습니다", description: "카카오톡에 붙여 넣으세요." });
    } else {
      toast({
        title: "자동 복사가 막혀 있습니다",
        description: "아래 상자의 글을 직접 선택해 복사해 주세요.",
        variant: "destructive",
      });
    }
  }

  /*
    채점이 안 끝난 결과지에는 버튼을 띄우지 않는다.
    서버도 막지만(shareRoutes.ts), 누를 수 있는 버튼을 보여 주고 눌렀을 때
    거절하는 것은 좋은 화면이 아니다. 왜 못 만드는지 한 줄로 알려 준다.
  */
  if (!graded) {
    return (
      <span className="text-xs text-muted-foreground">
        채점을 마치면 학부모 링크를 만들 수 있습니다
      </span>
    );
  }

  return (
    <>
      {state === "active" ? (
        <span className="flex items-center gap-1.5">
          {/*
            열어 본 횟수. 0회를 "아직 안 봄" 이라고 또박또박 적는다 —
            "0" 이라는 숫자보다 그 말이 전화할 이유로 더 잘 읽힌다.
          */}
          <Badge
            variant={row.shareViewCount > 0 ? "secondary" : "outline"}
            className="gap-1"
            data-testid={`share-views-${row.id}`}
          >
            <Eye className="h-3 w-3" />
            {row.shareViewCount > 0 ? `열어 봄 ${row.shareViewCount}회` : "아직 안 봄"}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOpen(true)}
            data-testid={`button-share-open-${row.id}`}
          >
            <Copy className="h-4 w-4 mr-1" />
            학부모 메시지
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={issue.isPending}
          onClick={() => issue.mutate()}
          data-testid={`button-share-create-${row.id}`}
        >
          <Link2 className="h-4 w-4 mr-1" />
          {state === "none" ? "학부모 링크 만들기" : "링크 다시 만들기"}
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>학부모에게 보낼 메시지</DialogTitle>
            <DialogDescription>
              아래 글을 복사해 카카오톡으로 보내세요. 링크를 누르면 학부모가 결과지를 봅니다.
            </DialogDescription>
          </DialogHeader>

          {/*
            읽기 전용이지만 선택은 되게 둔다. 자동 복사가 막힌 환경에서
            손으로 긁어 복사하는 길이 이것뿐이다.
          */}
          <Textarea
            readOnly
            value={message}
            rows={12}
            className="text-sm font-normal leading-relaxed"
            onFocus={(e) => e.currentTarget.select()}
            data-testid={`share-message-${row.id}`}
          />

          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">열어 본 횟수</span>
              <span className="font-medium">
                {row.shareViewCount > 0
                  ? `${row.shareViewCount}회 · 마지막 ${formatWhen(row.shareLastViewedAt)}`
                  : "아직 열어 보지 않았습니다"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">볼 수 있는 기한</span>
              <span className="font-medium">{formatWhen(row.shareExpiresAt)} 까지</span>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            {/*
              "끄기" 는 조용한 버튼으로 둔다. 자주 누를 일이 아니고,
              잘못 누르면 학부모가 받은 링크가 죽는다.
            */}
            <Button
              variant="ghost"
              size="sm"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
              data-testid={`button-share-revoke-${row.id}`}
            >
              <EyeOff className="h-4 w-4 mr-1" />
              링크 끄기
            </Button>
            <Button onClick={onCopy} data-testid={`button-share-copy-${row.id}`}>
              {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
              {copied ? "복사했습니다" : "메시지 복사"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
