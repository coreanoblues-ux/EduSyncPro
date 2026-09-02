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
import {
  INSTALLMENT_MIN_AMOUNT,
  INSTALLMENT_OPTIONS,
  LUMP_SUM,
  canChooseInstallment,
  installmentLabel,
} from "@shared/installment";

import {
  CUSTOM_LABEL_MAX,
  CUSTOM_MAX_AMOUNT,
  isValidCustomAmount,
  parseAmountText,
  sanitizeCustomLabel,
} from "@shared/customPayment";

// "custom" = 기타 결제(학생과 연결되지 않은 결제) 금액 입력 화면.
// 기존 흐름(phone→students→invoices→amount)에는 손대지 않고 옆으로 하나 붙인다.
type Stage = "phone" | "students" | "invoices" | "amount" | "custom" | "paying" | "done" | "error";

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
  /** 서버가 확정한 할부 개월 (0 = 일시불). 결제 진행 화면에 그대로 보여 준다. */
  const [payingInstallment, setPayingInstallment] = useState<number>(LUMP_SUM);
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
    // 다음 결제는 반드시 일시불에서 시작한다. 분할결제로 카드 두 장을 받을 때
    // 앞 카드의 3개월이 뒤 카드에 그대로 따라붙으면, 원장도 학부모도 그걸
    // 눈치채지 못한 채 승인이 난다. 할부는 카드 한 장마다 새로 고르는 것이다.
    setPayingInstallment(LUMP_SUM);
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

  const startPayment = async (inv: Invoice, requestedAmount: number, installment: number) => {
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
          installment,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "결제 요청 실패");
      setDispatchId(body.dispatchId);
      setPayingAmount(body.amount ?? requestedAmount);
      // 서버가 정규화한 값을 쓴다. 화면에서 고른 값이 아니다 — 금액이 깎이면
      // 서버가 일시불로 되돌릴 수 있고, 그때 화면만 "3개월" 이라고 떠 있으면
      // 학부모가 카드 명세서를 보고 학원을 의심하게 된다.
      setPayingInstallment(body.installment ?? LUMP_SUM);
      setPayingMessage("결제 단말기에서 카드를 넣거나 태그해주세요.");
      setStage("paying");
      // 1.5초 폴링. 결제 완료까지 최대 3분.
      startDispatchPolling(body.dispatchId);
    } catch (e: any) {
      setError(e.message || "결제 요청 실패");
    }
  };

  /**
   * 기타 결제 요청. 학생 결제(startPayment)와 부르는 곳만 다르고, 요청을 보낸
   * 뒤의 흐름(폴링·완료·취소)은 완전히 같은 코드를 탄다.
   *
   * 청구서 토큰이 없다. 이 결제에는 근거가 될 등록이 아예 없기 때문이다.
   * 대신 금액 상한 판정을 공용 규칙(@shared/customPayment)으로 하고, 서버가
   * 같은 규칙으로 다시 판정한다.
   */
  const startCustomPayment = async (amount: number, label: string, installment: number) => {
    setError(null);
    if (!isValidCustomAmount(amount)) {
      setError(`결제 금액은 1원 이상, ${CUSTOM_MAX_AMOUNT.toLocaleString()}원 이하여야 합니다.`);
      return;
    }
    try {
      const r = await authedFetch("/api/toss-kiosk/dispatch/custom", {
        method: "POST",
        body: JSON.stringify({ amount, label, installment }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "결제 요청 실패");
      setDispatchId(body.dispatchId);
      setPayingAmount(body.amount ?? amount);
      // 학생 결제와 같은 이유로 서버가 정규화한 값을 쓴다 (startPayment 주석 참고).
      setPayingInstallment(body.installment ?? LUMP_SUM);
      setPayingMessage("결제 단말기에서 카드를 넣거나 태그해주세요.");
      setStage("paying");
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
              onCustom={() => {
                setError(null);
                setStage("custom");
              }}
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
              /*
                key 로 청구서를 못 박아 둔다. 이 화면은 stage 가 바뀌면 어차피
                unmount 되지만, 나중에 누군가 "뒤로 없이 청구서만 갈아끼우는"
                흐름을 추가하면 앞 청구서에서 고른 할부가 그대로 남는다. 그건
                아무도 못 알아채는 종류의 버그라 여기서 미리 막는다.
              */
              key={`${selectedInvoice.enrollmentId}-${selectedInvoice.paymentMonth}`}
              invoice={selectedInvoice}
              onConfirm={(amt, inst) => startPayment(selectedInvoice, amt, inst)}
              onBack={() => {
                setSelectedInvoice(null);
                setError(null);
                setStage("invoices");
              }}
              error={error}
            />
          )}
          {stage === "custom" && (
            <CustomPayStage
              onConfirm={startCustomPayment}
              onBack={reset}
              error={error}
            />
          )}
          {stage === "paying" && (
            <PayingStage
              amount={payingAmount}
              installment={payingInstallment}
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
  onCustom: () => void;
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
      {/*
        기타 결제 입구.

        ── 왜 눈에 덜 띄게 두나 ──
        이 화면은 학부모·학생이 직접 만지는 화면이고, 정상 흐름은 어디까지나
        전화번호 4자리다. 기타 결제는 원장이 옆에서 금액을 불러 주며 쓰는 예외
        경로라, 크게 두면 학생이 호기심에 눌러 엉뚱한 금액이 단말기에 뜬다.
        (눌러도 카드를 대야 승인이 나므로 사고가 되진 않지만, 그 사이 진짜 결제는
        단말기가 막혀서 못 한다. 그게 실제 피해다.)
      */}
      <div className="text-center">
        <button
          onClick={props.onCustom}
          className="text-sm text-slate-500 hover:text-slate-300 underline underline-offset-4"
          data-testid="button-custom-payment"
        >
          등록되지 않은 결제 (미등록 학생·교재 등)
        </button>
      </div>
    </div>
  );
}

/**
 * 기타 결제 화면 — 학생과 연결되지 않은 결제.
 *
 * ── 무엇을 위한 화면인가 ──
 *   원장 요청 그대로다. "급하게 아직 등록 안 한 학생" 도, "학생과 무관한 자료 판매"도
 *   금액을 직접 입력해서 결제 요청을 걸 수 있어야 한다. 토스 단말기에는 금액을
 *   손으로 넣는 길이 마땅치 않아 태블릿에서 시작한다.
 *
 * ── 이 화면이 하지 않는 것 ──
 *   학생을 만들지 않는다. 등록(enrollment)도 만들지 않는다. 청구서도 만들지 않는다.
 *   그런 걸 여기서 만들면 나중에 원장이 정식 등록을 했을 때 유령 학생이 하나 더
 *   남는다. 여기서 남는 것은 "돈이 이만큼 들어왔다" 는 장부 한 줄뿐이고,
 *   그게 이 기능이 필요한 이유의 전부다.
 *
 * ── 확인 단계를 왜 두나 ──
 *   금액을 손으로 찍는 유일한 화면이다. 0 하나가 더 붙어도 화면은 아무 말이
 *   없고, 카드는 단말기 앞에서 즉시 긁힌다. 그래서 누르기 전에 한 번,
 *   큰 글씨로 금액을 다시 보여 준다.
 */
function CustomPayStage(props: {
  onConfirm: (amount: number, label: string, installment: number) => void;
  onBack: () => void;
  error: string | null;
}) {
  const [amountText, setAmountText] = useState("");
  const [label, setLabel] = useState("");
  const [installment, setInstallment] = useState<number>(LUMP_SUM);
  const [confirming, setConfirming] = useState(false);

  const amount = parseAmountText(amountText);
  const overCap = amount > CUSTOM_MAX_AMOUNT;
  const valid = isValidCustomAmount(amount);

  // 할부 규칙은 학생 결제와 한 벌을 쓴다 (shared/installment.ts).
  const installmentAvailable = canChooseInstallment(amount);
  const effectiveInstallment = installmentAvailable ? installment : LUMP_SUM;

  // 저장될 내용을 미리 확정해 확인 화면에 그대로 보여 준다. 서버도 같은 함수로
  // 다듬으므로, 여기 보이는 문구가 장부에 남는 문구와 같다.
  const finalLabel = sanitizeCustomLabel(label);

  if (confirming) {
    return (
      <div className="space-y-8 text-center" data-testid="stage-custom-confirm">
        <h1 className="text-2xl font-bold">이 금액으로 결제할까요?</h1>
        <div className="text-6xl font-black text-orange-400">{amount.toLocaleString()}원</div>
        <div className="text-lg text-slate-300">{finalLabel}</div>
        <div className="text-slate-400">{installmentLabel(effectiveInstallment)}</div>
        <p className="text-sm text-slate-500">
          확인을 누르면 결제 단말기에 이 금액이 뜹니다.
        </p>
        <div className="flex gap-3 justify-center max-w-xl mx-auto">
          <button
            onClick={() => setConfirming(false)}
            className="flex-1 py-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-lg"
            data-testid="button-custom-edit"
          >
            수정
          </button>
          <button
            onClick={() => props.onConfirm(amount, finalLabel, effectiveInstallment)}
            className="flex-[2] py-4 rounded-lg text-lg font-bold bg-orange-500 hover:bg-orange-400 text-white"
            data-testid="button-custom-confirm"
          >
            확인 · 결제 요청
          </button>
        </div>
        {props.error && <div className="text-red-400">{props.error}</div>}
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="stage-custom">
      <div className="text-center">
        <h1 className="text-2xl font-bold">등록되지 않은 결제</h1>
        <p className="text-slate-400 mt-2">
          아직 등록되지 않은 학생이거나 교재·자료 판매처럼 수강 등록과 연결되지 않는 결제입니다.
        </p>
        <p className="text-slate-500 text-sm mt-1">
          이 결제는 수강료 미납 내역에 반영되지 않고, 장부에는 <b>기타</b>로 기록됩니다.
        </p>
      </div>

      <div className="max-w-xl mx-auto space-y-5">
        <div>
          <label className="block text-sm text-slate-400 mb-2">금액</label>
          <div className="flex items-center gap-2">
            <input
              type="tel"
              inputMode="numeric"
              autoFocus
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              placeholder="예: 150000"
              className="flex-1 px-4 py-4 rounded-md bg-slate-950 border border-slate-700 text-3xl font-mono text-right"
              data-testid="custom-amount-input"
            />
            <span className="text-xl text-slate-400">원</span>
          </div>
          {/* 자릿수 실수를 즉시 눈으로 확인시킨다. 숫자판만 보면 0 개수를 못 센다. */}
          {amount > 0 && !overCap && (
            <div className="text-right text-orange-400 mt-2 text-lg" data-testid="custom-amount-echo">
              {amount.toLocaleString()}원
            </div>
          )}
          {overCap && (
            <div className="text-red-400 text-sm mt-2">
              한 건에 {CUSTOM_MAX_AMOUNT.toLocaleString()}원을 넘을 수 없습니다. 나누어 결제해 주세요.
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm text-slate-400 mb-2">
            내용 (선택) — 장부에 그대로 남습니다
          </label>
          <input
            type="text"
            value={label}
            maxLength={CUSTOM_LABEL_MAX}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="예: 김민준 3월 수강료(등록 전) / 교재 3권"
            className="w-full px-4 py-3 rounded-md bg-slate-950 border border-slate-700 text-lg"
            data-testid="custom-label-input"
          />
        </div>

        {installmentAvailable && (
          <div data-testid="custom-installment-picker">
            <div className="text-sm text-slate-400 mb-2">할부 개월 선택</div>
            <div className="grid grid-cols-4 gap-2">
              {[LUMP_SUM, ...INSTALLMENT_OPTIONS].map((n) => {
                const active = effectiveInstallment === n;
                return (
                  <button
                    key={n}
                    onClick={() => setInstallment(n)}
                    className={`py-3 rounded-lg text-base font-semibold border-2 transition-colors ${
                      active
                        ? "bg-slate-800 border-orange-500 text-orange-300"
                        : "bg-slate-900 border-slate-700 hover:bg-slate-800 text-slate-300"
                    }`}
                    data-testid={`custom-installment-${n}`}
                  >
                    {n === LUMP_SUM ? "일시불" : `${n}개월`}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-slate-500 mt-2">
              할부 이자와 수수료는 카드사 정책에 따릅니다. 카드사에 따라 선택하신 개월수가
              승인되지 않을 수 있습니다.
            </p>
          </div>
        )}
        {!installmentAvailable && amount > 0 && !overCap && (
          <p className="text-xs text-slate-500 text-center">
            할부는 {INSTALLMENT_MIN_AMOUNT.toLocaleString()}원 이상부터 선택할 수 있습니다. 이
            결제는 일시불로 진행됩니다.
          </p>
        )}
      </div>

      {props.error && <div className="text-red-400 text-center">{props.error}</div>}

      <div className="flex gap-3 justify-center max-w-xl mx-auto">
        <button
          onClick={props.onBack}
          className="flex-1 py-4 rounded-lg bg-slate-800 hover:bg-slate-700 text-lg"
          data-testid="button-custom-back"
        >
          뒤로
        </button>
        <button
          onClick={() => setConfirming(true)}
          disabled={!valid}
          className={`flex-[2] py-4 rounded-lg text-lg font-bold ${
            valid ? "bg-orange-500 hover:bg-orange-400 text-white" : "bg-slate-800 text-slate-600"
          }`}
          data-testid="button-custom-next"
        >
          {valid ? `${amount.toLocaleString()}원 확인` : "금액 입력"}
        </button>
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
  onConfirm: (amount: number, installment: number) => void;
  onBack: () => void;
  error: string | null;
}) {
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [partialText, setPartialText] = useState<string>("");
  // 기본은 언제나 일시불이다. 할부를 기본으로 두면 아무 생각 없이 넘긴 학부모가
  // 이자를 물게 된다. 고른 사람만 할부가 되어야 한다.
  const [installment, setInstallment] = useState<number>(LUMP_SUM);

  const partialAmount = (() => {
    const digitsOnly = partialText.replace(/[^0-9]/g, "");
    const n = digitsOnly ? parseInt(digitsOnly, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  })();

  const finalAmount = mode === "full" ? props.invoice.amountDue : partialAmount;
  const overCap = finalAmount > props.invoice.amountDue;
  const invalid = finalAmount <= 0 || overCap;

  // 할부 가능 여부는 **지금 화면에 떠 있는 금액**으로 판단한다. 일부 결제로
  // 금액을 5만원 아래로 내리면 선택지가 그 자리에서 사라져야 한다. 안 그러면
  // 3개월을 골라 둔 채 금액만 3만원으로 바꾸고 결제 버튼을 누르게 된다.
  const installmentAvailable = canChooseInstallment(finalAmount);
  // 고른 뒤에 금액이 내려간 경우, 화면에 남아 있는 선택은 무효다. 서버도 같은
  // 판정을 다시 하지만(shared/installment.ts), 사용자에게 보이는 숫자와 실제로
  // 보내는 값이 다르면 안 되므로 여기서도 확정한다.
  const effectiveInstallment = installmentAvailable ? installment : LUMP_SUM;

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

      {/*
        할부 선택.

        ── 언제 보이나 ──
        결제 금액이 5만원 이상일 때만. 이건 토스 SDK 제약이 아니라 국내 카드사
        관행이다(shared/installment.ts 주석 참고). 5만원 미만에서 할부를 고르게
        두면 카드사가 거절하고, 학부모는 카드를 단말기에 댄 채로 이유를 알 수 없는
        실패를 본다. 아예 안 보여 주는 편이 친절하다.

        ── "무이자" 라고 쓰지 않는 이유 ──
        무이자 여부는 카드사 프로모션이고 우리는 알 방법이 없다. 화면에 그렇게
        적었다가 실제로 이자가 붙으면 학원이 거짓말을 한 것이 된다. 개월수만 적는다.
      */}
      {installmentAvailable && (
        <div className="max-w-xl mx-auto" data-testid="installment-picker">
          <div className="text-sm text-slate-400 mb-2">할부 개월 선택</div>
          <div className="grid grid-cols-4 gap-2">
            {[LUMP_SUM, ...INSTALLMENT_OPTIONS].map((n) => {
              const active = effectiveInstallment === n;
              return (
                <button
                  key={n}
                  onClick={() => setInstallment(n)}
                  className={`py-3 rounded-lg text-base font-semibold border-2 transition-colors ${
                    active
                      ? "bg-slate-800 border-orange-500 text-orange-300"
                      : "bg-slate-900 border-slate-700 hover:bg-slate-800 text-slate-300"
                  }`}
                  data-testid={`installment-${n}`}
                >
                  {n === LUMP_SUM ? "일시불" : `${n}개월`}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-slate-500 mt-2">
            할부 이자와 수수료는 카드사 정책에 따릅니다. 카드사에 따라 선택하신 개월수가
            승인되지 않을 수 있습니다.
          </p>
        </div>
      )}
      {/*
        5만원 미만이라 선택지를 감췄을 때, 아무 설명도 없으면 원장에게 "할부 버튼이
        사라졌다" 는 문의가 온다. 조건을 한 줄로 적어 둔다.
      */}
      {!installmentAvailable && finalAmount > 0 && (
        <p className="max-w-xl mx-auto text-xs text-slate-500 text-center">
          할부는 {INSTALLMENT_MIN_AMOUNT.toLocaleString()}원 이상부터 선택할 수 있습니다. 이
          결제는 일시불로 진행됩니다.
        </p>
      )}

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
          onClick={() => props.onConfirm(finalAmount, effectiveInstallment)}
          disabled={invalid}
          className={`flex-[2] py-4 rounded-lg text-lg font-bold ${
            invalid
              ? "bg-slate-800 text-slate-600"
              : "bg-orange-500 hover:bg-orange-400 text-white"
          }`}
          data-testid="button-amount-confirm"
        >
          {finalAmount > 0
            ? `${finalAmount.toLocaleString()}원 ${
                effectiveInstallment >= 2 ? `${effectiveInstallment}개월 할부 ` : ""
              }결제`
            : "금액 입력"}
        </button>
      </div>
    </div>
  );
}

function PayingStage(props: {
  amount: number;
  installment: number;
  message: string;
  onCancel: () => void;
}) {
  return (
    <div className="text-center space-y-8" data-testid="stage-paying">
      <div className="text-slate-400">결제 진행 중</div>
      <div className="text-6xl font-black text-orange-400">{props.amount.toLocaleString()}원</div>
      {/*
        카드를 대기 **직전**에 할부 개월을 한 번 더 보여 준다. 승인이 난 뒤에
        "3개월로 하려던 건데요" 를 듣는 것보다, 대기 화면에서 학부모가 스스로
        확인하고 취소를 누르는 편이 훨씬 낫다. 여기 값은 서버가 확정한 값이다.
      */}
      <div className="text-lg text-slate-300" data-testid="paying-installment">
        {installmentLabel(props.installment)}
      </div>
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
