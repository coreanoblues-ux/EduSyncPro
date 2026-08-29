/**
 * 학생용 태블릿 키오스크 웹앱 (EduSyncPro 별도 경로).
 *
 * 이 화면은 학원 로비의 태블릿 브라우저에서 실행된다. 원장/강사 로그인이 없고,
 * 최초 부팅 때 원장이 발급한 kioskKey만 저장돼 있으면 학부모·학생이 직접 조작할 수 있다.
 *
 * 화면 흐름:
 *   phone      → 보호자 번호 뒤 4자리 입력
 *   students   → 마스킹된 학생 후보 선택
 *   invoices   → 이 학생의 미납 청구서 선택
 *   paying     → "결제 단말기에서 카드를 대주세요" — 서버 dispatch 상태 폴링
 *   done       → 완료 표시 후 5초 뒤 자동으로 phone으로 복귀
 *
 * 인증: 부팅 시 kioskKey → /api/toss-kiosk/session → accessToken. 401 시 자동 재발급.
 * 실제 결제는 EduSyncPro 서버가 Toss Front 플러그인으로 dispatch를 밀어내고,
 * 이 태블릿은 완료 여부만 폴링해 화면을 넘긴다.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { KIOSK_KEY_STORAGE } from "./StudentKioskSetup";

type Stage = "phone" | "students" | "invoices" | "amount" | "paying" | "done" | "error";

interface StudentHit {
  id: string;
  nameMasked: string;
  school: string | null;
  grade: string | null;
  parentPhoneMasked: string | null;
}

interface Invoice {
  /** 완납 건은 결제할 게 없어 서버가 토큰을 발급하지 않는다 (null). */
  token: string | null;
  paymentMonth: string;
  enrollmentId: string;
  className: string;
  subject: string;
  amountDue: number;
  amountPaid: number;
  tuition: number;
  status: "미납" | "부분납" | "완납";
}

/** 목록·상세에서 같은 색을 쓰기 위해 한 곳에 모아 둔다. */
const STATUS_STYLE: Record<Invoice["status"], { badge: string; amount: string }> = {
  미납: { badge: "bg-red-500/15 text-red-300 border-red-500/30", amount: "text-orange-400" },
  부분납: { badge: "bg-amber-500/15 text-amber-300 border-amber-500/30", amount: "text-amber-300" },
  완납: { badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", amount: "text-slate-500" },
};

// ─── 인증 유틸 ───────────────────────────────────────────────────────────
let accessToken: string | null = null;

async function acquireSession(kioskKey: string): Promise<string> {
  const r = await fetch("/api/toss-kiosk/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kioskKey }),
  });
  if (!r.ok) throw new Error("태블릿 인증 실패");
  const body = await r.json();
  accessToken = body.accessToken;
  return body.accessToken;
}

async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const kioskKey = localStorage.getItem(KIOSK_KEY_STORAGE);
  if (!kioskKey) throw new Error("no kiosk key");
  if (!accessToken) await acquireSession(kioskKey);
  const doFetch = () =>
    fetch(path, {
      ...init,
      headers: {
        ...(init.headers || {}),
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });
  let r = await doFetch();
  if (r.status === 401) {
    await acquireSession(kioskKey);
    r = await doFetch();
  }
  return r;
}

