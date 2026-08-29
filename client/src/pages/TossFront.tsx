/**
 * Toss Front 2 연동 모니터링 화면.
 *
 * 원장이 여기서 할 수 있는 일:
 *   - 등록된 단말기 목록 확인 · 새 단말기 등록 (deviceKey 발급)
 *   - 오늘 결제 요약 · 최근 결제 intent 목록 (실패·타임아웃 확인용)
 *   - 최근 웹훅 이벤트 (서명 실패는 여기서 알아챈다)
 *
 *   - 환불 기록 (승인된 결제의 전액·부분 환불을 장부에 반영)
 *
 * 원장이 여기서 할 수 없는 일:
 *   - 결제 "승인"을 사람이 손으로 만들기. 승인은 SDK 응답과 웹훅만이 정답이라
 *     사람이 끼면 대사가 어긋난다.
 *   - 실제 카드 취소. 그건 토스 판매자센터·단말기에서 해야 한다. 이 화면의 환불은
 *     그 사실을 우리 장부에 적는 것뿐이며, 화면에도 그렇게 써 두었다.
 *
 * 환불이 태블릿이 아니라 여기 있는 이유:
 *   태블릿 인증은 전화번호 뒤 4자리다. 본인 확인용으로는 되지만 돈을 되돌릴 권한의
 *   근거로는 못 쓴다. 태블릿은 현관에 있고 누구나 만진다.
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

// 학생용 태블릿(/student-kiosk) 을 위한 별도 장기키.
// Toss Front 하드웨어와 인증 경로가 분리되어 있다.
interface KioskDevice {
  id: string;
  displayName: string;
  pairedFrontDeviceId: string | null;
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
  /**
   * 장부(payments)에 수입으로 잡혀 있는가.
   * 상태와 별개다 — TIMEOUT 인데 실제로는 카드가 승인된 건이 존재한다.
   */
  ledgered: boolean;
}

// 단말기 플러그인이 서버로 밀어 올린 라이프사이클 로그.
// 단말기에 개발자도구를 붙일 수 없으므로 원장은 이 표가 유일한 창구다.
interface PluginLog {
  receivedAt: string;
  at: string | null;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  deviceId: string | null;
  pluginVersion: string | null;
}

interface TestCandidate {
  enrollmentId: string;
  studentName: string;
  className: string | null;
}

/**
 * 환불 대상 결제 한 건.
 *
 * refundable 은 서버가 "승인액 - 이미 환불된 누적액"으로 계산해 내려준다.
 * 화면에서 다시 빼서 쓰지 않는다 — 두 곳에서 각자 계산하면 반드시 어긋난다.
 */
interface Refundable {
  paymentKey: string;
  studentName: string | null;
  className: string | null;
  paymentMonth: string;
  amount: number;
  status: string;
  approvedAt: string | null;
  refunded: number;
  refundable: number;
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
  // 0.3.2~ : 새 페어링 UX. code + PIN 을 태블릿에서 입력받는다. issuedKey (raw) 는 관리자용 폴백.
  const [issuedPairing, setIssuedPairing] = useState<{
    code: string;
    pin: string;
    expiresAt: string;
    expiresInHours: number;
  } | null>(null);
  const [showRawFallback, setShowRawFallback] = useState(false);

  // 태블릿(kiosk) 등록 상태 — Toss Front 단말기 등록과 다이얼로그 분리
  const [kioskEnrollOpen, setKioskEnrollOpen] = useState(false);
  const [kioskName, setKioskName] = useState("");
  const [kioskPairedFrontId, setKioskPairedFrontId] = useState<string>("");
  const [issuedKioskKey, setIssuedKioskKey] = useState<string | null>(null);

  // 진단 도구 (플러그인 로그 / 100원 테스트)
  const [logsOpen, setLogsOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testEnrollmentId, setTestEnrollmentId] = useState("");
  const [testDeviceId, setTestDeviceId] = useState("");

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

  // ─── 환불 ────────────────────────────────────────────────────────────
  const { data: refundables = [] } = useQuery<Refundable[]>({
    queryKey: ["/api/toss-front/admin/refundable"],
    refetchInterval: 30_000,
  });
  const [refundTarget, setRefundTarget] = useState<Refundable | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");

