/**
 * EduSyncPro 로비 키오스크 — Toss Front 2 플러그인 진입점.
 *
 * 화면 흐름:
 *   1. 대기 화면 → "부모님 번호 뒤 4자리" 입력
 *   2. 학생 후보가 여러 명이면 골라내는 화면
 *   3. 학생 확인 후 두 갈래:
 *      - "출석 체크" → 오늘 예정된 반 목록 → 반 선택 → 서버에 체크인
 *      - "학원비 결제" → 미납 청구서 목록 → 청구서 선택 → 카드 결제
 *   4. 완료 화면 (성공/실패) → 자동으로 대기 화면 복귀
 *
 * SDK 상세는 토스 개발자센터의 "Front Plugin Template API" 문서에 맞춘다.
 * 여기서는 SDK 인터페이스를 최소한만 가정한 얇은 구현으로 두어, 실제 SDK와
 * 연결할 때 표면적을 좁혀 놓는다.
 */

import {
  setDeviceKey,
  searchStudentsByPhoneSuffix,
  fetchTodayClasses,
  checkInAttendance,
  fetchInvoices,
  createPaymentIntent,
  confirmPayment,
  cancelPayment,
  type StudentSummary,
  type Invoice,
  type TodayClass,
} from "./api";

// ─── SDK 인터페이스 가정 (실 SDK에 맞춰 어댑터로 교체) ───────────────
// 이 자리는 실제 window.tossFront 또는 import 대상 SDK로 치환된다.
declare const sdk: {
  template: {
    show(spec: TemplateSpec): Promise<TemplateResult>;
  };
  payment: {
    requestPayment(input: PaymentRequest): Promise<PaymentResult>;
    requestPaymentCancel?(input: { paymentKey: string }): Promise<void>;
  };
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
};

type TemplateSpec = {
  title?: string;
  body?: unknown;
  buttons?: Array<{ id: string; label: string; style?: "primary" | "secondary" | "danger" }>;
  input?: { id: string; placeholder?: string; type?: "text" | "number" | "digits4" };
};

type TemplateResult = { buttonId?: string; inputValue?: string };

type PaymentRequest = {
  paymentKey: string;
  orderId: string;
  amount: number;
  orderName: string;
  method?: "CARD";
};

type PaymentResult = {
  paymentKey: string;
  orderId: string;
  amount: number;
  paymentMethod: "CARD" | "CASH" | "BARCODE";
  approvalNumber: string;
  approvedTimestamp: string;
  van?: string;
  tid?: string;
  vanTransactionKey?: string;
  maskedCardNumber?: string;
  issuerName?: string;
  acquirerName?: string;
  cardType?: string;
  installment?: number;
  raw?: any;
};

// ─── 부팅 ─────────────────────────────────────────────────────────────
export async function bootstrap() {
  const key = await sdk.storage.getItem("deviceKey");
  if (!key) {
    // 원장이 서버 화면에서 발급한 deviceKey를 붙여넣기 하는 최초 설정 화면.
    // 실제 배포에서는 SDK의 setup 페이지에서 처리하지만, 최소 안전망으로 여기서도 받는다.
    const r = await sdk.template.show({
      title: "단말기 등록",
      body: "관리자 화면에서 발급받은 등록 코드를 입력하세요.",
      input: { id: "code", placeholder: "deviceKey" },
      buttons: [{ id: "save", label: "저장", style: "primary" }],
    });
    if (r.buttonId === "save" && r.inputValue) {
      await sdk.storage.setItem("deviceKey", r.inputValue.trim());
      setDeviceKey(r.inputValue.trim());
    } else {
      return; // 다음 부팅 때 다시 물어봄
    }
  } else {
    setDeviceKey(key);
  }
  await mainLoop();
}

async function mainLoop() {
  // 무한 루프 — 한 손님 처리가 끝나면 다음 손님을 위해 대기 화면으로 돌아온다.
  // catch 안에서만 예외 처리하고 루프는 절대 종료시키지 않는다 — 학원 문 열려 있는
  // 동안 태블릿이 꺼지면 안 되기 때문이다.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await handleOneVisitor();
    } catch (err) {
      console.error("[plugin] 예외:", err);
      await showErrorAndContinue(err);
    }
  }
}

async function handleOneVisitor() {
  const student = await promptStudent();
  if (!student) return;

  while (true) {
    const menu = await sdk.template.show({
      title: `${student.name} 학생`,
      body: `${student.grade ?? ""} · ${student.school ?? ""}`.trim(),
      buttons: [
        { id: "attend", label: "출석 체크", style: "primary" },
        { id: "pay", label: "학원비 결제", style: "primary" },
        { id: "exit", label: "다른 학생", style: "secondary" },
      ],
    });
    if (menu.buttonId === "attend") await runAttendance(student);
    else if (menu.buttonId === "pay") await runPayment(student);
    else return;
  }
}

