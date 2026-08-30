/**
 * 큰 금액 취소 앞에 두는 잠금장치.
 *
 * ── 왜 필요한가 ──
 *   수납 목록에서 취소 버튼은 줄마다 똑같이 생겼고, 줄 간격은 좁다. 지금 화면에는
 *   시험용 1,000원 결제들 **사이에 269,000원 한 건이 끼어 있다.** 손가락이 한 줄
 *   미끄러지면 원비 전액이 학부모 카드로 돌아간다.
 *
 *   결제 실수는 되돌릴 수 있다 — 취소하면 된다. 하지만 **취소 실수는 되돌릴 수
 *   없다.** 다시 받으려면 학부모에게 연락해 카드를 다시 받아야 한다. 그래서
 *   두 방향의 위험이 대칭이 아니고, 취소 쪽에만 문턱을 둔다.
 *
 * ── 왜 "확인하시겠습니까?" 한 번 더가 아니라 금액 입력인가 ──
 *   확인 버튼은 손이 기억해서 누른다. 눌러야 할 것을 읽지 않고 누르는 게
 *   확인 대화상자의 본질적 한계다. 금액을 직접 쳐 넣게 하면 **숫자를 읽는 행위**
 *   자체가 강제된다. 269000 을 치는 동안 "어? 1,000원이 아니네" 를 알아차린다.
 *   이게 이 장치가 막으려는 유일한 사고다.
 *
 * ── 문턱을 10만원으로 둔 이유 ──
 *   시험(1,000원)은 막지 않고 원비 한 달치(보통 20~30만원)는 막는 선이다.
 *   낮추면 시험이 번거로워지고, 높이면 정작 막아야 할 것을 놓친다.
 */

/** 이 금액 이상이면 금액을 직접 입력해야 취소 버튼이 열린다. */
export const AMOUNT_TYPING_THRESHOLD = 100_000;

/** 이 취소가 금액 직접 입력을 요구하는가. */
export function requiresAmountTyping(amount: number): boolean {
  if (!Number.isFinite(amount)) return true; // 금액을 모르면 막는 쪽으로 튼다
  return amount >= AMOUNT_TYPING_THRESHOLD;
}

/**
 * 입력한 문자열이 그 금액과 일치하는가.
 *
 * 사람이 치는 값이라 "269,000" · "269000" · " 269000 " 을 모두 같게 본다.
 * 관대함의 방향에 주의: 표기 흔들림은 받아주되 **숫자 자체는 정확해야 한다.**
 * 269001 은 통과하지 못한다. 통과시키면 이 장치가 있으나 마나 해진다.
 */
export function amountTypingMatches(typed: string, amount: number): boolean {
  if (typeof typed !== "string") return false;
  const cleaned = typed.replace(/[,\s원]/g, "");
  if (cleaned === "" || !/^\d+$/.test(cleaned)) return false;
  return Number(cleaned) === amount;
}

/**
 * 취소 버튼을 열어도 되는가. 화면은 이 한 함수만 물어본다 —
 * 문턱 판정과 일치 판정이 화면 코드에서 갈라지면 한쪽만 고쳐지기 때문이다.
 */
export function canSubmitCancel(amount: number, typed: string): boolean {
  if (!requiresAmountTyping(amount)) return true;
  return amountTypingMatches(typed, amount);
}
