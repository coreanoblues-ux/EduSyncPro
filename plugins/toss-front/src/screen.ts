/**
 * 정적 안내 텍스트 안전망 (0.3.26 전면 재작성 — 2026-09-10 검수 반려 대응).
 *
 * ── 원칙 (docs.tossplace.com/reference/plugin-sdk/front/template.html) ──
 *   "프론트 플러그인의 화면은 반드시 Template API(sdk.template.*)로 구성해야 하며,
 *    HTML/CSS를 직접 작성하여 화면을 구성할 수 없어요."
 *
 *   그래서 이 파일은 화면을 **그리지 않는다.** DOM 노드를 만들지도, 붙이지도,
 *   스타일을 넣지도 않는다 (createElement / appendChild / innerHTML /
 *   setAttribute("style") 전부 없음). 하는 일은 딱 두 가지다:
 *
 *     1) index.html 에 **미리 선언되어 있는** 정적 안내 노드(#boot)의
 *        textContent 를 바꾼다.
 *     2) 그 노드를 hidden 속성으로 보이거나 숨긴다.
 *
 * ── 왜 이렇게 바뀌었나 (0.3.25 까지의 반려 경위) ──
 *   0.3.23: 폴백에 버튼·입력폼 → 반려 (조작 요소).
 *   0.3.24: 버튼은 뺐지만 로고·SVG 카드 그래픽·링 애니메이션·상태 pill·3단계
 *           안내가 있는 브랜드 대기화면(paintIdle)과 결제/취소 진행 화면
 *           (showBusy/showCancelBusy)이 남아 있었고, 특히 대기화면은 SDK 실패
 *           여부와 무관하게 **부팅 정상 흐름에서 먼저** 그려졌다 → 다시 반려.
 *           "화면을 직접 구성하는 수준" 으로 판정된 것이 정확히 그 코드다.
 *   0.3.26: 자체 렌더러를 전부 지웠다. 정상 흐름의 화면은 전부 sdk.template.* 이고,
 *           이 파일은 표준 화면을 **못 띄웠을 때만** 보이는 텍스트 안전망이다.
 *
 * ── 안전망이 필요한 이유는 그대로다 ──
 *   0.2.x 의 "검은 화면, 단서 없음" 사고. 단말기에는 개발자도구가 없으므로,
 *   표준 화면이 안 그려지는 상황에서는 정적 텍스트와 진단 로그 몇 줄이
 *   원장이 원인을 읽을 유일한 수단이다. 그 한계 안에서만 일한다 —
 *   조작 요소 없음, 새 DOM 없음, 기존 노드의 글자만 바뀐다.
 *
 * ── 생명주기 규칙 ──
 *   · showStaticNotice()  — 표준 화면 실패가 확인된 자리에서만 부른다.
 *   · hideStaticNotice()  — 표준 화면(renderIdlePage 등)이 실제로 그려졌음이
 *     확인됐을 때, 또는 화면을 SDK·토스에게 넘기기 직전에 부른다.
 *     #boot 은 position:fixed·inset:0 이라 숨기지 않으면 표준 화면을 덮는다.
 *   · remove() 는 쓰지 않는다 (0.3.25 까지는 지웠다). 지우면 다음 실패 때
 *     안전망이 없다. hidden 토글이므로 몇 번이든 다시 쓸 수 있다.
 *     (#boot 의 CSS 는 display:flex 라 hidden 속성만으로는 안 숨는다.
 *      index.html 이 #boot[hidden]{display:none!important} 를 함께 선언한다.)
 */

/** index.html 에 미리 선언된 정적 노드들의 id. 여기서 만들지 않는다. */
const BOOT_ID = "boot";
const BRAND_ID = "boot-brand";
const TITLE_ID = "boot-title";
const DETAIL_ID = "boot-detail";
const DIAG_ID = "boot-diag";

const MAX_DIAG_LINES = 6;

/**
 * 진단 한 줄의 최대 길이.
 *
 * ── 왜 400 인가 (2026-08-29, 원장 사진) ──
 *   160자로 잘랐더니 "…Minified R" 에서 끊겼다. 잘린 자리 바로 뒤가 React 오류
 *   번호였다 — 원인을 화면에서 우리가 지운 셈이다. 진단 줄의 존재 이유가
 *   "단말기 앞에서 원인을 읽는 것"이므로 길이는 넉넉히 준다.
 */
const MAX_DIAG_LINE_CHARS = 400;

let diagLines: string[] = [];
let versionLabel = "";

function byId(id: string): HTMLElement | null {
  return typeof document !== "undefined" ? document.getElementById(id) : null;
}