async function promptStudent(): Promise<StudentSummary | null> {
  const r = await sdk.template.show({
    title: "안녕하세요",
    body: "부모님 전화번호 뒤 4자리를 입력하세요.",
    input: { id: "suffix", type: "digits4", placeholder: "0000" },
    buttons: [
      { id: "search", label: "확인", style: "primary" },
      { id: "cancel", label: "취소", style: "secondary" },
    ],
  });
  if (r.buttonId !== "search" || !r.inputValue) return null;
  const suffix = r.inputValue.trim();
  if (!/^\d{4}$/.test(suffix)) {
    await sdk.template.show({
      title: "잘못된 입력",
      body: "숫자 4자리를 입력해 주세요.",
      buttons: [{ id: "ok", label: "확인" }],
    });
    return null;
  }
  const candidates = await searchStudentsByPhoneSuffix(suffix);
  if (candidates.length === 0) {
    await sdk.template.show({
      title: "학생을 찾을 수 없어요",
      body: "번호를 다시 확인해 주세요. 그래도 안 되면 카운터에 알려 주세요.",
      buttons: [{ id: "ok", label: "확인" }],
    });
    return null;
  }
  if (candidates.length === 1) return candidates[0];
  // 여러 명이면 학년·학교로 골라 준다.
  const pick = await sdk.template.show({
    title: "학생을 골라 주세요",
    body: candidates.map((s) => ({
      id: s.id,
      title: s.name,
      subtitle: `${s.grade ?? ""} · ${s.school ?? ""}`.trim(),
    })),
    buttons: candidates.map((s) => ({ id: s.id, label: s.name })),
  });
  return candidates.find((s) => s.id === pick.buttonId) ?? null;
}

async function runAttendance(student: StudentSummary) {
  const { classes } = await fetchTodayClasses(student.id);
  if (classes.length === 0) {
    await sdk.template.show({
      title: "오늘 예정된 반이 없어요",
      body: "카운터에 알려 주세요.",
      buttons: [{ id: "ok", label: "확인" }],
    });
    return;
  }
  const pick = await sdk.template.show({
    title: "어느 반이에요?",
    body: classes.map((c: TodayClass) => ({
      id: c.classId,
      title: c.className,
      subtitle: c.subject,
      disabled: c.alreadyCheckedIn,
      note: c.alreadyCheckedIn ? "이미 체크됨" : null,
    })),
    buttons: classes
      .filter((c) => !c.alreadyCheckedIn)
      .map((c) => ({ id: c.classId, label: c.className })),
  });
  if (!pick.buttonId) return;
  const chosen = classes.find((c) => c.classId === pick.buttonId);
  if (!chosen) return;
  await checkInAttendance({ studentId: student.id, classId: chosen.classId });
  await sdk.template.show({
    title: "출석 완료",
    body: `${student.name} · ${chosen.className}`,
    buttons: [{ id: "ok", label: "확인", style: "primary" }],
  });
}

async function runPayment(student: StudentSummary) {
  const { invoices } = await fetchInvoices(student.id);
  if (invoices.length === 0) {
    await sdk.template.show({
      title: "결제할 항목이 없어요",
      body: "이번 달·지난 달 미납이 없습니다.",
      buttons: [{ id: "ok", label: "확인" }],
    });
    return;
  }
  const pick = await sdk.template.show({
    title: "결제할 청구서를 골라 주세요",
    body: invoices.map((iv: Invoice) => ({
      id: iv.token,
      title: `${iv.className} (${iv.paymentMonth})`,
      subtitle: `${iv.amountDue.toLocaleString()}원`,
    })),
    buttons: invoices.map((iv, i) => ({
      id: iv.token,
      label: `${iv.className} ${iv.amountDue.toLocaleString()}원`,
    })),
  });
  const chosen = invoices.find((iv) => iv.token === pick.buttonId);
  if (!chosen) return;

  // 서버가 paymentKey를 미리 발급 → SDK에 넘겨 결제창을 띄운다.
  const intent = await createPaymentIntent(chosen.token);
  let sdkResult: PaymentResult;
  try {
    sdkResult = await sdk.payment.requestPayment({
      paymentKey: intent.paymentKey,
      orderId: intent.orderId,
      amount: intent.amount,
      orderName: intent.orderName,
      method: "CARD",
    });
  } catch (err) {
    // 사용자가 취소했거나 SDK가 실패했으면 intent를 CANCELED로 표시.
    // 서버 상태를 방치하지 않기 위한 조치.
    try {
      await cancelPayment(intent.paymentKey, "sdk cancelled");
    } catch {
      /* 무시 — 관리자 화면에서 만료로 정리된다 */
    }
    throw err;
  }

  // 서버로 확정. idempotent라 재시도 안전.
  await confirmPayment({
    paymentKey: sdkResult.paymentKey,
    orderId: sdkResult.orderId,
    amount: sdkResult.amount,
    paymentMethod: sdkResult.paymentMethod,
    approvalNumber: sdkResult.approvalNumber,
    approvedTimestamp: sdkResult.approvedTimestamp,
    van: sdkResult.van,
    tid: sdkResult.tid,
    vanTransactionKey: sdkResult.vanTransactionKey,
    maskedCardNumber: sdkResult.maskedCardNumber,
    issuerName: sdkResult.issuerName,
    acquirerName: sdkResult.acquirerName,
    cardType: sdkResult.cardType,
    installment: sdkResult.installment ?? 0,
    rawResponse: sdkResult.raw,
  });

  await sdk.template.show({
    title: "결제 완료",
    body: `${student.name} · ${chosen.className} · ${chosen.amountDue.toLocaleString()}원`,
    buttons: [{ id: "ok", label: "확인", style: "primary" }],
  });
}

async function showErrorAndContinue(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  await sdk.template.show({
    title: "오류",
    body: msg,
    buttons: [{ id: "ok", label: "확인" }],
  });
}

// SDK 부팅 훅에 등록. 실제 SDK 시그니처에 맞춰 어댑터로 붙인다.
// 여기서는 export만 하고 SDK가 이 함수를 호출하도록 매니페스트에서 지시한다.
(globalThis as any).__eduSyncPluginBootstrap = bootstrap;
