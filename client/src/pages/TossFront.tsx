/**
 * Toss Front 2 연동 모니터링 화면.
 *
 * 원장이 여기서 할 수 있는 일:
 *   - 등록된 단말기 목록 확인 · 새 단말기 등록 (deviceKey 발급)
 *   - 오늘 결제 요약 · 최근 결제 intent 목록 (실패·타임아웃 확인용)
 *   - 최근 웹훅 이벤트 (서명 실패는 여기서 알아챈다)
 *
 * 원장이 여기서 할 수 없는 일:
 *   - 결제 승인·취소를 사람이 손으로 바꾸기. 이건 SDK 응답과 웹훅만이 정답이라
 *     사람이 끼면 대사가 어긋난다. 잘못된 건이 있으면 학원비 화면에서 수기 조정한다.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface Device {
  id: string;
  displayName: string;
  isActive: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

interface Summary {
  todayIntentsByStatus: Array<{ status: string; count: number }>;
  todayApprovedAmount: number;
  webhook24hByStatus: Array<{ status: string; count: number }>;
  devices: { active: number; total: number };
}

interface Intent {
  id: string;
  paymentKey: string;
  studentId: string;
  studentName: string | null;
  className: string | null;
  paymentMonth: string;
  amount: number;
  status: string;
  approvedAt: string | null;
  cancelledAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

interface WebhookEvent {
  webhookId: string;
  eventType: string | null;
  signatureValid: boolean;
  status: string;
  errorMessage: string | null;
  receivedAt: string;
  processedAt: string | null;
}

const STATUS_TONE: Record<string, string> = {
  APPROVED: "bg-emerald-100 text-emerald-800",
  CREATED: "bg-slate-100 text-slate-800",
  PROCESSING: "bg-blue-100 text-blue-800",
  CANCELED: "bg-amber-100 text-amber-800",
  TIMEOUT: "bg-orange-100 text-orange-800",
  FAILED: "bg-red-100 text-red-800",
  PROCESSED: "bg-emerald-100 text-emerald-800",
  RECEIVED: "bg-slate-100 text-slate-800",
  IGNORED: "bg-slate-100 text-slate-800",
};

function statusBadge(s: string) {
  return <Badge className={STATUS_TONE[s] ?? "bg-slate-100 text-slate-800"}>{s}</Badge>;
}

export default function TossFront() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [issuedKey, setIssuedKey] = useState<string | null>(null);

  const { data: summary } = useQuery<Summary>({
    queryKey: ["/api/toss-front/admin/summary"],
    refetchInterval: 30_000,
  });
  const { data: devices = [] } = useQuery<Device[]>({
    queryKey: ["/api/toss-front/devices"],
  });
  const { data: intents = [] } = useQuery<Intent[]>({
    queryKey: ["/api/toss-front/admin/intents"],
    refetchInterval: 30_000,
  });
  const { data: webhooks = [] } = useQuery<WebhookEvent[]>({
    queryKey: ["/api/toss-front/admin/webhooks"],
    refetchInterval: 30_000,
  });

  const enrollMutation = useMutation({
    mutationFn: async (name: string) =>
      (await apiRequest("POST", "/api/toss-front/devices/enroll", { displayName: name })).json(),
    onSuccess: (data: any) => {
      setIssuedKey(data.deviceKey);
      setDisplayName("");
      qc.invalidateQueries({ queryKey: ["/api/toss-front/devices"] });
    },
    onError: (e: Error) =>
      toast({ title: "등록 실패", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) =>
      (await apiRequest("DELETE", `/api/toss-front/devices/${id}`)).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/toss-front/devices"] }),
  });

  const closeEnrollDialog = () => {
    setEnrollOpen(false);
    setIssuedKey(null);
    setDisplayName("");
  };

  const intentStatusCount = (s: string) =>
    summary?.todayIntentsByStatus.find((r) => r.status === s)?.count ?? 0;
  const webhookStatusCount = (s: string) =>
    summary?.webhook24hByStatus.find((r) => r.status === s)?.count ?? 0;

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Toss Front 2 연동</h1>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">오늘 승인 금액</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(summary?.todayApprovedAmount ?? 0).toLocaleString()}원
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              승인 {intentStatusCount("APPROVED")}건 / 실패 {intentStatusCount("FAILED")}건
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">활성 단말기</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {summary?.devices.active ?? 0}
              <span className="text-base text-muted-foreground"> / {summary?.devices.total ?? 0}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">진행중 intent</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {intentStatusCount("CREATED") + intentStatusCount("PROCESSING")}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              CREATED {intentStatusCount("CREATED")} · PROCESSING {intentStatusCount("PROCESSING")}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">웹훅 24h</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {webhookStatusCount("PROCESSED")}
              {webhookStatusCount("FAILED") > 0 && (
                <span className="text-base text-red-600 ml-2">
                  실패 {webhookStatusCount("FAILED")}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 단말기 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>단말기</CardTitle>
          <Button size="sm" onClick={() => setEnrollOpen(true)}>
            새 단말기 등록
          </Button>
        </CardHeader>
        <CardContent>
          {devices.length === 0 ? (
            <div className="text-sm text-muted-foreground">등록된 단말기가 없습니다.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">이름</th>
                  <th>상태</th>
                  <th>마지막 접속</th>
                  <th className="text-right">작업</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="border-t">
                    <td className="py-2">{d.displayName}</td>
                    <td>
                      {d.isActive ? (
                        <Badge className="bg-emerald-100 text-emerald-800">활성</Badge>
                      ) : (
                        <Badge className="bg-slate-100 text-slate-500">비활성</Badge>
                      )}
                    </td>
                    <td className="text-muted-foreground">
                      {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString("ko-KR") : "—"}
                    </td>
                    <td className="text-right">
                      {d.isActive && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            if (confirm("이 단말기를 폐기하시겠어요? 이후 세션 발급이 거절됩니다.")) {
                              deleteMutation.mutate(d.id);
                            }
                          }}
                        >
                          폐기
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* intent 목록 */}
      <Card>
        <CardHeader>
          <CardTitle>최근 결제 (payment intents)</CardTitle>
        </CardHeader>
        <CardContent>
          {intents.length === 0 ? (
            <div className="text-sm text-muted-foreground">아직 결제 시도가 없습니다.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2">시각</th>
                    <th>학생</th>
                    <th>반</th>
                    <th>월</th>
                    <th className="text-right">금액</th>
                    <th>상태</th>
                    <th>비고</th>
                  </tr>
                </thead>
                <tbody>
                  {intents.slice(0, 50).map((it) => (
                    <tr key={it.id} className="border-t">
                      <td className="py-2 whitespace-nowrap">
                        {new Date(it.createdAt).toLocaleString("ko-KR")}
                      </td>
                      <td>{it.studentName ?? "—"}</td>
                      <td>{it.className ?? "—"}</td>
                      <td>{it.paymentMonth}</td>
                      <td className="text-right">{it.amount.toLocaleString()}</td>
                      <td>{statusBadge(it.status)}</td>
                      <td className="text-xs text-muted-foreground">
                        {it.failureReason ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 웹훅 */}
      <Card>
        <CardHeader>
          <CardTitle>웹훅 이벤트 (최근)</CardTitle>
        </CardHeader>
        <CardContent>
          {webhooks.length === 0 ? (
            <div className="text-sm text-muted-foreground">아직 웹훅 수신 이력이 없습니다.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2">수신</th>
                    <th>유형</th>
                    <th>서명</th>
                    <th>상태</th>
                    <th>오류</th>
                  </tr>
                </thead>
                <tbody>
                  {webhooks.slice(0, 50).map((w) => (
                    <tr key={w.webhookId} className="border-t">
                      <td className="py-2 whitespace-nowrap">
                        {new Date(w.receivedAt).toLocaleString("ko-KR")}
                      </td>
                      <td>{w.eventType ?? "—"}</td>
                      <td>
                        {w.signatureValid ? (
                          <Badge className="bg-emerald-100 text-emerald-800">valid</Badge>
                        ) : (
                          <Badge className="bg-red-100 text-red-800">invalid</Badge>
                        )}
                      </td>
                      <td>{statusBadge(w.status)}</td>
                      <td className="text-xs text-muted-foreground max-w-[300px] truncate">
                        {w.errorMessage ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 등록 다이얼로그 */}
      <Dialog open={enrollOpen} onOpenChange={(v) => (!v ? closeEnrollDialog() : setEnrollOpen(v))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 단말기 등록</DialogTitle>
          </DialogHeader>
          {!issuedKey ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                단말기 이름을 입력하세요. 예: "로비 프론트 1", "카운터 옆 태블릿".
              </p>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="단말기 이름"
              />
              <DialogFooter>
                <Button variant="outline" onClick={closeEnrollDialog}>취소</Button>
                <Button
                  disabled={!displayName.trim() || enrollMutation.isPending}
                  onClick={() => enrollMutation.mutate(displayName.trim())}
                >
                  발급
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-medium">
                등록 코드가 발급됐습니다. <span className="text-red-600">이 창을 닫으면 다시 볼 수 없습니다.</span>
              </p>
              <div className="p-3 bg-slate-100 rounded font-mono text-xs break-all">{issuedKey}</div>
              <p className="text-xs text-muted-foreground">
                태블릿의 첫 부팅 화면에 이 코드를 붙여넣기 하세요.
              </p>
              <DialogFooter>
                <Button onClick={closeEnrollDialog}>확인</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
