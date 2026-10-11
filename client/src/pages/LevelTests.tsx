import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ExternalLink, FileText, Printer, RefreshCw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { LevelTestShare } from "@/components/LevelTestShare";
import {
  openLevelTestApp as openApp,
  useLevelTests,
  LEVEL_TESTS_QUERY_KEY,
  type LevelTestRow,
} from "@/hooks/useLevelTests";

/**
 * 레벨테스트 기록.
 *
 * ── 이 화면이 하지 않는 일 ──
 *   채점과 결과지 인쇄는 하지 않는다. 그건 별도의 레벨테스트 앱(단일 HTML)이
 *   계속 담당한다. 그 앱의 결과지는 A4 인쇄를 mm 단위로 맞춘 CSS라서, 여기
 *   React 화면 안(iframe)에 집어넣으면 인쇄 여백이 틀어진다. 학부모에게 주는
 *   종이의 품질이 이 기능의 핵심이라 건드리지 않는다.
 *
 *   그래서 "새 레벨테스트"와 "결과지 다시 열기"는 모두 **새 탭**으로 앱을 띄운다.
 *   이 화면은 쌓인 기록을 찾아보고 지우는 일만 한다.
 *
 * ── 왜 서버에 쌓는가 ──
 *   예전에는 누적 엑셀 파일 한 개에 쌓았다. 파일이 한 대의 PC 에만 있어서 다른
 *   선생님 컴퓨터에서는 기록이 없었고, 백업은 사람 손에 달려 있었다. 이제
 *   학원 계정에 묶여 저장되므로 어느 PC 에서 열어도 같은 목록이 보인다.
 */

const ACADEMY_PROFILE_QUERY_KEY = ["/api/academy-profile"];

type AcademyProfile = {
  academyName: string;
  sharePhone: string | null;
  fallbackPhone: string | null;
};

/**
 * 학부모 눈에 닿는 학원 정보 두 칸 — 학원 이름과 결과지 전화번호.
 *
 * ── 이름을 왜 여기서 고치게 하는가 ──
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
 * ── 왜 레벨테스트 화면에 두는가 ──
 *   두 값이 실제로 쓰이는 곳이 여기(학부모 결과지 링크)다. 따로 "설정" 화면을
 *   만들어 거기 숨겨 두면 원장이 이 칸의 존재를 모른 채로 옛 이름과 개인
 *   번호를 계속 내보낸다. 쓰이는 자리 옆에 둔다.
 *
 * ── 왜 원장에게만 보이는가 ──
 *   학부모 전원에게 나가는 값이라 서버도 owner 만 고치게 막아 뒀다.
 */
function AcademyProfileCard() {
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
      // 같이 새로 받아야 저장한 이름이 바로 반영된다.
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

/** 점수 칸. 아직 채점이 덜 끝난 항목은 숫자 대신 "-" 로 둔다. */
function Score({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="text-center">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value == null ? "-" : value}</div>
    </div>
  );
}

