/**
 * 기타 결제 정책 (순수 함수, 클라이언트·서버 공용).
 *
 * ── 기타 결제란 ──
 *   학원 웹앱에 학생으로 등록되지 않은 건을 태블릿에서 금액을 직접 입력해
 *   결제 요청하는 것. 두 경우를 모두 덮는다:
 *     · 아직 등록 절차가 끝나지 않았는데 오늘 당장 수납해야 하는 학생
 *     · 학생과 무관한 판매 (교재·자료·보충 교재 등)
 *
 * ── 학생 결제와 무엇이 다른가 ──
 *   학생 결제의 금액은 서버가 아는 사실(청구서 잔액)이 있어서 태블릿이 보낸 값이
 *   검증 대상이다. 기타 결제에는 대조할 사실이 서버에 없다 — 금액을 정하는 주체가
 *   사람이다. 그래서 서버가 할 수 있는 일은 형식 검사와 상한뿐이고, 그 규칙을
 *   화면과 서버가 서로 다르게 갖고 있으면 안 되므로 여기 한 벌만 둔다.
 *
 * ── 왜 파일을 따로 두나 ──
 *   installment.ts 와 섞으면 "할부 정책" 과 "기타 결제 정책" 이 한 파일에서
 *   서로를 참조하게 되고, 나중에 한쪽을 고치다 다른 쪽을 건드린다. 지금 잘 돌고
 *   있는 것을 건드리지 않는 가장 확실한 방법은 새 파일에 담는 것이다.
 */

/**
 * 기타 결제 한 건의 상한 (원).
 *
 * 태블릿 숫자판에서 손으로 찍는 값이라 0 을 하나 더 누르는 실수가 실제로 난다.
 * 학원 한 건 결제로 천만 원을 넘길 일은 없다. 막혀도 결제가 불가능해지는 게
 * 아니라 나눠 받으면 되므로, 상한은 넉넉하되 자릿수 실수는 잡는 선에 둔다.
 */
export const CUSTOM_MAX_AMOUNT = 10_000_000;

/** 내용(라벨) 최대 길이. 단말기 화면·영수증에 그대로 찍히므로 짧게 끊는다. */
export const CUSTOM_LABEL_MAX = 40;

/**
 * 내용을 비워 두었을 때 대신 적는 말.
 *
 * 빈 문자열로 두지 않는 이유: 이 값은 나중에 장부(payments.notes)에 남는
 * 유일한 단서다. 등록이 연결돼 있지 않으니 "무슨 돈이었나" 를 되짚을 근거가
 * 이 한 줄밖에 없다. 비어 있는 것보다 "기타 결제" 라도 적혀 있는 편이 낫다.
 */
export const DEFAULT_CUSTOM_LABEL = "기타 결제";

/**
 * 사람이 입력한 내용을 저장·표시용으로 다듬는다.
 *
 * 줄바꿈·탭을 지우는 이유는 단말기 표시와 영수증이 한 줄짜리 필드이기 때문이다.
 * 붙여넣기 한 번에 여러 줄이 들어오면 그 뒤 글자가 통째로 잘려 보인다.
 */
export function sanitizeCustomLabel(raw: string | null | undefined): string {
  const cleaned = (raw ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (!cleaned) return DEFAULT_CUSTOM_LABEL;
  return cleaned.slice(0, CUSTOM_LABEL_MAX);
}

/**
 * 숫자판·키보드로 들어온 문자열을 금액으로 읽는다.
 *
 * 숫자 이외의 글자는 전부 버린다 — "100,000" 이나 "100000원" 을 그대로 쳐도
 * 통하게 하기 위해서다. 읽을 수 없으면 0 을 돌려주고, 0 은 아래 isValid 에서
 * 걸린다. 여기서 예외를 던지지 않는 이유는 이 함수가 타이핑 중에 매 글자마다
 * 불리기 때문이다.
 */
export function parseAmountText(text: string | null | undefined): number {
  const digits = (text ?? "").replace(/[^0-9]/g, "");
  if (!digits) return 0;
  const n = Number.parseInt(digits, 10);
  return Number.isSafeInteger(n) ? n : 0;
}

/** 이 금액으로 기타 결제를 걸 수 있는가. 화면과 서버가 같은 답을 내야 한다. */
export function isValidCustomAmount(amount: number): boolean {
  return Number.isInteger(amount) && amount > 0 && amount <= CUSTOM_MAX_AMOUNT;
}