  const refundMutation = useMutation({
    mutationFn: async (input: { paymentKey: string; amount: number; reason: string }) =>
      (await apiRequest("POST", "/api/toss-front/admin/refunds", input)).json(),
    onSuccess: (data: any) => {
      setRefundTarget(null);
      setRefundAmount("");
      setRefundReason("");
      // 환불은 장부·잔액·태블릿 화면을 동시에 움직인다. 관련 캐시를 전부 무효화하지
      // 않으면 원장이 "환불했는데 그대로네"를 보고 한 번 더 누른다.
      qc.invalidateQueries({ queryKey: ["/api/toss-front/admin/refundable"] });
      qc.invalidateQueries({ queryKey: ["/api/toss-front/admin/intents"] });
      qc.invalidateQueries({ queryKey: ["/api/toss-front/admin/summary"] });
      qc.invalidateQueries({ queryKey: ["/api/payments"] });
      toast({
        title: `환불 ${Number(data.refundedNow).toLocaleString()}원 기록됨`,
        description: data.notice,
      });
    },
    onError: (e: Error) =>
      toast({ title: "환불 실패", description: e.message, variant: "destructive" }),
  });

  /** 환불 다이얼로그를 연다. 금액은 남은 전액을 기본값으로 채운다 (가장 흔한 경우). */
  function openRefund(r: Refundable) {
    setRefundTarget(r);
    setRefundAmount(String(r.refundable));
    setRefundReason("");
  }

  // ─── 수기 대사 ───────────────────────────────────────────────────────
  const [reconcileTarget, setReconcileTarget] = useState<Intent | null>(null);
  const [approvalNumber, setApprovalNumber] = useState("");
  const [reconcileNote, setReconcileNote] = useState("");

  const reconcileMutation = useMutation({
    mutationFn: async (input: { paymentKey: string; approvalNumber: string; note: string }) =>
      (await apiRequest("POST", "/api/toss-front/admin/reconcile", input)).json(),
    onSuccess: (data: any) => {
      setReconcileTarget(null);
      setApprovalNumber("");
      setReconcileNote("");
      qc.invalidateQueries({ queryKey: ["/api/toss-front/admin/intents"] });
      qc.invalidateQueries({ queryKey: ["/api/toss-front/admin/refundable"] });
      qc.invalidateQueries({ queryKey: ["/api/toss-front/admin/summary"] });
      qc.invalidateQueries({ queryKey: ["/api/payments"] });
      toast({
        title: data.inserted
          ? `${Number(data.amount).toLocaleString()}원 장부 반영 완료`
          : "이미 반영된 건입니다",
        description: data.message,
      });
    },
    onError: (e: Error) =>
      toast({ title: "장부 반영 실패", description: e.message, variant: "destructive" }),
  });

  /**
   * 이 건에 "장부 반영" 버튼을 보여야 하나.
   * 진행 중(CREATED/PROCESSING)은 제외한다 — confirm 이 아직 올 수 있어서
   * 사람이 먼저 넣으면 이중 입력이 된다. 서버도 같은 이유로 거절한다.
   */
  function needsReconcile(it: Intent) {
    return !it.ledgered && it.status !== "CREATED" && it.status !== "PROCESSING";
  }

  const refundAmountNum = Number(refundAmount);
  const refundAmountValid =
    Number.isInteger(refundAmountNum) &&
    refundAmountNum > 0 &&
    !!refundTarget &&
    refundAmountNum <= refundTarget.refundable;

