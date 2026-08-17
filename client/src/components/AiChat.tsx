import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, RefreshCw, Send, Sparkles } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

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
  "어제 안온 애들 보여줘",
  "화목 5시반 학생 누구야?",
  "정쌤 반 학생 보여줘",
  "이번달 매출 지난달이랑 비교",
  "김민준 35만원 계좌이체 수납",
  "중1 학생 목록 보여줘",
];

function pickRandomExamples(count: number): string[] {
  const shuffled = [...ALL_EXAMPLES].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export default function AiChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [context, setContext] = useState<ChatContext>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const examples = useMemo(() => pickRandomExamples(4), []);

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
    },
    onError: (error: Error) => {
      const errorMsg: ChatMessage = {
        role: "assistant",
        content: `오류가 발생했습니다: ${error.message}`,
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

      chatMutation.mutate(
        updated.map((m) => ({ role: m.role, content: m.content })),
      );
    },
    [input, messages, chatMutation],
  );

  const handleReset = useCallback(() => {
    setMessages([]);
    setContext({});
    setInput("");
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-scroll to bottom on new messages or loading state change
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

  return (
    <Card className="flex flex-col h-full">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-primary" />
            AI 상담실장
          </CardTitle>
          <p className="text-sm text-muted-foreground mt-1">
            학생 조회, 수납, 출결, 상담 등을 말하듯 입력하세요
          </p>
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={handleReset}>
            <RefreshCw className="h-4 w-4 mr-1" />
            새 대화
          </Button>
        )}
      </CardHeader>

      <CardContent className="flex flex-col flex-1 gap-3 pt-0">
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

        {/* Messages area */}
        <ScrollArea className="flex-1 min-h-0" style={{ maxHeight: 400 }}>
          <div ref={scrollRef} className="flex flex-col gap-3 p-1">
            {messages.length === 0 && !chatMutation.isPending && (
              <div className="flex flex-col items-center justify-center py-8 gap-4">
                <p className="text-sm text-muted-foreground">
                  아래 예시를 클릭하거나 직접 입력해 보세요
                </p>
                <div className="grid grid-cols-2 gap-2 w-full max-w-sm">
                  {examples.map((ex) => (
                    <Button
                      key={ex}
                      variant="outline"
                      size="sm"
                      className="text-xs h-auto py-2 whitespace-normal text-left"
                      onClick={() => handleSend(ex)}
                    >
                      {ex}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={cn(
                  "flex flex-col max-w-[80%]",
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
                분석 중...
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Input bar */}
        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="무엇이든 물어보세요..."
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
