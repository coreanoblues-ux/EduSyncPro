import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Mic,
  MicOff,
  RefreshCw,
  Send,
  Sparkles,
  Volume2,
  VolumeX,
  Radio,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useVoice } from "@/hooks/useVoice";
import type { Class, Teacher } from "@shared/schema";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolsUsed?: string[];
}

interface ChatContext {
  studentId?: string;
  studentName?: string;
  classId?: string;
  className?: string;
  teacherId?: string;
  teacherName?: string;
}

const ALL_EXAMPLES = [
  "김민준 요즘 어때?",
  "이번달 미납자 알려줘",
  "중1 학생 목록 보여줘",
  "화목 5시반 학생 누구야?",
  "정쌤 반 학생 보여줘",
  "김민준 35만원 계좌이체 수납",
  "이번달 매출 지난달이랑 비교",
  "새 학생 등록: 이서연 중2 숭의중",
  "김민준 전화번호 010-1234-5678로 변경",
  "상담 기록: 이서연 엄마 수학 보충 문의",
  "할 일: 내일까지 학부모 안내문 발송",
];

function pickRandomExample(): string {
  return ALL_EXAMPLES[Math.floor(Math.random() * ALL_EXAMPLES.length)];
}

/** AI 응답에서 번호 매겨진 선택지를 추출한다. "1. 수학A반 ..." → ["1", "2", ...] */
function extractNumberedOptions(text: string): string[] {
  const lines = text.split("\n");
  const options: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s+(.+)/);
    if (m) options.push(m[1]);
  }
  // 선택지가 2개 이상일 때만 (단일 항목 나열은 선택지가 아님)
  return options.length >= 2 ? options : [];
}