export default function LevelTests({ userRole }: { userRole: "owner" | "teacher" | "superadmin" }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [keyword, setKeyword] = useState("");

  // 재조회 설정과 다른 탭 저장 신호는 useLevelTests 안에 있다 (그 쪽 주석 참고).
  const { data: rows = [], isLoading, isFetching, isError, error, refetch } = useLevelTests();

  const removeRecord = useMutation({
    mutationFn: async (id: string) => (await apiRequest("DELETE", `/api/level-tests/${id}`)).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LEVEL_TESTS_QUERY_KEY });
      toast({ title: "삭제했습니다." });
    },
    onError: (e: Error) =>
      toast({ title: "삭제 실패", description: e.message, variant: "destructive" }),
  });

  // 이름·학교·시험지 이름으로 거른다. 원장이 찾는 방식이 대개 "그 학생 이름" 이라
  // 검색 한 칸으로 충분하다.
  const filtered = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return rows;
    return rows.filter((r) =>
      [r.studentName, r.school, r.grade, r.examTitle, r.teacherName]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(k))
    );
  }, [rows, keyword]);

  // 날짜별로 묶어서 보여 준다. 레벨테스트는 "그날 온 학생들" 단위로 기억되기 때문이다.
  const byDate = useMemo(() => {
    // Map 대신 plain object 를 쓰는 이유: tsconfig target 이 낮아 Map 순회에
    // downlevelIteration 이 필요하다. 전역 tsconfig 를 건드리는 건 이 화면
    // 하나 때문에 할 일이 아니다.
    const groups: Record<string, LevelTestRow[]> = {};
    for (const r of filtered) {
      (groups[r.testDate] ||= []).push(r);
    }
    // 최근 날짜가 위로.
    return Object.keys(groups)
      .sort((a, b) => b.localeCompare(a))
      .map((date) => [date, groups[date]] as [string, LevelTestRow[]]);
  }, [filtered]);

  return (
    <div className="p-4 sm:p-6 space-y-4" data-testid="page-level-tests">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="w-6 h-6 text-primary" />
            레벨테스트 기록
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            채점과 결과지 인쇄는 레벨테스트 앱에서 합니다. 저장된 기록이 여기에 쌓입니다.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 자동 갱신이 어떤 이유로든 안 됐을 때 원장이 직접 누를 수 있는 손잡이. */}
          <Button
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-level-tests"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            새로고침
          </Button>
          <Button onClick={() => openApp()} data-testid="button-open-level-test-app">
            <ExternalLink className="w-4 h-4 mr-2" />
            새 레벨테스트 시작
          </Button>
        </div>
      </div>

      {/* 학부모 결과지에 찍히는 학원 번호. 원장에게만 보인다(서버도 owner만 허용). */}
      {userRole === "owner" && <AcademyProfileCard />}

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="학생 이름 · 학교 · 시험지로 검색"
          className="pl-9"
          data-testid="input-level-test-search"
        />
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">기록을 불러오는 중...</div>}

      {isError && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            기록을 불러오지 못했습니다. {(error as Error)?.message}
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && rows.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <div className="text-sm text-muted-foreground">
              아직 저장된 레벨테스트 기록이 없습니다.
            </div>
            <div className="text-xs text-muted-foreground">
              레벨테스트 앱에서 채점한 뒤 <strong>학생 기록 저장</strong>을 누르면 여기에 쌓입니다.
              <br />
              방금 저장하셨는데 보이지 않으면 <strong>새로고침</strong>을 눌러 주세요.
            </div>
            <div className="flex items-center justify-center gap-2">
              <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
                새로고침
              </Button>
              <Button variant="outline" onClick={() => openApp()}>
                <ExternalLink className="w-4 h-4 mr-2" />
                레벨테스트 앱 열기
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && rows.length > 0 && filtered.length === 0 && (
        <div className="text-sm text-muted-foreground">검색 결과가 없습니다.</div>
      )}

      {byDate.map(([date, list]) => (
        <Card key={date}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              {date}
              <Badge variant="secondary">{list.length}명</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {list.map((r: LevelTestRow) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
                data-testid={`level-test-${r.id}`}
              >
                <div className="min-w-[150px]">
                  <div className="font-semibold">{r.studentName}</div>
                  <div className="text-xs text-muted-foreground">
                    {[r.school, r.grade].filter(Boolean).join(" · ") || "학교·학년 미입력"}
                  </div>
                </div>

                <div className="min-w-[170px]">
                  <div className="text-sm">{r.examTitle}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.correctCount ?? 0}/{r.questionCount ?? 0} 정답
                    {r.pendingCount ? ` · 미채점 ${r.pendingCount}` : ""}
                    {r.skippedCount ? ` · 미응시 ${r.skippedCount}` : ""}
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-center">
                    <div className="text-[11px] text-muted-foreground">총점</div>
                    <div className="text-lg font-bold tabular-nums text-primary">
                      {r.totalScore == null ? "-" : r.totalScore}
                    </div>
                  </div>
                  <Score label="독해" value={r.readingScore} />
                  <Score label="문법" value={r.grammarScore} />
                  <Score label="어휘" value={r.vocabScore} />
                  <Score label="서술형" value={r.writingScore} />
                </div>

                <div className="ml-auto flex items-center gap-2">
                  {r.teacherName && (
                    <span className="text-xs text-muted-foreground">{r.teacherName}</span>
                  )}
                  {/* 학부모용 결과지 링크·메시지. 상담 화면과 같은 컴포넌트를 쓴다. */}
                  <LevelTestShare row={r} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openApp(r.id)}
                    data-testid={`button-reopen-${r.id}`}
                  >
                    <Printer className="w-4 h-4 mr-1" />
                    결과지 다시 열기
                  </Button>
                  {/* 성적 기록을 지우는 일이라 원장에게만 보인다 (서버도 owner만 허용). */}
                  {userRole === "owner" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={removeRecord.isPending}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `${r.studentName} · ${r.examTitle} 기록을 삭제할까요? 되돌릴 수 없습니다.`
                          )
                        )
                          return;
                        removeRecord.mutate(r.id);
                      }}
                      data-testid={`button-delete-${r.id}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  )}
                </div>

                {r.notes && (
                  <div className="w-full text-xs text-muted-foreground border-t pt-2">
                    메모: {r.notes}
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