/**
 * 안내 첫 줄에 찍을 플러그인 버전. bootstrap 맨 앞에서 한 번 부른다.
 *
 * index.html 의 브랜드 줄에는 버전이 하드코딩되어 있다 — 그 글자가 그대로면
 * "번들 스크립트가 로드조차 안 됐다"는 뜻이다. 이 함수가 package.json 에서
 * 주입된 값으로 덮어쓰면 "플러그인 코드가 실행됐다"는 뜻이 된다. 원장이 보낸
 * 사진 한 장으로 어느 ZIP 이 돌고 있는지 판별하는 수단이다 (0.3.5~0.3.10 때
 * 이게 없어서 며칠을 잃었다).
 */
export function setScreenVersion(version: string) {
  versionLabel = version;
  const brand = byId(BRAND_ID);
  if (brand) brand.textContent = `PAGE ONE · EDUSYNCPRO · v${version}`;
}

/**
 * 정적 안내를 보인다. 표준 화면(sdk.template.*)을 못 띄웠을 때의 최후 수단.
 *
 * @param opts.title    큰 글씨 한 줄.
 * @param opts.detail   설명 문장. 생략하면 비운다.
 * @param opts.showDiag true 면 최근 로그 몇 줄을 아래에 함께 보인다.
 *                      원장이 원인을 읽어야 하는 화면(실패·상태)에서만 켠다.
 *                      손님이 보는 안내에서는 끈다.
 */
export function showStaticNotice(opts: {
  title: string;
  detail?: string;
  showDiag?: boolean;
}): void {
  const boot = byId(BOOT_ID);
  if (!boot) return;

  const title = byId(TITLE_ID);
  if (title) title.textContent = opts.title;
  const detail = byId(DETAIL_ID);
  if (detail) detail.textContent = opts.detail ?? "";

  const diag = byId(DIAG_ID);
  if (diag) {
    diag.textContent = diagLines.join("\n");
    // hidden 속성 토글뿐이다. 노드는 index.html 이 미리 선언해 두었다.
    diag.hidden = !(opts.showDiag && diagLines.length > 0);
  }

  boot.hidden = false;
}

/**
 * 정적 안내를 숨긴다 (지우지 않는다 — 재사용해야 한다).
 *
 * 부르는 자리:
 *   · 표준 화면이 실제로 그려졌음이 확인된 직후 (renderIdle/renderResult/
 *     renderSelect 가 true 를 준 뒤). #boot 을 남겨 두면 그 화면을 덮는다.
 *   · 화면을 SDK 에게 넘기기 직전 — renderOnboardingPage(등록)·requestPayment
 *     (결제창)·setIdle(토스 첫화면) 앞. 이때는 "그려졌다"는 증거가 아직 없지만
 *     덮개를 두고 넘길 수는 없다. 넘긴 쪽이 실패하면 호출부가 showStaticNotice
 *     또는 showResultScreen 으로 화면을 되찾는다 — 빈 화면으로 안 끝난다.
 */
export function hideStaticNotice(): void {
  const boot = byId(BOOT_ID);
  if (boot) boot.hidden = true;
}

/**
 * 로거가 부른다. 최근 몇 줄을 링버퍼로 들고 있다가, 진단이 켜진 안내가
 * 보이는 동안에만 화면(#boot-diag)에 반영한다.
 *
 * 안내가 숨겨져 있으면 textContent 만 미리 갱신해 둔다 — 다음 showStaticNotice
 * 가 diag 를 켜는 순간 최신 로그가 바로 보인다.
 */
export function pushDiagLine(line: string): void {
  diagLines.push(
    line.length > MAX_DIAG_LINE_CHARS ? line.slice(0, MAX_DIAG_LINE_CHARS) + "…" : line
  );
  if (diagLines.length > MAX_DIAG_LINES) diagLines.splice(0, diagLines.length - MAX_DIAG_LINES);
  const diag = byId(DIAG_ID);
  if (diag && !diag.hidden) diag.textContent = diagLines.join("\n");
}

// ── 0.3.26 에서 제거된 것들 (다시 넣으면 반려된다) ──
//   paint / paintIdle / root() / el() — 자체 DOM 렌더러 전부.
//   showIdle — 브랜드 대기화면 (로고 이미지·SVG 카드 그래픽·링 애니메이션·
//              상태 pill·3단계 안내). 부팅 정상 흐름에서 먼저 그려지던 것이
//              반려 사유의 중심이었다. 정상 대기화면은 renderIdlePage 뿐이다.
//   showBusy / showCancelBusy — 결제·취소 진행 화면. 카드 삽입 안내는 SDK 의
//              requestPayment / requestPaymentCancel 이 자기 UI 로 띄운다.
//   showFatal / showStatus — showStaticNotice 로 통합.
//   showReceiptChoiceFallback — index.ts 가 showStaticNotice + 단발 setTimeout
//              으로 직접 처리한다 (타이머는 화면 주인인 index.ts 의 seq 가드
//              아래에 있어야 해서다).
//   assets/pageone-logo-dark.png — 위 화면들과 함께 삭제.
//   (0.3.24 에 지운 것: 버튼·입력폼·setInterval 카운트다운·showPairing.)