export default function AiChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [context, setContext] = useState<ChatContext>({});
  const [enrollTarget, setEnrollTarget] = useState<{ studentId: string; studentName: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const example = useMemo(() => pickRandomExample(), []);

  // 반 목록과 강사 목록 (수강 등록 선택 UI용)
  const { data: classes = [] } = useQuery<Class[]>({ queryKey: ["/api/classes"] });
  const { data: teachers = [] } = useQuery<Teacher[]>({ queryKey: ["/api/teachers"] });

  const chatMutation = useMutation({
    mutationFn: async (allMessages: { role: string; content: string }[]) => {
      const res = await apiRequest("POST", "/api/ai/chat", {
        messages: allMessages,
      });
      const data = await res.json();
      return data as { reply: string; toolsUsed?: string[]; context?: ChatContext };
    },
    onSuccess: (data) => {
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: data.reply,
        toolsUsed: data.toolsUsed,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      if (data.context) {
        setContext((prev) => ({ ...prev, ...data.context }));
      }

      // 학생이 새로 등록됐고 수강 등록이 아직 안 됐으면 → 반 선택 UI 표시
      if (data.toolsUsed?.includes("create_student") && data.context?.studentId) {
        setEnrollTarget({ studentId: data.context.studentId, studentName: data.context.studentName ?? "" });
      }

      // 데이터 변경이 있었을 수 있으므로 관련 쿼리를 무효화
      const writes = data.toolsUsed?.filter((t) =>
        t.startsWith("create_") || t.startsWith("update_") || t.startsWith("record_") || t.startsWith("enroll_")
      );
      if (writes && writes.length > 0) {
        qc.invalidateQueries({ queryKey: ["/api/students"] });
        qc.invalidateQueries({ queryKey: ["/api/enrollments"] });
        qc.invalidateQueries({ queryKey: ["/api/payments"] });
        qc.invalidateQueries({ queryKey: ["/api/consultations"] });
        qc.invalidateQueries({ queryKey: ["/api/tasks"] });
        qc.invalidateQueries({ queryKey: ["/api/classes"] });
      }
    },
    onError: (error: Error) => {
      const errorMsg: ChatMessage = {
        role: "assistant",
        content: `오류가 발생했습니다: ${error.message.replace(/^\d+:\s*/, "")}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    },
  });

  const handleSend = useCallback(
    (text?: string) => {
      const content = (text ?? input).trim();
      if (!content || chatMutation.isPending) return;

      const userMsg: ChatMessage = { role: "user", content };
      const updated = [...messages, userMsg];
      setMessages(updated);
      setInput("");
      setEnrollTarget(null);

      chatMutation.mutate(
        updated.map((m) => ({ role: m.role, content: m.content })),
      );
    },
    [input, messages, chatMutation],
  );

  const handleEnrollClass = useCallback(
    (cls: Class) => {
      if (!enrollTarget) return;
      const teacher = teachers.find((t) => t.id === cls.teacherId);
      const teacherLabel = teacher ? `${teacher.name} 선생님` : "";
      handleSend(
        `${enrollTarget.studentName} ${cls.name}에 수강 등록해줘` +
        (teacherLabel ? ` (${teacherLabel})` : "")
      );
      setEnrollTarget(null);
    },
    [enrollTarget, teachers, handleSend],
  );

  // 음성 입출력 훅. onCommand는 음성으로 들어온 문장을 자동 전송.
  const voice = useVoice({
    onCommand: (text) => handleSend(text),
    wakeWord: "상담실장",
  });

  // AI 응답이 도착하면 TTS 재생 (활성화된 경우에만)
  const lastSpokenRef = useRef<string | null>(null);
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (
      last?.role === "assistant" &&
      last.content &&
      last.content !== lastSpokenRef.current &&
      voice.ttsEnabled
    ) {
      lastSpokenRef.current = last.content;
      voice.speak(last.content);
    }
  }, [messages, voice.ttsEnabled, voice.speak]);

  const handleReset = useCallback(() => {
    setMessages([]);
    setContext({});
    setInput("");
    setEnrollTarget(null);
    lastSpokenRef.current = null;
    voice.stopSpeaking();
  }, [voice]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, chatMutation.isPending]);

  const contextBadges = useMemo(() => {
    const items: { label: string; value: string }[] = [];
    if (context.studentName) items.push({ label: "학생", value: context.studentName });
    if (context.className) items.push({ label: "반", value: context.className });
    if (context.teacherName) items.push({ label: "선생님", value: context.teacherName });
    return items;
  }, [context]);

  // AI가 번호 선택지를 보여줬을 때 마지막 메시지에서 추출
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const quickReplies = lastMsg?.role === "assistant" && !chatMutation.isPending
    ? extractNumberedOptions(lastMsg.content)
    : [];

  // 활성 반 목록 (수강 등록 선택 UI)
  const activeClasses = useMemo(
    () => classes.filter((c) => c.isActive),
    [classes],
  );

  return (
    <Card className="flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-primary" />
            AI 상담실장
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            학생 조회, 수납, 등록, 출결, 상담, 할 일 등 무엇이든 말하듯 입력하세요
          </p>
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={handleReset}>
            <RefreshCw className="h-4 w-4 mr-1" />
            새 대화
          </Button>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0">
        {/* Context badges */}
        {contextBadges.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {contextBadges.map((b) => (
              <Badge key={b.label} variant="secondary" className="text-xs">
                {b.label}: {b.value}
              </Badge>
            ))}
          </div>
        )}

        {/* Messages area — native 스크롤바로 긴 내용 탐색 가능 */}
        <div
          ref={scrollRef}
          className="flex flex-col gap-3 p-1 overflow-y-auto"
          style={{ maxHeight: messages.length > 0 ? 600 : undefined }}
        >
          {messages.length === 0 && !chatMutation.isPending && (
            <div className="flex flex-col items-center justify-center py-4 gap-2">
              <p className="text-sm text-muted-foreground">
                아래 예시를 클릭하거나 직접 입력해 보세요
              </p>
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-auto py-2 whitespace-normal"
                onClick={() => handleSend(example)}
              >
                {example}
              </Button>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn(
                "flex flex-col max-w-[85%]",
                msg.role === "user" ? "self-end items-end" : "self-start items-start",
              )}
            >
              <div
                className={cn(
                  "rounded-lg px-3 py-2 text-sm whitespace-pre-wrap",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {msg.content}
              </div>
              {msg.toolsUsed && msg.toolsUsed.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {msg.toolsUsed.map((tool) => (
                    <Badge key={tool} variant="outline" className="text-[10px] px-1.5 py-0">
                      {tool}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}

          {chatMutation.isPending && (
            <div className="self-start flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              처리 중...
            </div>
          )}
        </div>

        {/* AI가 번호 선택지를 보여줬을 때 빠른 선택 버튼 */}
        {quickReplies.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {quickReplies.map((n) => (
              <Button
                key={n}
                variant="outline"
                size="sm"
                className="text-xs px-3 py-1 h-auto"
                onClick={() => handleSend(n)}
              >
                {n}번
              </Button>
            ))}
          </div>
        )}

        {/* 학생 등록 후 반 선택 UI */}
        {enrollTarget && activeClasses.length > 0 && (
          <div className="rounded-lg border p-3 space-y-2">
            <p className="text-sm font-medium">
              {enrollTarget.studentName} — 수강할 반을 선택하세요
            </p>
            <div className="grid gap-1.5 max-h-48 overflow-y-auto">
              {activeClasses.map((cls) => {
                const teacher = teachers.find((t) => t.id === cls.teacherId);
                return (
                  <Button
                    key={cls.id}
                    variant="outline"
                    size="sm"
                    className="justify-start text-xs h-auto py-1.5 px-2"
                    onClick={() => handleEnrollClass(cls)}
                  >
                    <span className="font-medium">{cls.name}</span>
                    <span className="text-muted-foreground ml-2">
                      {teacher?.name ?? "-"} · {cls.schedule} · {cls.defaultTuition?.toLocaleString()}원
                    </span>
                  </Button>
                );
              })}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => setEnrollTarget(null)}
            >
              나중에 등록
            </Button>
          </div>
        )}

        {/* 음성 컨트롤 */}
        {(voice.supported || voice.ttsSupported) && (
          <div className="flex items-center gap-1.5 flex-wrap text-xs">
            {voice.supported && (
              <>
                <Button
                  variant={voice.handsFree ? "default" : "outline"}
                  size="sm"
                  className={cn(
                    "h-8 px-2 gap-1",
                    voice.handsFree && "animate-pulse",
                  )}
                  onClick={voice.toggleHandsFree}
                  title="핸즈프리: '상담실장' 이라고 부르면 활성화됩니다"
                >
                  <Radio className="h-3.5 w-3.5" />
                  핸즈프리
                </Button>
                <Button
                  variant={voice.isListening && !voice.handsFree ? "default" : "outline"}
                  size="sm"
                  className="h-8 px-2 gap-1"
                  onClick={voice.startPushToTalk}
                  disabled={chatMutation.isPending}
                  title="한 번 말하고 자동 전송"
                >
                  {voice.isListening && !voice.handsFree ? (
                    <MicOff className="h-3.5 w-3.5" />
                  ) : (
                    <Mic className="h-3.5 w-3.5" />
                  )}
                  말하기
                </Button>
              </>
            )}
            {voice.ttsSupported && (
              <Button
                variant={voice.ttsEnabled ? "default" : "outline"}
                size="sm"
                className="h-8 px-2 gap-1"
                onClick={voice.toggleTts}
                title="AI 응답을 음성으로 읽어줍니다"
              >
                {voice.ttsEnabled ? (
                  <Volume2 className="h-3.5 w-3.5" />
                ) : (
                  <VolumeX className="h-3.5 w-3.5" />
                )}
                읽어주기
              </Button>
            )}

            {/* 상태 표시 */}
            <div className="flex-1 min-w-0 flex items-center gap-2 pl-1">
              {voice.wakeArmed && (
                <span className="text-primary font-medium">
                  🎯 명령을 말씀하세요
                </span>
              )}
              {!voice.wakeArmed && voice.handsFree && !voice.isSpeaking && (
                <span className="text-muted-foreground">
                  👂 "상담실장" 부르면 시작
                </span>
              )}
              {!voice.wakeArmed && voice.isListening && !voice.handsFree && (
                <span className="text-primary">🎤 듣는 중...</span>
              )}
              {voice.isSpeaking && (
                <span className="text-muted-foreground">🔊 읽는 중...</span>
              )}
              {voice.interimText && (
                <span className="italic text-muted-foreground truncate">
                  "{voice.interimText}"
                </span>
              )}
            </div>
          </div>
        )}

        {/* Input bar */}
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="예) 김민준 35만원 카드 결제 / 중1 학생 목록 / 새 학생 등록..."
            disabled={chatMutation.isPending}
            className="flex-1"
          />
          <Button
            size="icon"
            onClick={() => handleSend()}
            disabled={!input.trim() || chatMutation.isPending}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
