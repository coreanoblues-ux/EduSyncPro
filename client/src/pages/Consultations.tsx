/**
 * 상담/문의 목록
 *
 * AI 입력으로 저장한 상담 기록이 여기 쌓인다.
 * 상담문의 → 대기등록 → 최종등록으로 이어지는 흐름을 이 화면에서 끝낼 수 있도록,
 * 목록에서 바로 학생·수강 등록을 만드는 "학생으로 등록"을 함께 둔다.
 */

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MessageSquare,
  Phone,
  Search,
  Trash2,
  UserPlus,
  CalendarClock,
  Pencil,
  FileText,
  Printer,
  MessageSquarePlus,
  Users,
  Mic,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { LevelTestShare } from "@/components/LevelTestShare";
import { labelClassesByTeacher } from "@shared/classLabel";
import { groupLevelTestsByConsultation } from "@shared/levelTestMatch";
import {
  openLevelTestApp,
  openLevelTestEdit,
  openLevelTestForConsultation,
  openLevelTestPrintForConsultation,
  useLevelTests,
  type LevelTestRow,
} from "@/hooks/useLevelTests";
import {
  recommendClasses,
  topCandidates,
  type ClassCandidate,
  type RecommendClass,
  type RecommendMember,
} from "@shared/classRecommend";
import type { Consultation, Class, Teacher, Student, Enrollment } from "@shared/schema";

/**
 * 원장이 이 다이얼로그에서 반을 고르는 순서. 개수순 대신 이 순서를 우선한다.
 * 페이지원 영어학원 사정: 정우석 → 김명근 → 고은채 순으로 상담 전환이 몰린다.
 * 정우석 선생님 안에서는 월수 → 화목 → 주말 순으로 살펴보시니 스케줄까지 맞춘다.
 */
const CONSULTATION_TEACHER_ORDER = ["정우석", "김명근", "고은채"];
const CONSULTATION_SCHEDULE_ORDER = ["월수", "화목", "주말"];

type Status =
  | "상담문의"
  | "레벨테스트예정"
  | "레벨테스트완료"
  | "반배정상담"
  | "대기등록"
  | "최종등록"
  | "보류";

const STATUSES: Status[] = [
  "상담문의",
  "레벨테스트예정",
  "레벨테스트완료",
  "반배정상담",
  "대기등록",
  "최종등록",
  "보류",
];

/**
 * 목록에 쌓이는 순서. 실제 상담 흐름 순서대로 배치한다.
 * (상담문의 → 레벨테스트예정 → 레벨테스트완료 → 반배정상담 → 대기/최종 → 보류)
 * 각 단계에서 사람이 새지 않게 원장이 대시보드에서 바로 볼 수 있어야 매출 손실이 줄어든다.
 */
const GROUP_ORDER: Status[] = [
  "상담문의",
  "레벨테스트예정",
  "레벨테스트완료",
  "반배정상담",
  "대기등록",
  "최종등록",
  "보류",
];

const GROUP_HINT: Record<Status, string> = {
  상담문의: "연락은 왔지만 아직 아무것도 정해지지 않은 건",
  레벨테스트예정: "테스트 일정이 잡힌 건 — 하루 전에 확인 연락 필요",
  레벨테스트완료: "결과가 나온 건 — 반배정 상담을 잡아야 함",
  반배정상담: "결과를 놓고 반을 정하는 중",
  대기등록: "자리가 나면 등록하기로 한 건",
  최종등록: "등록이 끝난 건 — 7일이 지나면 목록에서 사라집니다",
  보류: "진행이 멈춘 건",
};

/**
 * 최종등록이 목록에 남아 있는 기간(일).
 *
 * 등록이 끝나도 며칠은 보여야 원장이 "이번 주에 누가 들어왔지"를 확인할 수 있다.
 * 그 뒤로는 학생 관리에서 보면 되므로 상담 목록에서 치운다. 데이터는 그대로 있고
 * 화면에서만 감춘다.
 */
const FINAL_VISIBLE_DAYS = 7;

function daysSince(value: string | Date, now: number): number {
  return (now - new Date(value).getTime()) / (1000 * 60 * 60 * 24);
}