// ─── 컴포넌트 ────────────────────────────────────────────────────────────
export default function StudentKiosk() {
  const [, setLocation] = useLocation();
  const [stage, setStage] = useState<Stage>("phone");
  const [phoneSuffix, setPhoneSuffix] = useState("");
  const [candidates, setCandidates] = useState<StudentHit[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<StudentHit | null>(null);
  const [studentName, setStudentName] = useState<string>("");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [payingAmount, setPayingAmount] = useState<number>(0);
  const [dispatchId, setDispatchId] = useState<string | null>(null);
  const [payingMessage, setPayingMessage] = useState<string>("결제 단말기에서 카드를 넣어주세요.");
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const doneTimer = useRef<number | null>(null);

  // 부팅: kioskKey 없으면 setup으로
  useEffect(() => {
    if (!localStorage.getItem(KIOSK_KEY_STORAGE)) {
      setLocation("/student-kiosk/setup");
    }
  }, [setLocation]);

  const reset = useCallback(() => {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    if (doneTimer.current) window.clearTimeout(doneTimer.current);
    pollTimer.current = null;
    doneTimer.current = null;
    setPhoneSuffix("");
    setCandidates([]);
    setSelectedStudent(null);
    setStudentName("");
    setInvoices([]);
    setSelectedInvoice(null);
    setPayingAmount(0);
    setDispatchId(null);
    setError(null);
    setStage("phone");
  }, []);

  // ─── 액션 ─────────────────────────────────────────────────────────────
  const searchStudents = async () => {
    setError(null);
    try {
      const r = await authedFetch("/api/toss-kiosk/students/search", {
        method: "POST",
        body: JSON.stringify({ phoneSuffix }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      const rows: StudentHit[] = await r.json();
      if (rows.length === 0) {
        setError("해당 번호로 등록된 학생이 없습니다. 원장님께 문의하세요.");
        return;
      }
      setCandidates(rows);
      setStage("students");
    } catch (e: any) {
      setError(e.message || "검색 실패");
    }
  };

  const loadInvoices = async (student: StudentHit) => {
    setError(null);
    setSelectedStudent(student);
    try {
      const r = await authedFetch(`/api/toss-kiosk/students/${student.id}/invoices`);
      if (!r.ok) throw new Error((await r.json()).error);
      const body = await r.json();
      setStudentName(body.studentName);
      setInvoices(body.invoices);
      if (body.invoices.length === 0) {
        setError("미납 수강료가 없습니다.");
        return;
      }
      setStage("invoices");
    } catch (e: any) {
      setError(e.message || "청구서 조회 실패");
    }
  };

  // 청구서 선택 → 금액 선택 화면으로. 결제 API 호출은 다음 단계에서.
  const pickInvoice = (inv: Invoice) => {
    setError(null);
    setSelectedInvoice(inv);
    setPayingAmount(inv.amountDue); // 기본값 전액
    setStage("amount");
  };

  const startPayment = async (inv: Invoice, requestedAmount: number) => {
    setError(null);
    // 완납 건은 서버가 토큰을 발급하지 않는다. 토큰 없이 요청하면 서버가 400 을
    // 돌려주지만, 그 전에 여기서 막아 사용자에게 정확한 말을 해 준다.
    if (!inv.token) {
      setError("이미 완납된 달입니다. 결제할 금액이 없습니다.");
      return;
    }
    // 클라이언트 상한 확인 (서버가 다시 검증하지만 왕복 절약)
    if (!Number.isInteger(requestedAmount) || requestedAmount <= 0 || requestedAmount > inv.amountDue) {
      setError(`결제 금액은 1원 이상, ${inv.amountDue.toLocaleString()}원 이하여야 합니다.`);
      return;
    }
    try {
      const r = await authedFetch("/api/toss-kiosk/dispatch", {
        method: "POST",
        body: JSON.stringify({
          invoiceToken: inv.token,
          requestedAmount,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "결제 요청 실패");
      setDispatchId(body.dispatchId);
      setPayingAmount(body.amount ?? requestedAmount);
      setPayingMessage("결제 단말기에서 카드를 넣거나 태그해주세요.");
      setStage("paying");
      // 1.5초 폴링. 결제 완료까지 최대 3분.
      startDispatchPolling(body.dispatchId);
    } catch (e: any) {
      setError(e.message || "결제 요청 실패");
    }
  };

  const startDispatchPolling = (id: string) => {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    pollTimer.current = window.setInterval(async () => {
      try {
        const r = await authedFetch(`/api/toss-kiosk/dispatch/${id}`);
        if (!r.ok) return;
        const body = await r.json();
        if (body.status === "APPROVED") {
          window.clearInterval(pollTimer.current!);
          pollTimer.current = null;
          setStage("done");
          doneTimer.current = window.setTimeout(reset, 5000);
        } else if (body.status === "CANCELED" || body.status === "TIMEOUT" || body.status === "FAILED") {
          window.clearInterval(pollTimer.current!);
          pollTimer.current = null;
          setError(
            body.status === "TIMEOUT"
              ? "결제 시간이 초과되었습니다. 다시 시도해주세요."
              : body.status === "CANCELED"
              ? "결제가 취소되었습니다."
              : "결제 실패: " + (body.failureReason ?? "알 수 없는 오류")
          );
          setStage("error");
        } else if (body.status === "DELIVERED") {
          setPayingMessage("결제가 진행 중입니다. 잠시만 기다려주세요.");
        }
      } catch {
        // 네트워크 오류는 다음 tick에 다시 시도
      }
    }, 1500);
  };

  const cancelPayment = async () => {
    if (!dispatchId) return;
    try {
      await authedFetch(`/api/toss-kiosk/dispatch/${dispatchId}/cancel`, { method: "POST" });
    } catch {
      // ignore
    }
    reset();
  };

  useEffect(() => () => {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    if (doneTimer.current) window.clearTimeout(doneTimer.current);
  }, []);

  // ─── 렌더 ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="p-6 border-b border-slate-800 flex items-center justify-between">
        <div className="text-xl font-black">
          Page<span className="text-orange-500">O</span>ne
          <span className="ml-3 text-sm font-normal text-slate-400">학원 자동 수납</span>
        </div>
        {stage !== "phone" && (
          <button
            onClick={reset}
            className="text-sm text-slate-400 hover:text-slate-100 px-4 py-2 rounded-md hover:bg-slate-800"
            data-testid="button-home"
          >
            처음으로
          </button>
        )}
      </header>

      <main className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-3xl">
          {stage === "phone" && (
            <PhoneStage
              value={phoneSuffix}
              onChange={setPhoneSuffix}
              onSubmit={searchStudents}
              error={error}
            />
          )}
          {stage === "students" && (
            <StudentPickStage candidates={candidates} onPick={loadInvoices} error={error} />
          )}
          {stage === "invoices" && (
            <InvoicePickStage
              studentName={studentName}
              invoices={invoices}
              onPick={pickInvoice}
              error={error}
            />
          )}
          {stage === "amount" && selectedInvoice && (
            <AmountPickStage
              invoice={selectedInvoice}
              onConfirm={(amt) => startPayment(selectedInvoice, amt)}
              onBack={() => {
                setSelectedInvoice(null);
                setError(null);
                setStage("invoices");
              }}
              error={error}
            />
          )}
          {stage === "paying" && (
            <PayingStage
              amount={payingAmount}
              message={payingMessage}
              onCancel={cancelPayment}
            />
          )}
          {stage === "done" && <DoneStage />}
          {stage === "error" && <ErrorStage message={error || "오류"} onReset={reset} />}
        </div>
      </main>

      <footer className="p-4 text-center text-xs text-slate-600 border-t border-slate-800">
        문의는 원장님께 · 카드 결제 처리는 토스플레이스 결제 단말기에서 이루어집니다
      </footer>
    </div>
  );
}

// ─── 스테이지 컴포넌트 ──────────────────────────────────────────────────
function PhoneStage(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  error: string | null;
}) {
  const keypad = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "지움", "0", "확인"];
  return (
    <div className="space-y-8" data-testid="stage-phone">
      <div className="text-center">
        <h1 className="text-3xl font-bold">보호자 전화번호 뒤 4자리</h1>
        <p className="text-slate-400 mt-3">등록된 부모님 번호의 뒤 4자리를 입력하세요.</p>
      </div>
      <div className="flex justify-center gap-3 text-4xl font-mono tracking-widest">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`w-16 h-20 rounded-lg flex items-center justify-center border ${
              props.value.length > i ? "border-orange-500 bg-slate-800" : "border-slate-700 bg-slate-900"
            }`}
          >
            {props.value[i] ? "●" : ""}
          </div>
        ))}
      </div>
      {props.error && <div className="text-red-400 text-center">{props.error}</div>}
      <div className="grid grid-cols-3 gap-3 max-w-md mx-auto">
        {keypad.map((k) => (
          <button
            key={k}
            onClick={() => {
              if (k === "지움") props.onChange(props.value.slice(0, -1));
              else if (k === "확인") {
                if (props.value.length === 4) props.onSubmit();
              } else if (props.value.length < 4) props.onChange(props.value + k);
            }}
            className={`py-6 rounded-lg text-2xl font-semibold ${
              k === "확인"
                ? props.value.length === 4
                  ? "bg-orange-500 hover:bg-orange-400 text-white"
                  : "bg-slate-800 text-slate-600"
                : k === "지움"
                ? "bg-slate-800 hover:bg-slate-700"
                : "bg-slate-800 hover:bg-slate-700"
            }`}
            data-testid={`key-${k}`}
          >
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

function StudentPickStage(props: {
  candidates: StudentHit[];
  onPick: (s: StudentHit) => void;
  error: string | null;
}) {
  return (
    <div className="space-y-6" data-testid="stage-students">
      <h1 className="text-2xl font-bold text-center">본인을 선택해주세요</h1>
      {props.error && <div className="text-red-400 text-center">{props.error}</div>}
      <div className="grid gap-3 max-w-xl mx-auto">
        {props.candidates.map((c) => (
          <button
            key={c.id}
            onClick={() => props.onPick(c)}
            className="p-6 rounded-lg bg-slate-800 hover:bg-slate-700 text-left"
            data-testid={`student-${c.id}`}
          >
            <div className="text-xl font-semibold">{c.nameMasked}</div>
            <div className="text-sm text-slate-400 mt-1">
              {[c.school, c.grade, c.parentPhoneMasked].filter(Boolean).join(" · ")}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function InvoicePickStage(props: {
  studentName: string;
  invoices: Invoice[];
  onPick: (i: Invoice) => void;
  error: string | null;
}) {
  const unpaidTotal = props.invoices
    .filter((i) => i.status !== "완납")
    .reduce((s, i) => s + i.amountDue, 0);

  return (
    <div className="space-y-6" data-testid="stage-invoices">
      <div className="text-center">
        <h1 className="text-2xl font-bold">{props.studentName}님 수강료</h1>
        {unpaidTotal > 0 ? (
          <p className="text-slate-400 mt-2">
            남은 금액 <span className="text-orange-400 font-bold">{unpaidTotal.toLocaleString()}원</span>
            {" · "}결제할 항목을 선택하세요.
          </p>
        ) : (
          <p className="text-emerald-400 mt-2">미납 없이 모두 납부되었습니다.</p>
        )}
      </div>
      {props.error && <div className="text-red-400 text-center">{props.error}</div>}
      <div className="grid gap-3 max-w-xl mx-auto">
        {props.invoices.map((inv) => {
          // 완납 건은 보여 주되 누를 수 없다. 목록에서 아예 숨기면 학부모가
          // "낸 게 반영된 건지" 확인할 방법이 없어서 보여 주기로 했지만,
          // 누를 수 있게 두면 완납한 달을 또 결제하는 사고가 난다.
          const settled = inv.status === "완납" || !inv.token;
          const style = STATUS_STYLE[inv.status];
          return (
            <button
              key={`${inv.enrollmentId}-${inv.paymentMonth}`}
              onClick={() => !settled && props.onPick(inv)}
              disabled={settled}
              className={`p-6 rounded-lg text-left flex items-center justify-between ${
                settled ? "bg-slate-900 border border-slate-800 cursor-default" : "bg-slate-800 hover:bg-slate-700"
              }`}
              data-testid={`invoice-${inv.enrollmentId}-${inv.paymentMonth}`}
            >
              <div>
                <div className="text-lg font-semibold flex items-center gap-2">
                  <span className={settled ? "text-slate-400" : ""}>{inv.className}</span>
                  <span className="text-sm text-slate-400">{inv.paymentMonth}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full border ${style.badge}`}
                    data-testid={`invoice-status-${inv.enrollmentId}-${inv.paymentMonth}`}
                  >
                    {inv.status}
                  </span>
                </div>
                <div className="text-sm text-slate-500 mt-1">{inv.subject}</div>
                {/*
                  부분납이면 "27만원 중 1천원 냄, 26만 9천원 남음" 을 눈으로 확인할 수 있어야 한다.
                  잔액 숫자만 보면 학부모는 자기가 낸 1천원이 반영됐는지 알 수 없다.
                */}
                {inv.amountPaid > 0 && (
                  <div className="text-sm text-slate-400 mt-2">
                    {inv.tuition.toLocaleString()}원 중{" "}
                    <span className="text-emerald-400">{inv.amountPaid.toLocaleString()}원</span> 납부
                    {inv.amountDue > 0 && (
                      <>
                        {" · "}
                        <span className="text-amber-300">{inv.amountDue.toLocaleString()}원</span> 남음
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className={`text-2xl font-bold ${style.amount}`}>
                {settled ? "완납" : `${inv.amountDue.toLocaleString()}원`}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 결제 금액 선택 화면 (선납·부분결제 지원, 0.3.2~).
 *
 * 옵션:
 *   - 전액 결제: 청구서에 적힌 잔액을 그대로 결제.
 *   - 직접 입력: 학부모가 원하는 금액만 결제 (예: 이번 달 15만 원 중 10만 원만).
 *
 * 상한선(inv.amountDue)은 UI 에서 막지만, 서버 dispatch 가 다시 DB 실 잔액을 재계산해
 * 최종 검증한다. 즉 이 화면의 검증은 UX 편의이지 보안 방어가 아니다.
 */
function AmountPickStage(props: {
  invoice: Invoice;
  onConfirm: (amount: number) => void;
  onBack: () => void;
  error: string | null;
}) {
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [partialText, setPartialText] = useState<string>("");

  const partialAmount = (() => {
    const digitsOnly = partialText.replace(/[^0-9]/g, "");
    const n = digitsOnly ? parseInt(digitsOnly, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  })();

  const finalAmount = mode === "full" ? props.invoice.amountDue : partialAmount;
  const overCap = finalAmount > props.invoice.amountDue;
  const invalid = finalAmount <= 0 || overCap;

  return (
    <div className="space-y-8" data-testid="stage-amount">
      <div className="text-center">
        <h1 className="text-2xl font-bold">결제 금액 선택</h1>
        <p className="text-slate-400 mt-2">
          {props.invoice.className} · {props.invoice.paymentMonth}
        </p>
        <p className="text-slate-500 text-sm mt-1">
          잔액 <span className="text-orange-400 font-semibold">
            {props.invoice.amountDue.toLocaleString()}원
          </span>
        </p>
        {/*
          이미 일부를 낸 달이면 그 사실을 여기서도 다시 보여 준다. 앞 화면에서 봤더라도
          금액을 확정하는 이 순간에 "얼마 냈고 얼마 남았다"가 눈앞에 있어야 오입력이 준다.
        */}
        {props.invoice.amountPaid > 0 && (
          <p className="text-slate-500 text-sm mt-1">
            {props.invoice.tuition.toLocaleString()}원 중{" "}
            <span className="text-emerald-400">{props.invoice.amountPaid.toLocaleString()}원</span> 납부 완료
          </p>
        )}
      </div>

      <div className="grid gap-3 max-w-xl mx-auto">
        <button
          onClick={() => setMode("full")}
          className={`p-6 rounded-lg text-left border-2 transition-colors ${
            mode === "full"
              ? "bg-slate-800 border-orange-500"
              : "bg-slate-900 border-slate-700 hover:bg-slate-800"
          }`}
          data-testid="amount-mode-full"
        >
          {/* 부분납 상태면 "전액"은 청구액이 아니라 남은 금액 전부라는 뜻이다. 말을 구분한다. */}
          <div className="text-lg font-semibold">
            {props.invoice.amountPaid > 0 ? "남은 금액 전부 결제" : "전액 결제"}
          </div>
          <div className="text-2xl font-bold text-orange-400 mt-1">
            {props.invoice.amountDue.toLocaleString()}원
          </div>
        </button>

        <button
          onClick={() => setMode("partial")}
          className={`p-6 rounded-lg text-left border-2 transition-colors ${
            mode === "partial"
              ? "bg-slate-800 border-orange-500"
              : "bg-slate-900 border-slate-700 hover:bg-slate-800"
          }`}
          data-testid="amount-mode-partial"
        >
          <div className="text-lg font-semibold">일부 결제 (부분·선납)</div>
          {mode === "partial" && (
            <div className="mt-3 flex items-center gap-2">
              <input
                type="tel"
                inputMode="numeric"
                autoFocus
                value={partialText}
                onChange={(e) => setPartialText(e.target.value)}
                placeholder="예: 100000"
                className="flex-1 px-4 py-3 rounded-md bg-slate-950 border border-slate-700 text-2xl font-mono text-right"
                data-testid="amount-partial-input"
              />
              <span className="text-xl text-slate-400">원</span>
            </div>
          )}
          {mode === "partial" && overCap && (
            <div className="text-red-400 text-sm mt-2">
              잔액을 초과할 수 없습니다.
            </div>
          )}
        </button>
      </div>

      {props.error && <div className="text-red-400 text-center">{props.error}</div>}

      <div className="flex gap-3 justify-center max-w-xl mx-auto">
        <button
          onClick={props.onBack}
          className="flex-1 py-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-lg"
          data-testid="button-amount-back"
        >
          뒤로
        </button>
        <button
          onClick={() => props.onConfirm(finalAmount)}
          disabled={invalid}
          className={`flex-[2] py-4 rounded-lg text-lg font-bold ${
            invalid
              ? "bg-slate-800 text-slate-600"
              : "bg-orange-500 hover:bg-orange-400 text-white"
          }`}
          data-testid="button-amount-confirm"
        >
          {finalAmount > 0 ? `${finalAmount.toLocaleString()}원 결제` : "금액 입력"}
        </button>
      </div>
    </div>
  );
}

function PayingStage(props: { amount: number; message: string; onCancel: () => void }) {
  return (
    <div className="text-center space-y-8" data-testid="stage-paying">
      <div className="text-slate-400">결제 진행 중</div>
      <div className="text-6xl font-black text-orange-400">{props.amount.toLocaleString()}원</div>
      <div className="text-xl">{props.message}</div>
      <div className="animate-pulse text-sm text-slate-500">결제 단말기와 통신하고 있습니다...</div>
      <button
        onClick={props.onCancel}
        className="mt-8 text-sm text-slate-500 hover:text-slate-300 underline"
        data-testid="button-cancel-payment"
      >
        취소
      </button>
    </div>
  );
}

function DoneStage() {
  return (
    <div className="text-center space-y-6" data-testid="stage-done">
      <div className="text-8xl">✓</div>
      <h1 className="text-4xl font-bold text-emerald-400">결제 완료</h1>
      <p className="text-slate-400">감사합니다. 잠시 후 처음 화면으로 돌아갑니다.</p>
    </div>
  );
}

function ErrorStage(props: { message: string; onReset: () => void }) {
  return (
    <div className="text-center space-y-6" data-testid="stage-error">
      <div className="text-6xl">⚠</div>
      <h1 className="text-2xl font-bold text-red-400">{props.message}</h1>
      <button
        onClick={props.onReset}
        className="mt-6 bg-slate-800 hover:bg-slate-700 px-6 py-3 rounded-lg"
        data-testid="button-error-reset"
      >
        처음으로
      </button>
    </div>
  );
}
