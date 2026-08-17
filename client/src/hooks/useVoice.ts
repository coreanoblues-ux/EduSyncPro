/**
 * 브라우저 Web Speech API 기반 음성 입출력 훅.
 *
 * 지원 브라우저: Chrome/Edge/Safari (webkit prefix).
 *   Firefox는 SpeechRecognition을 지원하지 않아 supported=false.
 *
 * 3가지 모드:
 *   - Push-to-talk: 마이크 버튼 클릭 → 한 번 녹음 → onCommand 호출
 *   - Hands-free:   상시 대기, 웨이크워드("상담실장") 감지 시 다음 발화를 명령으로 캡처
 *   - TTS:          onCommand 완료 후 speak(text)로 응답 음성 재생
 *
 * 웨이크워드 처리:
 *   - "상담실장 김민준 미납자" → 웨이크워드 뒤 문장이 명령
 *   - "상담실장!" (단독) → armed 상태, 다음 발화가 명령
 *
 * TTS 중에는 자기 소리를 인식하지 않도록 recognition을 잠시 멈춘다.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const SpeechRecognitionClass: any =
  typeof window !== "undefined"
    ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    : null;

const ttsAvailable = typeof window !== "undefined" && "speechSynthesis" in window;

interface UseVoiceOptions {
  onCommand: (text: string) => void;
  wakeWord?: string;
  lang?: string;
}

export function useVoice({
  onCommand,
  wakeWord = "상담실장",
  lang = "ko-KR",
}: UseVoiceOptions) {
  const supported = !!SpeechRecognitionClass;

  const [isListening, setIsListening] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [wakeArmed, setWakeArmed] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const recognitionRef = useRef<any>(null);
  const modeRef = useRef<"idle" | "push" | "handsfree">("idle");
  const shouldRestartRef = useRef(false);
  const wakeArmedRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const onCommandRef = useRef(onCommand);

  useEffect(() => {
    onCommandRef.current = onCommand;
  }, [onCommand]);

  const setArmed = (v: boolean) => {
    wakeArmedRef.current = v;
    setWakeArmed(v);
  };

  const cleanText = (t: string) =>
    t.trim().replace(/[.!?。,、\s]+$/g, "").trim();

  const processHandsFreeResult = (transcript: string) => {
    const t = transcript.trim();
    if (!t) return;

    // 이전에 웨이크워드만 들렸다 → 이번 발화가 곧 명령
    if (wakeArmedRef.current) {
      const cmd = cleanText(t);
      if (cmd.length >= 2) {
        onCommandRef.current(cmd);
      }
      setArmed(false);
      return;
    }

    // 웨이크워드 감지 (문자 사이 공백 허용: "상담 실장"도 매치)
    const escaped = wakeWord
      .split("")
      .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*");
    const wakePattern = new RegExp(escaped, "i");
    const match = t.match(wakePattern);
    if (!match || match.index === undefined) return;

    // 웨이크워드 뒤 부분을 명령으로
    const after = t
      .slice(match.index + match[0].length)
      .replace(/^[,\.!?~\-\s]+/, "")
      .trim();

    if (after.length >= 2) {
      onCommandRef.current(cleanText(after));
    } else {
      // 웨이크워드만 → 다음 발화를 기다림
      setArmed(true);
    }
  };

  const createRecognition = useCallback(
    (continuous: boolean) => {
      if (!SpeechRecognitionClass) return null;
      const rec = new SpeechRecognitionClass();
      rec.lang = lang;
      rec.continuous = continuous;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      rec.onresult = (event: any) => {
        let interim = "";
        let final = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) final += res[0].transcript;
          else interim += res[0].transcript;
        }
        setInterimText(interim || final);

        if (final) {
          if (modeRef.current === "push") {
            const cmd = cleanText(final);
            if (cmd) onCommandRef.current(cmd);
            shouldRestartRef.current = false;
            try {
              rec.stop();
            } catch {}
          } else if (modeRef.current === "handsfree") {
            processHandsFreeResult(final);
            setInterimText("");
          }
        }
      };

      rec.onend = () => {
        setIsListening(false);
        setInterimText("");
        // 핸즈프리는 자동 재시작 (Safari/모바일 대응)
        if (
          shouldRestartRef.current &&
          modeRef.current === "handsfree" &&
          !isSpeakingRef.current
        ) {
          setTimeout(() => {
            if (
              shouldRestartRef.current &&
              modeRef.current === "handsfree" &&
              !isSpeakingRef.current
            ) {
              try {
                rec.start();
                setIsListening(true);
              } catch {}
            }
          }, 300);
        }
      };

      rec.onerror = (e: any) => {
        // 권한 거부는 완전 종료
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          shouldRestartRef.current = false;
          modeRef.current = "idle";
          setHandsFree(false);
          setIsListening(false);
        }
        // no-speech, aborted 등은 onend에서 재시작 처리
      };

      return rec;
    },
    [lang, wakeWord]
  );

  const startPushToTalk = useCallback(() => {
    if (!SpeechRecognitionClass) return;
    // 핸즈프리가 켜져 있으면 잠시 멈춘다 (mode 전환)
    const prevHandsFree = handsFree;
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }

    modeRef.current = "push";
    const rec = createRecognition(false);
    if (!rec) return;
    recognitionRef.current = rec;

    // push 끝나면 핸즈프리 복귀
    const origOnEnd = rec.onend;
    rec.onend = (ev: any) => {
      if (typeof origOnEnd === "function") origOnEnd.call(rec, ev);
      if (prevHandsFree) {
        // 핸즈프리 재개
        modeRef.current = "handsfree";
        shouldRestartRef.current = true;
        const hfRec = createRecognition(true);
        if (hfRec) {
          recognitionRef.current = hfRec;
          setTimeout(() => {
            try {
              hfRec.start();
              setIsListening(true);
            } catch {}
          }, 300);
        }
      }
    };

    try {
      rec.start();
      setIsListening(true);
    } catch {
      // 이미 시작 중이면 무시
    }
  }, [handsFree, createRecognition]);

  const toggleHandsFree = useCallback(() => {
    if (!SpeechRecognitionClass) return;
    if (handsFree) {
      // 끄기
      setHandsFree(false);
      setArmed(false);
      shouldRestartRef.current = false;
      modeRef.current = "idle";
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }
      setIsListening(false);
      setInterimText("");
      return;
    }
    // 켜기
    setHandsFree(true);
    modeRef.current = "handsfree";
    shouldRestartRef.current = true;
    const rec = createRecognition(true);
    if (!rec) return;
    recognitionRef.current = rec;
    try {
      rec.start();
      setIsListening(true);
    } catch {}
  }, [handsFree, createRecognition]);

  const stopListening = useCallback(() => {
    shouldRestartRef.current = false;
    modeRef.current = "idle";
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {}
    }
    setIsListening(false);
    setInterimText("");
    setHandsFree(false);
    setArmed(false);
  }, []);

  // ─── TTS ────────────────────────────────────────────────────────
  const toggleTts = useCallback(() => {
    setTtsEnabled((v) => {
      if (v && ttsAvailable) {
        window.speechSynthesis.cancel();
        setIsSpeaking(false);
        isSpeakingRef.current = false;
      }
      return !v;
    });
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (!ttsAvailable || !text) return;

      // 마크다운·기호 정리 (읽기 어색해지지 않게)
      const clean = text
        .replace(/\*\*/g, "")
        .replace(/[*_`~#]/g, "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!clean) return;

      // 핸즈프리 중이면 자기 소리 안 듣도록 recognition 잠시 정지
      isSpeakingRef.current = true;
      setIsSpeaking(true);
      const wasHandsFree = modeRef.current === "handsfree";
      if (wasHandsFree && recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }

      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(clean);
      utter.lang = lang;
      utter.rate = 1.1;
      utter.pitch = 1.0;
      utter.volume = 1.0;

      // 한국어 음성 선택
      const voices = window.speechSynthesis.getVoices();
      const koVoice =
        voices.find((v) => v.lang === "ko-KR") ||
        voices.find((v) => v.lang.startsWith("ko"));
      if (koVoice) utter.voice = koVoice;

      const done = () => {
        isSpeakingRef.current = false;
        setIsSpeaking(false);
        // 핸즈프리 재개
        if (wasHandsFree && shouldRestartRef.current) {
          setTimeout(() => {
            if (
              !isSpeakingRef.current &&
              modeRef.current === "handsfree" &&
              recognitionRef.current
            ) {
              try {
                recognitionRef.current.start();
                setIsListening(true);
              } catch {}
            }
          }, 400);
        }
      };
      utter.onend = done;
      utter.onerror = done;

      window.speechSynthesis.speak(utter);
    },
    [lang]
  );

  const stopSpeaking = useCallback(() => {
    if (ttsAvailable) {
      window.speechSynthesis.cancel();
    }
    isSpeakingRef.current = false;
    setIsSpeaking(false);
  }, []);

  // 언마운트 정리
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {}
      }
      if (ttsAvailable) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  // 브라우저 voices 목록이 비동기로 채워지는 경우 대비 — 미리 로드
  useEffect(() => {
    if (!ttsAvailable) return;
    // 브라우저에 따라 첫 호출 시 빈 배열이 반환됨
    window.speechSynthesis.getVoices();
    const handler = () => window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener?.("voiceschanged", handler);
    return () => {
      window.speechSynthesis.removeEventListener?.("voiceschanged", handler);
    };
  }, []);

  return {
    supported,
    ttsSupported: ttsAvailable,
    isListening,
    handsFree,
    ttsEnabled,
    interimText,
    wakeArmed,
    isSpeaking,
    startPushToTalk,
    stopListening,
    toggleHandsFree,
    toggleTts,
    speak,
    stopSpeaking,
  };
}