const STATUS_STYLE: Record<Status, string> = {
  상담문의: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  레벨테스트예정: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  레벨테스트완료: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  반배정상담: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  대기등록: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  최종등록: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  보류: "bg-muted text-muted-foreground",
};

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDate(value: string | Date): string {
  const d = new Date(value);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 레벨테스트 앱에 저장된 결과지 한 건.
 *
 * ── 왜 상담 화면에 다시 그리는가 ──
 *   원장이 학부모와 통화하는 순간에 보는 화면은 상담 카드다. 그 자리에서
 *   "이 학생 점수가 몇 점이었지"를 알려면 지금까지는 레벨테스트 기록 화면으로
 *   건너가서 이름으로 다시 찾아야 했다. 통화 중에 할 만한 일이 아니다.
 *
 * ── 채점 중인 기록도 숨기지 않는다 ──
 *   미채점이 남아 있으면 totalScore 가 null 로 온다. 그런 건을 감추면 원장은
 *   "저장이 안 됐나" 로 받아들인다. 점수 자리에 "채점 중" 이라고 적어 보여 준다.
 */
function LevelTestResult({ row }: { row: LevelTestRow }) {
  const scores: [string, number | null][] = [
    ["독해", row.readingScore],
    ["문법", row.grammarScore],
    ["어휘", row.vocabScore],
    ["서술형", row.writingScore],
  ];
  const grading = row.totalScore == null || !!row.pendingCount;

  return (
    <div
      className="rounded-md border bg-background px-3 py-2 space-y-2"
      data-testid={`consultation-level-test-${row.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{row.testDate}</span>
        <span className="text-sm text-muted-foreground">{row.examTitle}</span>
        {grading ? (
          <Badge variant="outline">채점 중{row.pendingCount ? ` · 미채점 ${row.pendingCount}` : ""}</Badge>
        ) : (
          <Badge variant="secondary" className="tabular-nums">
            총점 {row.totalScore}점
          </Badge>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => openLevelTestApp(row.id)}
          data-testid={`button-open-result-${row.id}`}
        >
          <Printer className="h-4 w-4 mr-1" />
          결과지 열기
        </Button>
      </div>

      {/*
        학부모에게 보낼 링크·메시지. 결과지 줄 안에 두는 이유: 원장이
        "이 결과를 보내야겠다" 고 판단하는 순간은 점수를 보고 있는 순간이다.
        규칙은 client/src/components/LevelTestShare.tsx 참조.
      */}
      <div className="flex flex-wrap items-center gap-2 border-t pt-2">
        <LevelTestShare row={row} />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {scores.map(([label, value]) => (
          <span key={label}>
            {label} <span className="font-semibold tabular-nums text-foreground">{value == null ? "-" : value}</span>
          </span>
        ))}
        <span>
          정답 {row.correctCount ?? 0}/{row.questionCount ?? 0}
        </span>
        {row.teacherName && <span>담당 {row.teacherName}</span>}
      </div>

      {row.notes && <p className="text-xs text-muted-foreground border-t pt-1">메모: {row.notes}</p>}
    </div>
  );
}

/** 검색 상자가 레벨테스트 쪽 글자도 찾을 수 있게, 한 건을 검색용 문자열로 펼친다. */
function levelTestSearchText(row: LevelTestRow): string {
  return [row.studentName, row.school, row.grade, row.examTitle, row.teacherName, row.testDate, row.notes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * 통화 녹음 직접 업로드 (POST /api/call-intake).
 *
 * 폰 웹앱에 로그인돼 있으면 토큰 없이 여기서 바로 올릴 수 있다 — 흔들기
 * 자동화(매크로드로이드)가 실패했거나 폰을 안 흔들었을 때의 수동 입구.
 * 녹음 파일은 서버 메모리에서만 처리되고 어디에도 저장되지 않는다.
 *
 * 전화번호는 파일 이름에서 먼저 찾는다 — 갤럭시 통화 녹음 파일명에는
 * "통화 녹음 이름_010-1234-5678_..." 처럼 상대 번호가 들어 있다.
 * 못 찾으면 올리기 전에 한 번 물어본다 (번호가 상담 기록의 기준 키라서).
 */
function CallIntakeUpload() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    const m = f.name.replace(/[-.\s]/g, "").match(/01[016789]\d{7,8}/);
    setPhone(m ? m[0] : "");
    setPending(f);
  };

  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", pending, pending.name);
      const q = phone.trim() ? `?phone=${encodeURIComponent(phone.trim())}` : "";
      const r = await fetch(`/api/call-intake${q}`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      const j = await r.json().catch(() => ({}) as any);
      if (!r.ok || j.status === "error") {
        throw new Error(j.message || j.error || `HTTP ${r.status}`);
      }
      toast({
        title: j.status === "skipped" ? "상담 통화가 아니었습니다" : "통화 내용을 등록했습니다",
        description: j.message,
      });
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      setPending(null);
    } catch (e) {
      toast({ title: "통화 등록 실패", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,video/*,.m4a,.mp3,.amr,.3gp,.ogg,.wav"
        className="hidden"
        onChange={(e) => pickFile(e.target.files?.[0])}
        data-testid="input-call-intake-file"
      />
      <Button
        variant="outline"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        data-testid="button-call-intake-upload"
      >
        <Mic className="h-4 w-4 mr-2" />
        통화 녹음 올리기
      </Button>

      <Dialog open={!!pending} onOpenChange={(open) => !open && !busy && setPending(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>통화 녹음 자동 등록</DialogTitle>
            <DialogDescription>
              음성인식 후 AI가 상담 내용을 정리해 «확인 필요» 상태로 저장합니다. 녹음
              파일 자체는 서버에 저장되지 않습니다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground break-all">파일: {pending?.name}</div>
            <div className="space-y-1.5">
              <Label htmlFor="call-intake-phone">상대방 전화번호</Label>
              <Input
                id="call-intake-phone"
                placeholder="010-1234-5678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                data-testid="input-call-intake-phone"
              />
              <p className="text-xs text-muted-foreground">
                파일 이름에서 자동으로 찾았으면 미리 채워집니다. 번호가 있어야 같은
                학부모의 기존 상담에 붙습니다.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={busy}>
              취소
            </Button>
            <Button onClick={submit} disabled={busy} data-testid="button-call-intake-submit">
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  분석 중... (최대 1분)
                </>
              ) : (
                "올리고 분석하기"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * 반배정 후보 칸.
 *
 * ── 왜 "추천" 이 아니라 "근거" 를 보여 주는가 ──
 *   반배정은 학생의 1년을 좌우하고, 숫자에 안 잡히는 사정(형제가 같은 반,
 *   셔틀 시간, 성격)이 늘 끼어든다. 그래서 규칙이 단정하지 않고, 왜 그렇게
 *   봤는지를 한국어로 적어 원장이 뒤집을 수 있게 둔다. 판단 규칙은
 *   shared/classRecommend.ts 에 있다.
 *
 * ── 정원이 여기 같이 나오는 이유 ──
 *   "추천했는데 자리가 없다" 가 생기지 않게 하려면 추천과 정원을 같은 자리에서
 *   봐야 한다. 자리가 없는 반도 목록에 남긴다 — 자리만 나면 그 반인 경우가
 *   있고, 그게 대기 등록을 결정하는 근거가 된다.
 */
function ClassFitPanel({
  candidates,
  recommendedClassId,
  onPick,
  onWaitlist,
  busy,
}: {
  candidates: ClassCandidate[];
  recommendedClassId: string | null;
  onPick: (classId: string) => void;
  onWaitlist: (candidate: ClassCandidate) => void;
  busy: boolean;
}) {
  if (!candidates.length) return null;
  return (
    <div className="rounded-md border px-3 py-2 space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Users className="h-3.5 w-3.5" />
        반배정 후보 (근거를 보고 원장이 정합니다)
      </div>
      {candidates.map((c) => {
        const picked = c.classId === recommendedClassId;
        const full = c.fit === "정원초과";
        return (
          <div
            key={c.classId}
            className={`rounded border px-2 py-2 text-sm space-y-1 ${
              picked ? "border-primary bg-primary/5" : ""
            }`}
            data-testid={`class-candidate-${c.classId}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{c.name}</span>
              {c.schedule && <Badge variant="outline">{c.schedule}</Badge>}
              <Badge variant={full ? "destructive" : c.fit === "추천" ? "default" : "secondary"}>
                {c.fit}
              </Badge>
              {c.seats.max != null && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {c.seats.taken}/{c.seats.max}명
                </span>
              )}
              {picked && <Badge variant="outline">현재 추천반</Badge>}
              <span className="ml-auto flex items-center gap-1">
                {!picked && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onPick(c.classId)}
                    data-testid={`button-pick-class-${c.classId}`}
                  >
                    이 반으로
                  </Button>
                )}
                {full && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => onWaitlist(c)}
                    data-testid={`button-waitlist-${c.classId}`}
                  >
                    대기 등록
                  </Button>
                )}
              </span>
            </div>
            {c.reasons.map((r) => (
              <div key={r} className="text-xs text-muted-foreground">
                · {r}
              </div>
            ))}
            {c.cautions.map((r) => (
              <div key={r} className="text-xs text-amber-700 dark:text-amber-500">
                ! {r}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

interface ConsultationsProps {
  userRole: "owner" | "teacher" | "superadmin";
}

export default function Consultations({ userRole }: ConsultationsProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showStale, setShowStale] = useState(false);
  const [enrollTarget, setEnrollTarget] = useState<Consultation | null>(null);
  const [form, setForm] = useState({ name: "", grade: "", classId: "", startDate: today(), dueDay: "8" });

  // 레벨테스트 예약/기록 다이얼로그. 하나의 대화상자가 "예약"과 "결과 기록" 두 모드로 동작한다.
  // 상담문의 → 레벨테스트예정: 날짜만 잡는다.
  // 레벨테스트예정 → 레벨테스트완료: 점수·메모·추천반을 입력한다.
  const [levelTestTarget, setLevelTestTarget] = useState<Consultation | null>(null);
  const [ltForm, setLtForm] = useState({
    date: "",
    score: "",
    notes: "",
    recommendedClassId: "",
  });
  const ltMode: "schedule" | "record" = levelTestTarget?.status === "레벨테스트예정" ? "record" : "schedule";

  // 메모/후속조치/과목/연락처 수정 다이얼로그. 원장이 각 단계에서 상담 내용을 직접 다듬을 수 있게 한다.
  // phone: 급하게 입력하느라 사전에 못 넣은 보호자 연락처를 나중에 추가할 수 있게 한다.
  const [editTarget, setEditTarget] = useState<Consultation | null>(null);
  const [editForm, setEditForm] = useState({ studentName: "", subject: "", followUp: "", memo: "", phone: "" });

  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: consultations = [], isLoading } = useQuery<Consultation[]>({
    queryKey: ["/api/consultations"],
  });
  const { data: classes = [] } = useQuery<Class[]>({ queryKey: ["/api/classes"] });
  const { data: teachers = [] } = useQuery<Teacher[]>({ queryKey: ["/api/teachers"] });

  /**
   * 반배정 추천·정원을 계산하려고 읽는다.
   *
   * 왜 학생·수강 목록까지 읽는가: "그 반에 지금 몇 명이 있고 몇 학년인가" 를
   * 알아야 정원과 학년을 말할 수 있다. maxStudents 칸은 지금까지 화면에
   * "(최대 20명)" 으로 적히기만 했고 실제 인원과 비교된 적이 없었다.
   *
   * 두 목록은 학생 관리 화면이 이미 쓰는 것과 같은 캐시 키라, 대부분의 경우
   * 추가 요청 없이 캐시에서 온다.
   */
  const { data: students = [] } = useQuery<Student[]>({ queryKey: ["/api/students"] });
  const { data: enrollments = [] } = useQuery<Enrollment[]>({ queryKey: ["/api/enrollments"] });

  /** 반별 재원생(학년 포함). 추천 규칙이 "이 반은 몇 학년 반인가" 를 읽는 근거다. */
  const classMembers = useMemo<RecommendMember[]>(() => {
    const gradeOf = new Map(students.map((s) => [s.id, s] as const));
    return enrollments.map((e) => {
      const s = gradeOf.get(e.studentId);
      return {
        classId: e.classId,
        grade: s?.grade ?? null,
        school: s?.school ?? null,
        // 퇴원생·종료된 수강은 자리를 차지하지 않는다.
        isActive: e.isActive !== false && s?.isActive !== false,
      };
    });
  }, [students, enrollments]);

  const recommendInputClasses = useMemo<RecommendClass[]>(
    () =>
      classes.map((c) => ({
        id: c.id,
        name: c.name,
        subject: c.subject,
        schedule: c.schedule,
        maxStudents: c.maxStudents,
        isActive: c.isActive !== false,
      })),
    [classes]
  );

  /**
   * 레벨테스트 앱이 저장한 결과지.
   *
   * 조회가 실패해도 상담 목록은 그대로 보여야 한다. 그래서 isError 를 화면에
   * 띄우지 않고 빈 배열로 떨어뜨린다 — 상담 관리는 레벨테스트와 무관하게
   * 원장이 매일 쓰는 화면이고, 여기서 에러 박스를 띄워 가릴 이유가 없다.
   * (레벨테스트 기록 화면에서는 같은 실패를 분명하게 보여 준다.)
   */
  const { data: levelTests = [] } = useLevelTests();

  /**
   * 상담 건 ↔ 결과지 짝 맞추기. 규칙은 shared/levelTestMatch.ts 에 있다
   * (이름으로 맞추고, 연락처가 양쪽에 있는데 다르면 동명이인으로 보고 잇지 않는다).
   */
  const { byConsultation, unmatched } = useMemo(
    () => groupLevelTestsByConsultation(consultations, levelTests),
    [consultations, levelTests]
  );

  /**
   * 상담 건별 반배정 후보. 판단 규칙은 shared/classRecommend.ts 에 있다.
   *
   * ── 어느 건에만 계산하는가 ──
   *   아직 학생이 아닌(studentId 없는) 건 중에서 레벨테스트완료 · 반배정상담 ·
   *   대기등록 단계만. 상담문의/레벨테스트예정 단계에 띄우면 아직 아무 근거도
   *   없는 추천을 들이대는 셈이고, 최종등록은 이미 반이 정해진 건이다.
   *
   * ── 점수는 어느 결과지에서 가져오는가 ──
   *   그 상담에 붙은 결과지 중 "채점이 끝난 가장 최근 것" 하나. 재테스트를 봤으면
   *   옛 점수로 반을 고르면 안 되고, 채점이 덜 끝난 결과지의 숫자는 아직 숫자가
   *   아니다. 결과지가 없으면 학년만으로 줄을 세운다 — 그래도 정원은 맞게 보인다.
   */
  const candidatesByConsultation = useMemo(() => {
    const out = new Map<string, ClassCandidate[]>();
    for (const c of consultations) {
      if (c.studentId) continue;
      if (c.status !== "레벨테스트완료" && c.status !== "반배정상담" && c.status !== "대기등록") continue;

      const graded = (byConsultation[c.id] ?? [])
        .filter((r) => r.totalScore != null && (r.pendingCount ?? 0) === 0)
        .sort((a, b) => String(b.testDate).localeCompare(String(a.testDate)));
      const newest = graded[0];

      const all = recommendClasses({
        student: {
          grade: c.studentGrade ?? newest?.grade ?? null,
          school: newest?.school ?? null,
          totalScore: newest?.totalScore ?? null,
          readingScore: newest?.readingScore ?? null,
          grammarScore: newest?.grammarScore ?? null,
          vocabScore: newest?.vocabScore ?? null,
          writingScore: newest?.writingScore ?? null,
        },
        classes: recommendInputClasses,
        members: classMembers,
      });
      out.set(c.id, topCandidates(all, 3));
    }
    return out;
  }, [consultations, byConsultation, recommendInputClasses, classMembers]);

  // 학생 전환·추천반 드롭다운에서 쓸 반 목록.
  // 강사 표기([김], [정], [고] 등)를 자동으로 붙이고, 원장이 자주 고르는 강사·요일 순으로 정렬한다.
  const activeClassOptions = useMemo(
    () =>
      labelClassesByTeacher(
        classes.filter((c) => c.isActive !== false),
        teachers,
        { teacherOrder: CONSULTATION_TEACHER_ORDER, scheduleOrder: CONSULTATION_SCHEDULE_ORDER }
      ),
    [classes, teachers]
  );

  const counts = useMemo(() => {
    const acc: Record<string, number> = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const c of consultations) acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, [consultations]);

  // 7일이 지난 최종등록. 감춰 두되 몇 건인지는 알려주고 펼쳐 볼 수 있게 한다.
  const staleFinal = useMemo(() => {
    const now = Date.now();
    return consultations.filter(
      (c) => c.status === "최종등록" && daysSince(c.updatedAt, now) > FINAL_VISIBLE_DAYS
    );
  }, [consultations]);

  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const staleIds = new Set(staleFinal.map((c) => c.id));

    const matched = consultations
      .filter((c) => statusFilter === "all" || c.status === statusFilter)
      .filter((c) => showStale || !staleIds.has(c.id))
      .filter((c) => {
        if (!term) return true;
        if (
          [c.studentName, c.guardianName, c.phone, c.subject, c.memo]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(term))
        )
          return true;
        // 레벨테스트 쪽 글자(시험지 이름·학교·담당 선생님)로도 찾을 수 있게 한다.
        // 원장이 "그날 Level 3 본 애" 처럼 기억하는 경우가 있다.
        return (byConsultation[c.id] ?? []).some((r) => levelTestSearchText(r).includes(term));
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return GROUP_ORDER.map((status) => ({
      status,
      items: matched.filter((c) => c.status === status),
    })).filter((g) => g.items.length > 0);
  }, [consultations, search, statusFilter, showStale, staleFinal, byConsultation]);

  const visibleCount = groups.reduce((sum, g) => sum + g.items.length, 0);

  /**
   * 상담 기록이 없는 레벨테스트. 검색어가 있으면 같은 말로 걸러 준다.
   *
   * 이 목록을 따로 내보내는 이유: 워크인으로 와서 테스트만 보고 간 학생은
   * 상담 행이 없어 지금까지 상담 관리 화면에서 아예 보이지 않았다. 등록
   * 전환이 가장 아쉬운 사람들이 제일 안 보이던 셈이다.
   */
  const unmatchedVisible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return unmatched;
    return unmatched.filter((r) => levelTestSearchText(r).includes(term));
  }, [unmatched, search]);

  /**
   * 통화 자동등록 건의 "확인 완료". needsReview 플래그만 끈다.
   * 상태(퍼널 단계)는 건드리지 않는다 — 확인과 진행은 별개의 일이다.
   */
  const reviewMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("PATCH", `/api/consultations/${id}`, { needsReview: false });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      toast({ title: "확인 완료로 표시했습니다" });
    },
    onError: (err: Error) => {
      toast({ title: "표시 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: Status }) => {
      await apiRequest("PATCH", `/api/consultations/${id}`, { status });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
    },
    onError: (err: Error) => {
      toast({ title: "상태 변경 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  /**
   * 반배정 후보에서 "이 반으로" 를 누를 때.
   *
   * 상태도 같이 반배정상담으로 옮긴다. 추천반만 적어 두고 상태가 레벨테스트완료에
   * 남아 있으면, 자동 할 일(놓친 자리 찾기)이 "반배정 상담을 잡으세요" 를 계속
   * 적게 된다 — 이미 한 일을 재촉하는 소음이 된다.
   */
  const pickClassMutation = useMutation({
    mutationFn: async ({ id, classId, status }: { id: string; classId: string; status: Status }) => {
      await apiRequest("PATCH", `/api/consultations/${id}`, {
        recommendedClassId: classId,
        ...(status === "레벨테스트완료" ? { status: "반배정상담" as Status } : {}),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      toast({ title: "추천반을 적었습니다" });
    },
    onError: (err: Error) => {
      toast({ title: "추천반 지정 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  /**
   * 자리가 없는 반에 "대기 등록".
   *
   * 대기자 표(waiters)는 지금까지 적어 두기만 하고 아무도 다시 보지 않았다.
   * 이제 자리가 나면 자동 할 일이 알려 주므로(server/lib/funnelWatch.ts 규칙 7),
   * 여기에 적는 것이 실제로 연락으로 이어진다.
   */
  const waitlistMutation = useMutation({
    mutationFn: async ({
      consultation,
      candidate,
    }: {
      consultation: Consultation;
      candidate: ClassCandidate;
    }) => {
      await apiRequest("POST", "/api/waiters", {
        classId: candidate.classId,
        name: consultation.studentName || consultation.guardianName || "이름 미기재",
        phone: consultation.phone ?? null,
        notes: `상담 기록에서 등록 (${candidate.name})`,
      });
      // 상담 상태도 대기등록으로 옮긴다. 두 곳이 어긋나면 어느 쪽이 맞는지 알 수 없다.
      await apiRequest("PATCH", `/api/consultations/${consultation.id}`, {
        status: "대기등록" as Status,
        recommendedClassId: candidate.classId,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      qc.invalidateQueries({ queryKey: ["/api/waiters"] });
      toast({ title: "대기자로 등록했습니다", description: "자리가 나면 할 일 목록에 알려 드립니다." });
    },
    onError: (err: Error) => {
      toast({ title: "대기 등록 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/consultations/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      toast({ title: "상담 기록이 삭제되었습니다" });
    },
    onError: (err: Error) => {
      toast({ title: "삭제 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const levelTestMutation = useMutation({
    mutationFn: async ({ id, mode }: { id: string; mode: "schedule" | "record" }) => {
      if (mode === "schedule") {
        // datetime-local 값은 로컬 시각으로 해석된다. 서버는 timestamp(without tz)에 그대로 저장한다.
        await apiRequest("PATCH", `/api/consultations/${id}`, {
          status: "레벨테스트예정",
          levelTestDate: ltForm.date ? new Date(ltForm.date).toISOString() : null,
        });
      } else {
        await apiRequest("PATCH", `/api/consultations/${id}`, {
          status: "레벨테스트완료",
          levelTestScore: ltForm.score.trim() || null,
          levelTestNotes: ltForm.notes.trim() || null,
          recommendedClassId: ltForm.recommendedClassId || null,
        });
      }
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      setLevelTestTarget(null);
      toast({
        title: vars.mode === "schedule" ? "레벨테스트 일정이 저장되었습니다" : "레벨테스트 결과가 저장되었습니다",
      });
    },
    onError: (err: Error) => {
      toast({ title: "저장 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  /**
   * 결과지만 있고 상담 행이 없는 학생에게 상담 기록을 만들어 준다.
   *
   * ── 왜 버튼 한 번으로 만드는가 ──
   *   이름·학년·연락처·점수는 이미 결과지 안에 다 있다. 원장이 그걸 보고
   *   상담 입력창에 손으로 옮겨 적는 동안 오타가 나면 이름이 어긋나 짝이
   *   안 맞고, 그러면 또 "왜 안 붙지" 가 된다. 같은 글자를 그대로 넣는다.
   *
   * ── consultationId 를 직접 박지 않는 이유 ──
   *   level_tests 를 수정하는 API 가 아직 없다(앱의 upsert 만 있다). 대신
   *   같은 이름·같은 연락처로 상담을 만들면 levelTestMatch 규칙이 바로
   *   짝지어 주므로, 서버를 건드리지 않고도 다음 렌더에서 붙는다.
   */
  const createFromLevelTest = useMutation({
    mutationFn: async (row: LevelTestRow) => {
      const domains = [
        ["독해", row.readingScore],
        ["문법", row.grammarScore],
        ["어휘", row.vocabScore],
        ["서술형", row.writingScore],
      ] as const;
      const breakdown = domains
        .filter(([, v]) => v != null)
        .map(([label, v]) => `${label} ${v}`)
        .join(" · ");

      await apiRequest("POST", "/api/consultations", {
        phone: row.parentPhone || null,
        studentName: row.studentName,
        studentGrade: row.grade || null,
        status: "레벨테스트완료",
        // testDate 는 YYYY-MM-DD 문자열이다. 그냥 Date 로 만들면 UTC 자정으로
        // 읽혀 한국 시간 기준 전날로 표시된다. 정오로 고정해 날짜가 밀리지 않게 한다.
        levelTestDate: new Date(`${row.testDate}T12:00:00`).toISOString(),
        levelTestScore: row.totalScore == null ? null : `${row.totalScore}점`,
        levelTestNotes: [row.examTitle, breakdown, row.school].filter(Boolean).join(" / ") || null,
        memo: row.notes || null,
        sourceText: `레벨테스트 기록에서 생성 (${row.testDate} ${row.examTitle})`,
      });
    },
    onSuccess: (_data, row) => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      toast({
        title: `${row.studentName} 상담 기록을 만들었습니다`,
        description: "레벨테스트완료 단계에 들어갔습니다. 반배정 상담을 잡아 주세요.",
      });
    },
    onError: (err: Error) => {
      toast({ title: "상담 기록 생성 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async (id: string) => {
      // 빈 문자열은 null로 보내 원본이 지워지도록 한다. 원장이 의도적으로 비우는 경우가 있음.
      await apiRequest("PATCH", `/api/consultations/${id}`, {
        studentName: editForm.studentName.trim() || null,
        subject: editForm.subject.trim() || null,
        followUp: editForm.followUp.trim() || null,
        memo: editForm.memo.trim() || null,
        phone: editForm.phone.trim() || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      setEditTarget(null);
      toast({ title: "상담 내용이 저장되었습니다" });
    },
    onError: (err: Error) => {
      toast({ title: "저장 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const openEdit = (c: Consultation) => {
    setEditForm({
      studentName: c.studentName ?? "",
      subject: c.subject ?? "",
      followUp: c.followUp ?? "",
      memo: c.memo ?? "",
      phone: c.phone ?? "",
    });
    setEditTarget(c);
  };

  const openLevelTest = (c: Consultation) => {
    // 예약 모드: 현재 값을 기본으로 (yyyy-MM-ddTHH:mm)
    let dateVal = "";
    if (c.levelTestDate) {
      const d = new Date(c.levelTestDate);
      dateVal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    setLtForm({
      date: dateVal,
      score: c.levelTestScore ?? "",
      notes: c.levelTestNotes ?? "",
      recommendedClassId: c.recommendedClassId ?? "",
    });
    setLevelTestTarget(c);
  };

  const enrollMutation = useMutation({
    mutationFn: async (consultation: Consultation) => {
      const res = await apiRequest("POST", "/api/students", {
        name: form.name.trim(),
        grade: form.grade.trim() || null,
        parentPhone: consultation.phone,
        notes: consultation.memo,
      });
      const student = await res.json();

      // tuition을 비우면 반의 기본 수강료가 적용된다
      await apiRequest("POST", "/api/enrollments", {
        studentId: student.id,
        classId: form.classId,
        startDate: form.startDate,
        dueDay: Number(form.dueDay) || 8,
      });

      // 상담 기록을 만들어진 학생에 연결해 둬야 나중에 어디서 온 학생인지 알 수 있다
      await apiRequest("PATCH", `/api/consultations/${consultation.id}`, {
        status: "최종등록",
        studentId: student.id,
        classId: form.classId,
        studentName: form.name.trim(),
        studentGrade: form.grade.trim() || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/consultations"] });
      qc.invalidateQueries({ queryKey: ["/api/students"] });
      qc.invalidateQueries({ queryKey: ["/api/enrollments"] });
      qc.invalidateQueries({ queryKey: ["/api/dashboard/students"] });
      setEnrollTarget(null);
      toast({ title: "학생 등록이 완료되었습니다", description: "학생 관리 화면에서 확인할 수 있습니다." });
    },
    onError: (err: Error) => {
      toast({ title: "등록 실패", description: err.message.replace(/^\d+:\s*/, ""), variant: "destructive" });
    },
  });

  const openEnroll = (c: Consultation) => {
    setForm({
      name: c.studentName ?? "",
      grade: c.studentGrade ?? "",
      classId: c.classId ?? "",
      startDate: today(),
      dueDay: "8",
    });
    setEnrollTarget(c);
  };

  const canEnroll = !!form.name.trim() && !!form.classId && !!form.startDate;
  const canEdit = userRole === "owner" || userRole === "teacher";

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-bold">상담 및 테스트 예약</h1>
        <div className="text-center py-8 text-muted-foreground">상담 기록을 불러오는 중...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6" data-testid="consultations-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">상담 및 테스트 예약</h1>
          <p className="text-muted-foreground">
            AI 입력으로 저장한 상담·문의 {consultations.length}건
            {levelTests.length > 0 && ` · 레벨테스트 결과지 ${levelTests.length}건`}
          </p>
        </div>
        {canEdit && <CallIntakeUpload />}
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7">
        {STATUSES.map((s) => (
          <Card key={s} className="hover-elevate">
            <CardContent className="pt-4 pb-4 text-center">
              <div className="text-xl font-bold">{counts[s] ?? 0}</div>
              <p className="text-xs text-muted-foreground">{s}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="이름, 연락처, 과목, 레벨테스트로 검색"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-consultation-search"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40" data-testid="select-status-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 상태</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {staleFinal.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            등록된 지 {FINAL_VISIBLE_DAYS}일이 지난 최종등록 {staleFinal.length}건은 목록에서
            숨겼습니다. 학생 관리에는 그대로 있습니다.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowStale((v) => !v)}
            data-testid="button-toggle-stale-final"
          >
            {showStale ? "다시 숨기기" : "숨긴 건 보기"}
          </Button>
        </div>
      )}

      {visibleCount === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-muted-foreground/25 rounded-lg">
          <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <div className="text-lg font-medium">
            {consultations.length === 0 ? "아직 상담 기록이 없습니다" : "조건에 맞는 상담이 없습니다"}
          </div>
          <p className="text-muted-foreground mt-2">
            {consultations.length === 0
              ? "대시보드의 AI 입력에 «010-1234-5678 김민준 중2 영어 문의»처럼 적어보세요."
              : "검색어나 상태 필터를 바꿔보세요."}
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
          <section key={group.status} className="space-y-4" data-testid={`consultation-group-${group.status}`}>
            <div className="flex items-baseline gap-2 border-b pb-2">
              <h2 className="text-lg font-semibold">{group.status}</h2>
              <span className="text-sm text-muted-foreground">{group.items.length}건</span>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                · {GROUP_HINT[group.status]}
              </span>
            </div>
          {group.items.map((c) => (
            <Card key={c.id} className="hover-elevate" data-testid={`consultation-card-${c.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-lg">{c.studentName || c.guardianName || "이름 미기재"}</CardTitle>
                    <Badge className={STATUS_STYLE[c.status as Status]} variant="outline">
                      {c.status}
                    </Badge>
                    {c.needsReview && (
                      <Badge
                        className="bg-amber-100 text-amber-900 border-amber-400 dark:bg-amber-950 dark:text-amber-200"
                        variant="outline"
                        data-testid={`badge-needs-review-${c.id}`}
                      >
                        통화 자동등록 · 확인 필요
                      </Badge>
                    )}
                    {c.studentGrade && <Badge variant="secondary">{c.studentGrade}</Badge>}
                    {c.subject && <Badge variant="outline">{c.subject}</Badge>}
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                    <a href={`tel:${c.phone}`} className="flex items-center gap-1 hover:underline">
                      <Phone className="h-4 w-4" />
                      {c.phone}
                    </a>
                    {c.guardianName && c.studentName && <span>보호자 {c.guardianName}</span>}
                    <span>{formatDate(c.createdAt)}</span>
                  </div>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-2">
                    <Select
                      value={c.status}
                      onValueChange={(v) => statusMutation.mutate({ id: c.id, status: v as Status })}
                    >
                      <SelectTrigger className="w-32" data-testid={`select-status-${c.id}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUSES.map((s) => (
                          // 최종등록은 학생·수강 등록을 만들어야 하므로 상태만 바꾸게 두지 않는다
                          <SelectItem key={s} value={s} disabled={s === "최종등록" && !c.studentId}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openEdit(c)}
                      title="상담 내용 수정"
                      data-testid={`button-edit-${c.id}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {userRole === "owner" && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => deleteMutation.mutate(c.id)}
                        data-testid={`button-delete-${c.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                {c.needsReview && canEdit && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/40">
                    <span className="text-amber-900 dark:text-amber-200">
                      통화 녹음에서 AI가 자동으로 적은 초안입니다. 이름·학년·후속 일정을
                      확인해 주세요.
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => reviewMutation.mutate(c.id)}
                      disabled={reviewMutation.isPending}
                      data-testid={`button-review-done-${c.id}`}
                    >
                      확인 완료
                    </Button>
                  </div>
                )}
                {c.followUp && (
                  <div className="flex items-start gap-2 text-sm">
                    <CalendarClock className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <span>{c.followUp}</span>
                  </div>
                )}
                {c.memo && <p className="text-sm text-muted-foreground">{c.memo}</p>}

                {(c.levelTestDate || c.levelTestScore || c.levelTestNotes || c.recommendedClassId) && (
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm space-y-1">
                    {/* 원장이 상담 중에 손으로 적은 한 줄. 앱이 채점한 결과지는 아래 따로 나온다. */}
                    <div className="text-xs font-medium text-muted-foreground">레벨테스트 (직접 입력)</div>
                    {c.levelTestDate && (
                      <div>일정: {new Date(c.levelTestDate).toLocaleString("ko-KR")}</div>
                    )}
                    {c.levelTestScore && <div>결과: {c.levelTestScore}</div>}
                    {c.levelTestNotes && <div className="text-muted-foreground">{c.levelTestNotes}</div>}
                    {c.recommendedClassId && (
                      <div>추천반: {classes.find((k) => k.id === c.recommendedClassId)?.name ?? "(삭제된 반)"}</div>
                    )}
                  </div>
                )}

                {/*
                  레벨테스트 앱에 저장된 결과지. 위의 수동 입력란(levelTestScore 등)과
                  따로 보여 준다 — 위는 원장이 손으로 적은 한 줄, 여기는 앱이 채점한
                  회차별 원본이다. 둘을 합치면 어느 쪽 숫자인지 알 수 없게 된다.
                */}
                {(byConsultation[c.id] ?? []).length > 0 && (
                  <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-primary">
                      <FileText className="h-3.5 w-3.5" />
                      레벨테스트 결과지 {byConsultation[c.id].length}건
                    </div>
                    {byConsultation[c.id].map((r) => (
                      <LevelTestResult key={r.id} row={r} />
                    ))}
                  </div>
                )}

                {/*
                  반배정 후보. 어느 단계에만 나오는지는 candidatesByConsultation
                  주석에 적어 두었다. 수정 권한이 없는 사람에게는 띄우지 않는다 —
                  누를 수 없는 버튼만 보이면 혼란만 준다.
                */}
                {canEdit && (
                  <ClassFitPanel
                    candidates={candidatesByConsultation.get(c.id) ?? []}
                    recommendedClassId={c.recommendedClassId ?? null}
                    onPick={(classId) =>
                      pickClassMutation.mutate({ id: c.id, classId, status: c.status as Status })
                    }
                    onWaitlist={(candidate) => waitlistMutation.mutate({ consultation: c, candidate })}
                    busy={pickClassMutation.isPending || waitlistMutation.isPending}
                  />
                )}

                {c.sourceText && (
                  <p className="text-xs text-muted-foreground/70 border-l-2 pl-2">입력: {c.sourceText}</p>
                )}

                {canEdit && (() => {
                  const showLevelTest = c.status === "상담문의" || c.status === "레벨테스트예정";
                  const showEnroll = !c.studentId;
                  /*
                    앱으로 채점을 시작하는 버튼.

                    이 버튼으로 열면 상담 건의 id 가 그대로 결과지의 신원이 된다.
                    그래서 (1) 어느 PC 에서 채점해도 같은 줄에 덮어써지고, (2) 결과가
                    이름 짐작 없이 이 카드에 확실히 붙는다. 반대로 앱을 따로 열어
                    채점하면 연결은 이름·전화번호 짐작에 맡겨진다.

                    등록이 끝난 건(최종등록)과 멈춘 건(보류)에는 띄우지 않는다 —
                    재테스트는 학생 관리에서 다룰 일이고, 여기서는 "지금 등록을
                    결정하는 중인 사람" 에게만 보이는 게 덜 헷갈린다.
                  */
                  const showGrading = c.status !== "최종등록" && c.status !== "보류";
                  if (!showLevelTest && !showEnroll && !showGrading) return null;
                  /*
                    이미 채점된 건은 "다시 채점"이 서버에 저장된 그 기록을
                    복원해서 연다 (가장 최근 회차 — byConsultation 은 최근순).

                    예전에는 상담 id 만 실어 앱을 열었는데, 다른 PC 에서 열거나
                    브라우저 기록이 비워져 있으면 채점이 전부 빈 채로 시작됐다.
                    원장에게는 그게 "한번 저장하면 수정이 안 된다"로 보였다.
                    기록을 복원해서 열면 틀린 표시만 고치고 다시 저장하면 되고,
                    같은 회차라 새 줄 없이 그 기록이 갱신된다.
                  */
                  const graded = (byConsultation[c.id] ?? []).length > 0;
                  const latestRecord = graded ? byConsultation[c.id][0] : null;
                  return (
                    <div className="pt-3 border-t flex flex-wrap gap-2">
                      {/*
                        시험지 인쇄. 채점 시작과 같은 연결(상담 id·이름·학년)로 앱을
                        열되 print=exam 을 실어, 학년에 맞는 시험지의 인쇄 미리보기가
                        바로 뜬다. 테스트 당일 원장이 "인쇄 → 시험 → 채점" 순서로
                        쓰므로 채점 버튼 바로 왼쪽에 둔다.
                      */}
                      {showGrading && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            openLevelTestPrintForConsultation({
                              id: c.id,
                              studentName: c.studentName,
                              grade: c.studentGrade,
                              phone: c.phone,
                            })
                          }
                          data-testid={`button-print-level-test-${c.id}`}
                        >
                          <Printer className="h-4 w-4 mr-2" />
                          레벨테스트지 인쇄
                        </Button>
                      )}
                      {showGrading && (
                        <Button
                          size="sm"
                          variant={graded ? "outline" : "default"}
                          onClick={() =>
                            latestRecord
                              ? openLevelTestEdit(latestRecord.id)
                              : openLevelTestForConsultation({
                                  id: c.id,
                                  studentName: c.studentName,
                                  grade: c.studentGrade,
                                  phone: c.phone,
                                })
                          }
                          data-testid={`button-grade-level-test-${c.id}`}
                        >
                          <FileText className="h-4 w-4 mr-2" />
                          {graded ? "채점 수정 / 다시 채점" : "레벨테스트 채점 시작"}
                        </Button>
                      )}
                      {showLevelTest && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openLevelTest(c)}
                          data-testid={`button-level-test-${c.id}`}
                        >
                          <CalendarClock className="h-4 w-4 mr-2" />
                          {c.status === "레벨테스트예정" ? "레벨테스트 결과 기록" : "레벨테스트 예약"}
                        </Button>
                      )}
                      {showEnroll && (
                        <Button size="sm" variant="outline" onClick={() => openEnroll(c)} data-testid={`button-enroll-${c.id}`}>
                          <UserPlus className="h-4 w-4 mr-2" />
                          학생으로 등록
                        </Button>
                      )}
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          ))}
          </section>
          ))}
        </div>
      )}

      {/*
        상담 기록이 없는 레벨테스트.
        워크인으로 테스트만 보고 간 학생이다. 상담 행이 없으니 위 목록에는 끝까지
        나타나지 않는다 — 등록으로 이어질 가능성이 가장 높은 사람이 가장 안 보이던
        자리라서, 목록 끝에 따로 모아 "상담 기록 만들기" 한 번으로 흐름에 태운다.
      */}
      {unmatchedVisible.length > 0 && (
        <section className="space-y-3" data-testid="consultation-unmatched-level-tests">
          <div className="flex items-baseline gap-2 border-b pb-2">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              상담 기록이 없는 레벨테스트
            </h2>
            <span className="text-sm text-muted-foreground">{unmatchedVisible.length}건</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              · 테스트만 보고 간 학생 — 상담 기록을 만들면 위 목록에서 함께 관리됩니다
            </span>
          </div>

          {unmatchedVisible.map((r) => (
            <Card key={r.id} className="hover-elevate" data-testid={`unmatched-level-test-${r.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-lg">{r.studentName}</CardTitle>
                    {r.grade && <Badge variant="secondary">{r.grade}</Badge>}
                    {r.school && <Badge variant="outline">{r.school}</Badge>}
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                    {r.parentPhone ? (
                      <a href={`tel:${r.parentPhone}`} className="flex items-center gap-1 hover:underline">
                        <Phone className="h-4 w-4" />
                        {r.parentPhone}
                      </a>
                    ) : (
                      <span className="text-xs">연락처 미입력 — 상담 기록을 만든 뒤 넣어 주세요</span>
                    )}
                  </div>
                </div>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={createFromLevelTest.isPending}
                    onClick={() => createFromLevelTest.mutate(r)}
                    data-testid={`button-create-consultation-${r.id}`}
                  >
                    <MessageSquarePlus className="h-4 w-4 mr-2" />
                    상담 기록 만들기
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                <LevelTestResult row={r} />
              </CardContent>
            </Card>
          ))}
        </section>
      )}

      <Dialog open={!!enrollTarget} onOpenChange={(open) => !open && setEnrollTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>학생으로 등록</DialogTitle>
            <DialogDescription>
              학생과 수강 등록을 함께 만듭니다. 저장하면 학생 목록에 바로 나타나고, 납부 기준일부터 미납 계산이 시작됩니다.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>학생 이름</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  data-testid="input-enroll-name"
                />
              </div>
              <div className="space-y-2">
                <Label>학년</Label>
                <Input
                  value={form.grade}
                  placeholder="중2"
                  onChange={(e) => setForm({ ...form, grade: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>반</Label>
              <Select value={form.classId} onValueChange={(v) => setForm({ ...form, classId: v })}>
                <SelectTrigger data-testid="select-enroll-class">
                  <SelectValue placeholder="반을 선택하세요" />
                </SelectTrigger>
                <SelectContent>
                  {activeClassOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label} · {c.subject} · {c.defaultTuition.toLocaleString()}원
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {classes.length === 0 && (
                <p className="text-xs text-destructive">반이 없습니다. 먼저 «반» 화면에서 반을 만들어주세요.</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>등록일</Label>
                <Input
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  data-testid="input-enroll-start-date"
                />
              </div>
              <div className="space-y-2">
                <Label>납부 기준일 (매월)</Label>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={form.dueDay}
                  onChange={(e) => setForm({ ...form, dueDay: e.target.value })}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEnrollTarget(null)}>
              취소
            </Button>
            <Button
              onClick={() => enrollTarget && enrollMutation.mutate(enrollTarget)}
              disabled={!canEnroll || enrollMutation.isPending}
              data-testid="button-confirm-enroll"
            >
              {enrollMutation.isPending ? "등록 중..." : "등록하기"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!levelTestTarget} onOpenChange={(open) => !open && setLevelTestTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {ltMode === "record" ? "레벨테스트 결과 기록" : "레벨테스트 예약"}
            </DialogTitle>
            <DialogDescription>
              {ltMode === "record"
                ? "점수·메모·추천반을 남기면 상태가 «레벨테스트완료»로 넘어갑니다."
                : "일정을 잡으면 상태가 «레벨테스트예정»으로 바뀝니다."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {ltMode === "schedule" ? (
              <div className="space-y-2">
                <Label>레벨테스트 일시</Label>
                <Input
                  type="datetime-local"
                  value={ltForm.date}
                  onChange={(e) => setLtForm({ ...ltForm, date: e.target.value })}
                  data-testid="input-level-test-date"
                />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>점수 / 등급</Label>
                  <Input
                    placeholder="예: 85점, B+, 초급 상위 등"
                    value={ltForm.score}
                    onChange={(e) => setLtForm({ ...ltForm, score: e.target.value })}
                    data-testid="input-level-test-score"
                  />
                </div>
                <div className="space-y-2">
                  <Label>메모</Label>
                  <Input
                    placeholder="예: 문법 약함, 회화 좋음"
                    value={ltForm.notes}
                    onChange={(e) => setLtForm({ ...ltForm, notes: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>추천반 (선택)</Label>
                  <Select
                    value={ltForm.recommendedClassId || "none"}
                    onValueChange={(v) => setLtForm({ ...ltForm, recommendedClassId: v === "none" ? "" : v })}
                  >
                    <SelectTrigger data-testid="select-recommended-class">
                      <SelectValue placeholder="반을 선택하세요" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">추천하지 않음</SelectItem>
                      {activeClassOptions.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.label} · {c.subject}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setLevelTestTarget(null)}>
              취소
            </Button>
            <Button
              onClick={() =>
                levelTestTarget && levelTestMutation.mutate({ id: levelTestTarget.id, mode: ltMode })
              }
              disabled={
                levelTestMutation.isPending ||
                (ltMode === "schedule" && !ltForm.date) ||
                (ltMode === "record" && !ltForm.score.trim())
              }
              data-testid="button-confirm-level-test"
            >
              {levelTestMutation.isPending ? "저장 중..." : "저장"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>상담 내용 수정</DialogTitle>
            <DialogDescription>
              {editTarget?.studentName || editTarget?.guardianName || "이름 미상"} · {editTarget?.status}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>학생 이름</Label>
              <Input
                value={editForm.studentName}
                onChange={(e) => setEditForm({ ...editForm, studentName: e.target.value })}
                placeholder="예: 윤희엘"
                data-testid="input-edit-student-name"
              />
              <p className="text-xs text-muted-foreground">
                통화 자동등록이 이름을 잘못 알아들었다면 여기서 바로잡으세요.
              </p>
            </div>
            <div className="space-y-2">
              <Label>보호자 연락처</Label>
              <Input
                value={editForm.phone}
                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                placeholder="예: 010-1234-5678"
                data-testid="input-edit-phone"
              />
              <p className="text-xs text-muted-foreground">
                급하게 상담을 넣느라 연락처가 빠졌다면 여기서 추가하세요.
              </p>
            </div>
            <div className="space-y-2">
              <Label>문의 과목</Label>
              <Input
                value={editForm.subject}
                onChange={(e) => setEditForm({ ...editForm, subject: e.target.value })}
                placeholder="예: 영어, 수학"
                data-testid="input-edit-subject"
              />
            </div>
            <div className="space-y-2">
              <Label>후속 조치</Label>
              <Input
                value={editForm.followUp}
                onChange={(e) => setEditForm({ ...editForm, followUp: e.target.value })}
                placeholder="예: 다음주 화요일 재통화"
                data-testid="input-edit-follow-up"
              />
            </div>
            <div className="space-y-2">
              <Label>메모</Label>
              <Textarea
                value={editForm.memo}
                onChange={(e) => setEditForm({ ...editForm, memo: e.target.value })}
                rows={5}
                placeholder="상담 내용 메모"
                data-testid="input-edit-memo"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              취소
            </Button>
            <Button
              onClick={() => editTarget && editMutation.mutate(editTarget.id)}
              disabled={editMutation.isPending}
              data-testid="button-confirm-edit"
            >
              {editMutation.isPending ? "저장 중..." : "저장"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
