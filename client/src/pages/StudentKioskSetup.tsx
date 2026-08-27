/**
 * 학생용 태블릿 최초 설정 화면.
 *
 * 원장이 관리자에서 발급한 kioskKey를 이 화면에서 붙여넣으면 localStorage에 저장된다.
 * 이후 태블릿은 /student-kiosk 진입 시 이 키로 세션을 얻어 학생 검색·결제요청을 수행한다.
 *
 * 키가 이미 저장되어 있으면 자동으로 /student-kiosk로 이동한다.
 */

import { useState, useEffect } from "react";
import { useLocation } from "wouter";

export const KIOSK_KEY_STORAGE = "edusyncpro.kioskKey";

export default function StudentKioskSetup() {
  const [, setLocation] = useLocation();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(KIOSK_KEY_STORAGE)) {
      setLocation("/student-kiosk");
    }
  }, [setLocation]);

  const save = async () => {
    setError(null);
    const trimmed = key.trim();
    if (!trimmed) return setError("kioskKey를 입력하세요.");
    setBusy(true);
    try {
      // 서버에 검증 요청 후 저장한다. 잘못된 키를 저장해두면 사용자가 원인을 알기 힘들다.
      const r = await fetch("/api/toss-kiosk/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kioskKey: trimmed }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || "인증 실패");
      }
      localStorage.setItem(KIOSK_KEY_STORAGE, trimmed);
      setLocation("/student-kiosk");
    } catch (e: any) {
      setError(e.message || "저장 실패");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-8">
      <div className="w-full max-w-lg space-y-6">
        <div>
          <h1 className="text-2xl font-bold">태블릿 설정</h1>
          <p className="text-slate-400 mt-2 text-sm">
            원장님이 관리자 화면에서 발급한 <b>kioskKey</b>를 붙여넣으세요. 한 번만 설정하면 됩니다.
          </p>
        </div>
        <textarea
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="예: kJdKxq7pW... (32바이트 base64url)"
          rows={4}
          className="w-full rounded-lg bg-slate-800 border border-slate-700 p-4 text-sm font-mono"
          data-testid="input-kiosk-key"
        />
        {error && <div className="text-red-400 text-sm" data-testid="text-error">{error}</div>}
        <button
          onClick={save}
          disabled={busy}
          className="w-full rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-50 py-4 text-lg font-semibold"
          data-testid="button-save-key"
        >
          {busy ? "확인 중..." : "저장하고 시작"}
        </button>
        <p className="text-xs text-slate-500">
          이 키는 태블릿에만 저장되며 서버로 매번 전송되지 않습니다. 태블릿을 폐기할 때는 원장님이 관리자 화면에서 폐기 버튼을 눌러야 안전합니다.
        </p>
      </div>
    </div>
  );
}