  const enrollMutation = useMutation({
    mutationFn: async (name: string) =>
      (await apiRequest("POST", "/api/toss-front/devices/enroll", { displayName: name })).json(),
    onSuccess: (data: any) => {
      setIssuedKey(data.deviceKey ?? null);
      setIssuedPairing(data.pairing ?? null);
      setShowRawFallback(false);
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

  // ─── 태블릿(kiosk) API ───────────────────────────────────────────────
  const { data: kioskDevices = [] } = useQuery<KioskDevice[]>({
    queryKey: ["/api/toss-kiosk/devices"],
  });

  const enrollKioskMutation = useMutation({
    mutationFn: async (input: { displayName: string; pairedFrontDeviceId?: string }) =>
      (await apiRequest("POST", "/api/toss-kiosk/devices/enroll", input)).json(),
    onSuccess: (data: any) => {
      setIssuedKioskKey(data.kioskKey);
      setKioskName("");
      setKioskPairedFrontId("");
      qc.invalidateQueries({ queryKey: ["/api/toss-kiosk/devices"] });
    },
    onError: (e: Error) =>
      toast({ title: "태블릿 등록 실패", description: e.message, variant: "destructive" }),
  });

  const deleteKioskMutation = useMutation({
    mutationFn: async (id: string) =>
      (await apiRequest("DELETE", `/api/toss-kiosk/devices/${id}`)).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/toss-kiosk/devices"] }),
  });

  // ─── 진단: 플러그인 로그 ─────────────────────────────────────────────
  // 검은 화면을 보고 있는 동안에도 갱신돼야 하므로 5초. 서버는 메모리 링버퍼라
  // 이 정도 주기로 읽어도 DB 부담이 없다.
  const { data: pluginLogs } = useQuery<{ logs: PluginLog[]; total: number }>({
    queryKey: ["/api/toss-front/plugin-logs"],
    refetchInterval: logsOpen ? 5_000 : false,
    enabled: logsOpen,
  });

  const clearLogsMutation = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", "/api/toss-front/plugin-logs")).json(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/toss-front/plugin-logs"] }),
  });

  // ─── 진단: 100원 테스트 결제 ─────────────────────────────────────────
  const { data: testCandidates = [] } = useQuery<TestCandidate[]>({
    queryKey: ["/api/toss-front/admin/test-payment/candidates"],
    enabled: testOpen,
  });

  const testPaymentMutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", "/api/toss-front/admin/test-payment", {
          enrollmentId: testEnrollmentId,
          tossDeviceId: testDeviceId || undefined,
        })
      ).json(),
    onSuccess: (data: any) => {
      setTestOpen(false);
      toast({
        title: "100원 테스트 결제를 단말기로 보냈습니다",
        description: data.notice ?? "단말기 화면을 확인하세요.",
      });
      qc.invalidateQueries({ queryKey: ["/api/toss-front/admin/intents"] });
      qc.invalidateQueries({ queryKey: ["/api/toss-front/admin/summary"] });
    },
    onError: (e: Error) =>
      toast({ title: "테스트 결제 실패", description: e.message, variant: "destructive" }),
  });

  const closeKioskDialog = () => {
    setKioskEnrollOpen(false);
    setIssuedKioskKey(null);
    setKioskName("");
    setKioskPairedFrontId("");
  };

  const closeEnrollDialog = () => {
    setEnrollOpen(false);
    setIssuedKey(null);
    setIssuedPairing(null);
    setShowRawFallback(false);
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

      {/* 학생 태블릿 (kiosk) */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>학생 태블릿</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              카운터 옆 태블릿의 <span className="font-mono">/student-kiosk/setup</span> 에 붙여 넣을 장기키.
              발급된 kioskKey 는 재조회할 수 없으니 태블릿에 즉시 저장하세요.
            </p>
          </div>
          <Button size="sm" onClick={() => setKioskEnrollOpen(true)}>
            새 태블릿 등록
          </Button>
        </CardHeader>
        <CardContent>
          {kioskDevices.length === 0 ? (
            <div className="text-sm text-muted-foreground">등록된 태블릿이 없습니다.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-2">이름</th>
                  <th>페어링 결제 단말기</th>
                  <th>상태</th>
                  <th>마지막 접속</th>
                  <th className="text-right">작업</th>
                </tr>
              </thead>
              <tbody>
                {kioskDevices.map((k) => {
                  const paired = devices.find((d) => d.id === k.pairedFrontDeviceId);
                  return (
                    <tr key={k.id} className="border-t">
                      <td className="py-2">{k.displayName}</td>
                      <td className="text-xs text-muted-foreground">
                        {paired ? paired.displayName : "자동 라우팅"}
                      </td>
                      <td>
                        {k.isActive ? (
                          <Badge className="bg-emerald-100 text-emerald-800">활성</Badge>
                        ) : (
                          <Badge className="bg-slate-100 text-slate-500">비활성</Badge>
                        )}
                      </td>
                      <td className="text-muted-foreground">
                        {k.lastSeenAt ? new Date(k.lastSeenAt).toLocaleString("ko-KR") : "—"}
                      </td>
                      <td className="text-right">
                        {k.isActive && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              if (confirm("이 태블릿을 폐기하시겠어요? 태블릿 세션이 즉시 무효화됩니다.")) {
                                deleteKioskMutation.mutate(k.id);
                              }
                            }}
                          >
                            폐기
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* 진단 도구 — 단말기가 검은 화면일 때 원장이 제일 먼저 여는 곳 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>단말기 진단</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              결제 단말기 화면이 검거나 반응이 없을 때, 플러그인이 어디까지 갔는지 여기서 봅니다.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setLogsOpen(true)}>
              플러그인 로그
            </Button>
            <Button size="sm" variant="outline" onClick={() => setTestOpen(true)}>
              100원 테스트 결제
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            정상 부팅이면 로그에{" "}
            <span className="font-mono">plugin entry started → SDK initialized → terminal
            authenticated → backend connection OK → polling started → waiting payment intent</span>{" "}
            순서로 6줄이 남습니다. 중간에서 멈춘 지점이 곧 고장 지점입니다.
          </p>
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
                    <th>장부</th>
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
                      {/*
                        상태와 장부를 나란히 두는 것이 이 표의 핵심이다.
                        TIMEOUT 인데 실제로는 카드가 승인된 건이 있고, 화면상
                        진짜 실패와 구분되지 않는다. 두 칸을 같이 보여 주면
                        "실패로 보이는데 장부에도 없네 → 판매자센터 확인" 이라는
                        다음 행동이 원장에게 보인다.
                      */}
                      <td>
                        {it.ledgered ? (
                          <Badge className="bg-emerald-100 text-emerald-800">반영됨</Badge>
                        ) : needsReconcile(it) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setReconcileTarget(it);
                              setApprovalNumber("");
                              setReconcileNote("");
                            }}
                            data-testid={`reconcile-button-${it.id}`}
                          >
                            장부 반영
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
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

      {/* 수기 대사 다이얼로그 */}
      <Dialog open={!!reconcileTarget} onOpenChange={(o) => !o && setReconcileTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>장부에 반영 (수기 대사)</DialogTitle>
          </DialogHeader>
          {reconcileTarget && (
            <div className="space-y-4">
              <div className="rounded-md bg-slate-50 p-3 text-sm">
                <div>
                  <b>{reconcileTarget.studentName ?? "—"}</b> · {reconcileTarget.className ?? "—"} ·{" "}
                  {reconcileTarget.paymentMonth}
                </div>
                <div className="mt-1 text-muted-foreground">
                  {new Date(reconcileTarget.createdAt).toLocaleString("ko-KR")} · 상태{" "}
                  {reconcileTarget.status}
                </div>
                <div className="mt-2 text-lg font-semibold">
                  {reconcileTarget.amount.toLocaleString()}원
                </div>
              </div>

              {/*
                금액 입력칸이 없는 것은 실수가 아니라 설계다.
                수기 대사는 "장부에 없는 수입을 사람이 만드는" 동작이라 숫자를
                지어낼 수 있으면 안 된다. 항상 원래 결제요청 금액으로 들어간다.
              */}
              <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
                <div className="font-semibold">
                  토스 판매자센터에서 실제 승인내역을 먼저 확인하세요.
                </div>
                <div className="mt-1">
                  이 건은 시스템에 <b>{reconcileTarget.status}</b> 로 남아 있습니다. 카드가 실제로
                  승인된 것이 확인된 경우에만 반영하세요. 실패한 결제를 반영하면 학생이 내지 않은
                  돈이 낸 것으로 기록됩니다.
                </div>
              </div>

              <div>
                <label className="text-sm font-medium">승인번호 (필수)</label>
                <Input
                  value={approvalNumber}
                  onChange={(e) => setApprovalNumber(e.target.value)}
                  placeholder="판매자센터의 승인번호를 그대로 입력"
                  maxLength={64}
                  data-testid="reconcile-approval-input"
                />
                <div className="mt-1 text-xs text-muted-foreground">
                  실물 승인내역을 보고 옮겨 적도록 필수로 두었습니다. 확인 없이 누르는 것을
                  막기 위한 장치입니다.
                </div>
              </div>

              <div>
                <label className="text-sm font-medium">메모 (선택)</label>
                <Input
                  value={reconcileNote}
                  onChange={(e) => setReconcileNote(e.target.value)}
                  placeholder="예: 단말기 재시작으로 confirm 누락"
                  maxLength={200}
                  data-testid="reconcile-note-input"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReconcileTarget(null)}>
              닫기
            </Button>
            <Button
              disabled={!approvalNumber.trim() || reconcileMutation.isPending}
              onClick={() =>
                reconcileTarget &&
                reconcileMutation.mutate({
                  paymentKey: reconcileTarget.paymentKey,
                  approvalNumber: approvalNumber.trim(),
                  note: reconcileNote.trim(),
                })
              }
              data-testid="reconcile-submit"
            >
              {reconcileMutation.isPending ? "반영 중…" : "장부에 반영"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 환불 */}
      <Card>
        <CardHeader>
          <CardTitle>환불 · 결제 취소</CardTitle>
        </CardHeader>
        <CardContent>
          {/*
            이 경고를 지우지 말 것.
            현재 서버에는 토스 Open API 시크릿 키가 없어서 카드사에 취소를 걸 수 없다.
            원장이 "눌렀으니 돈이 돌아갔겠지"라고 오해하는 것이 이 화면에서 가장 큰 사고다.
          */}
          <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-semibold">먼저 실제 카드 취소를 진행하세요.</div>
            <div className="mt-1">
              이 버튼은 <b>학원 장부에만</b> 환불을 기록합니다. 이것만으로는 카드값이
              돌아가지 않습니다. 순서는 <b>① 토스에서 취소 → ② 여기서 기록</b> 입니다.
            </div>
            {/*
              "토스에서 취소" 가 어디인지 원장이 물었다 (2026-08-29):
              "학생 태블릿에서야 아니면 토스플레이스 단말기에서야?"
              모호한 안내는 안 쓴 것과 같다. 두 경로를 이름으로 적고,
              태블릿이 아니라는 것도 명시한다.
            */}
            <div className="mt-2 rounded border border-amber-200 bg-white/60 p-2">
              <div className="font-semibold">① 취소는 토스 판매자센터에서 합니다</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                <li>
                  <b>토스 판매자센터</b> (PC 웹) — 결제내역에서 해당 건을 찾아 취소.
                  원장님 컴퓨터에서 하시면 됩니다. <b>확실한 경로는 이것뿐입니다.</b>
                </li>
                <li>
                  <b>단말기에서 나가는 길은 보장되지 않습니다.</b> 대기화면{" "}
                  <b>[관리자] → [첫화면으로]</b> 버튼이 v0.3.9 부터 있지만, Toss 문서가
                  이 API(<code>sdk.app.setIdle</code>)에 대해 밝힌 것은{" "}
                  <i>"첫화면으로 이동해요"</i> 한 줄뿐입니다. 기본 결제앱의 거래내역까지
                  간다는 보장이 없어서, 눌러 보고 되는지 확인하셔야 합니다.
                  <div className="text-xs text-amber-800">
                    (이전 안내에 "[토스 홈으로] → [나가기] 로 기본 결제앱 거래내역에서
                    취소하세요" 라고 적었던 것은 문서로 확인되지 않은 내용이었습니다.
                    정정합니다.)
                  </div>
                  {/*
                    0.3.10 의 [관리자] 버튼은 Toss 템플릿 대기화면 위에만 있었다.
                    그런데 원장 단말기의 renderIdlePage 는 React 오류를 던져서
                    템플릿이 아예 안 그려졌고, 그래서 버튼이 실물 화면에 없었다.
                    원장의 지적이 정확했다: "이 대기 화면을 나갈 수 있어야 하는데
                    방법이 없잖아." 0.3.11 에서 자체 화면에도 같은 버튼을 넣었다.
                  */}
                  <div className="mt-1 text-xs text-amber-800">
                    v0.3.10 까지는 이 버튼이 <b>Toss 기본 대기화면에만</b> 있었습니다. 그
                    화면이 안 그려지는 단말기에서는 버튼도 같이 없었습니다 (원장님이 보신
                    화면이 이 경우입니다). <b>v0.3.11</b> 부터는 어느 화면이든 [관리자]
                    버튼이 함께 나옵니다.
                  </div>
                </li>
              </ul>
              <div className="mt-1.5">
                <b>학생용 태블릿에서는 취소할 수 없습니다.</b> 태블릿은 학생이 결제를
                시작하는 용도뿐이라 취소 기능이 없습니다.
              </div>
            </div>
          </div>

          {refundables.length === 0 ? (
            <div className="text-sm text-muted-foreground">승인된 결제가 아직 없습니다.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2">승인시각</th>
                    <th>학생</th>
                    <th>반</th>
                    <th>월</th>
                    <th className="text-right">승인액</th>
                    <th className="text-right">환불됨</th>
                    <th className="text-right">환불가능</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {refundables.map((r) => (
                    <tr key={r.paymentKey} className="border-t" data-testid={`refundable-${r.paymentKey}`}>
                      <td className="py-2 whitespace-nowrap">
                        {r.approvedAt ? new Date(r.approvedAt).toLocaleString("ko-KR") : "—"}
                      </td>
                      <td>{r.studentName ?? "—"}</td>
                      <td>{r.className ?? "—"}</td>
                      <td>{r.paymentMonth}</td>
                      <td className="text-right">{r.amount.toLocaleString()}</td>
                      <td className="text-right text-amber-700">
                        {r.refunded > 0 ? r.refunded.toLocaleString() : "—"}
                      </td>
                      <td className="text-right font-medium">
                        {r.refundable > 0 ? r.refundable.toLocaleString() : "—"}
                      </td>
                      <td className="text-right">
                        {r.refundable > 0 ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openRefund(r)}
                            data-testid={`refund-button-${r.paymentKey}`}
                          >
                            환불
                          </Button>
                        ) : (
                          <Badge className="bg-slate-100 text-slate-800">전액 환불됨</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 환불 다이얼로그 */}
      <Dialog open={!!refundTarget} onOpenChange={(o) => !o && setRefundTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>환불 기록</DialogTitle>
          </DialogHeader>
          {refundTarget && (
            <div className="space-y-4">
              <div className="rounded-md bg-slate-50 p-3 text-sm">
                <div>
                  <b>{refundTarget.studentName ?? "—"}</b> · {refundTarget.className ?? "—"} ·{" "}
                  {refundTarget.paymentMonth}
                </div>
                <div className="mt-1 text-muted-foreground">
                  승인 {refundTarget.amount.toLocaleString()}원
                  {refundTarget.refunded > 0 && <> · 이미 환불 {refundTarget.refunded.toLocaleString()}원</>}
                  {" · "}
                  <span className="font-medium text-slate-900">
                    환불 가능 {refundTarget.refundable.toLocaleString()}원
                  </span>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium">환불 금액 (원)</label>
                <Input
                  type="number"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  max={refundTarget.refundable}
                  min={1}
                  data-testid="refund-amount-input"
                />
                {/* 부분 환불(중도 퇴원 정산)이 실제로 있으므로 금액을 고정하지 않는다.
                    대신 한도를 넘기면 서버에 보내기 전에 화면에서 먼저 잡아 준다. */}
                {!refundAmountValid && refundAmount !== "" && (
                  <div className="mt-1 text-xs text-red-600">
                    1원 이상 {refundTarget.refundable.toLocaleString()}원 이하의 정수여야 합니다.
                  </div>
                )}
              </div>

              <div>
                <label className="text-sm font-medium">사유 (선택)</label>
                <Input
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="예: 중도 퇴원 정산, 이중 결제"
                  maxLength={200}
                  data-testid="refund-reason-input"
                />
              </div>

              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                토스에서 실제 카드 취소를 이미 완료했는지 확인하세요. 이 기록만으로는 돈이
                돌아가지 않습니다.
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefundTarget(null)}>
              닫기
            </Button>
            <Button
              disabled={!refundAmountValid || refundMutation.isPending}
              onClick={() =>
                refundTarget &&
                refundMutation.mutate({
                  paymentKey: refundTarget.paymentKey,
                  amount: refundAmountNum,
                  reason: refundReason.trim(),
                })
              }
              data-testid="refund-submit"
            >
              {refundMutation.isPending ? "기록 중…" : "환불 기록"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      {/* 플러그인 로그 뷰어 */}
      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Front 플러그인 로그</DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              최근 {pluginLogs?.logs.length ?? 0}건 (서버 보관 {pluginLogs?.total ?? 0}건) · 5초마다 갱신
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => clearLogsMutation.mutate()}
              disabled={clearLogsMutation.isPending}
            >
              비우기
            </Button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto rounded border">
            {!pluginLogs || pluginLogs.logs.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                아직 들어온 로그가 없습니다. 단말기에서 EduSyncPro 플러그인을 실행하면 여기에
                한 줄씩 쌓입니다. 실행했는데도 계속 비어 있다면 플러그인 스크립트 자체가 로드되지
                않은 것입니다 (ZIP 을 다시 올려 주세요).
              </div>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {pluginLogs.logs.map((l, i) => (
                    <tr key={i} className="border-b last:border-0 align-top">
                      <td className="py-1.5 px-2 whitespace-nowrap text-muted-foreground">
                        {new Date(l.receivedAt).toLocaleTimeString("ko-KR")}
                      </td>
                      <td className="py-1.5 px-2">
                        <Badge
                          className={
                            l.level === "error"
                              ? "bg-red-100 text-red-800"
                              : l.level === "warn"
                                ? "bg-amber-100 text-amber-800"
                                : "bg-slate-100 text-slate-800"
                          }
                        >
                          {l.level}
                        </Badge>
                      </td>
                      <td className="py-1.5 px-2 font-mono whitespace-nowrap">{l.event}</td>
                      <td className="py-1.5 px-2 break-all">{l.message}</td>
                      <td className="py-1.5 px-2 whitespace-nowrap text-muted-foreground">
                        {l.pluginVersion ?? ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setLogsOpen(false)}>닫기</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 100원 테스트 결제 */}
      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>100원 테스트 결제</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              단말기까지 결제가 실제로 도달하는지 확인하는 용도입니다. 금액은 서버가 100원으로
              고정하며, 청구월이 <span className="font-mono">TEST-…</span> 로 기록되어 학생의 월별
              미납 계산에는 들어가지 않습니다. 학생 태블릿에는 이 버튼이 보이지 않습니다.
            </p>
            <div>
              <label className="text-xs text-muted-foreground">대상 수강 등록</label>
              <select
                value={testEnrollmentId}
                onChange={(e) => setTestEnrollmentId(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">선택하세요</option>
                {testCandidates.map((c) => (
                  <option key={c.enrollmentId} value={c.enrollmentId}>
                    {c.studentName}
                    {c.className ? ` · ${c.className}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">보낼 결제 단말기</label>
              <select
                value={testDeviceId}
                onChange={(e) => setTestDeviceId(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">자동 (최근 접속한 활성 단말기)</option>
                {devices.filter((d) => d.isActive).map((d) => (
                  <option key={d.id} value={d.id}>{d.displayName}</option>
                ))}
              </select>
            </div>
            <p className="text-xs text-amber-700">
              Railway 환경변수에 <span className="font-mono">TOSS_FRONT_TEST_PAYMENT=on</span> 이
              없으면 서버가 거절합니다. 테스트가 끝나면 이 값을 지우세요.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestOpen(false)}>취소</Button>
            <Button
              disabled={!testEnrollmentId || testPaymentMutation.isPending}
              onClick={() => testPaymentMutation.mutate()}
            >
              100원 결제 보내기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 등록 다이얼로그 */}
      <Dialog open={enrollOpen} onOpenChange={(v) => (!v ? closeEnrollDialog() : setEnrollOpen(v))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 단말기 등록</DialogTitle>
          </DialogHeader>
          {!issuedKey && !issuedPairing ? (
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
            <div className="space-y-4">
              <p className="text-sm font-medium">
                단말기 페어링 코드가 발급됐습니다.{" "}
                <span className="text-red-600">이 창을 닫으면 다시 볼 수 없습니다.</span>
              </p>

              {issuedPairing && (
                <>
                  <div className="rounded-lg border-2 border-orange-300 bg-orange-50 p-4 space-y-3">
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">매장 코드</div>
                      <div className="font-mono text-3xl font-bold tracking-widest text-orange-700">
                        {issuedPairing.code}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">PIN (4자리)</div>
                      <div className="font-mono text-3xl font-bold tracking-widest text-orange-700">
                        {issuedPairing.pin}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground pt-1 border-t border-orange-200">
                      유효기간: {issuedPairing.expiresInHours}시간 (
                      {new Date(issuedPairing.expiresAt).toLocaleString("ko-KR")} 까지)
                    </div>
                  </div>
                  <p className="text-sm text-slate-700">
                    태블릿(결제 단말기) 첫 부팅 화면에서 위 <b>매장 코드</b> 와 <b>PIN</b> 을
                    각각 입력하세요. 태블릿이 자기 시리얼 번호를 함께 서버로 보내 페어링을 완료합니다.
                  </p>
                </>
              )}

              {issuedKey && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowRawFallback((v) => !v)}
                    className="text-xs text-muted-foreground underline hover:text-slate-700"
                  >
                    {showRawFallback ? "▲ 관리자용 raw deviceKey 숨기기" : "▼ 관리자용 raw deviceKey 보기 (권장 X)"}
                  </button>
                  {showRawFallback && (
                    <div className="mt-2 space-y-2">
                      <div className="p-3 bg-slate-100 rounded font-mono text-xs break-all">
                        {issuedKey}
                      </div>
                      <p className="text-xs text-amber-700">
                        플러그인 구버전 또는 exchange API 를 사용할 수 없는 상황에서만
                        태블릿에 이 원문 키를 직접 붙여넣으세요.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <DialogFooter>
                <Button onClick={closeEnrollDialog}>확인</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 태블릿 등록 다이얼로그 */}
      <Dialog open={kioskEnrollOpen} onOpenChange={(v) => (!v ? closeKioskDialog() : setKioskEnrollOpen(v))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>새 태블릿 등록</DialogTitle>
          </DialogHeader>
          {!issuedKioskKey ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                태블릿 이름과, 이 태블릿의 결제요청을 어느 결제 단말기로 보낼지 선택하세요.
              </p>
              <Input
                value={kioskName}
                onChange={(e) => setKioskName(e.target.value)}
                placeholder="태블릿 이름 (예: 카운터 옆 태블릿)"
              />
              <select
                value={kioskPairedFrontId}
                onChange={(e) => setKioskPairedFrontId(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">자동 라우팅 (활성 결제 단말기 중 최근 접속)</option>
                {devices.filter((d) => d.isActive).map((d) => (
                  <option key={d.id} value={d.id}>{d.displayName}</option>
                ))}
              </select>
              <DialogFooter>
                <Button variant="outline" onClick={closeKioskDialog}>취소</Button>
                <Button
                  disabled={!kioskName.trim() || enrollKioskMutation.isPending}
                  onClick={() =>
                    enrollKioskMutation.mutate({
                      displayName: kioskName.trim(),
                      pairedFrontDeviceId: kioskPairedFrontId || undefined,
                    })
                  }
                >
                  발급
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-medium">
                kioskKey 가 발급됐습니다.{" "}
                <span className="text-red-600">이 창을 닫으면 다시 볼 수 없습니다.</span>
              </p>
              <div className="p-3 bg-slate-100 rounded font-mono text-xs break-all">{issuedKioskKey}</div>
              <p className="text-xs text-muted-foreground">
                태블릿에서 <span className="font-mono">/student-kiosk/setup</span> 을 열고 이 값을 붙여넣으세요.
              </p>
              <DialogFooter>
                <Button onClick={closeKioskDialog}>확인</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
