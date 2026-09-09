/**
 * 자체 대기/상태 화면.
 *
 * 원칙: 공식 SDK 의 Template API(renderIdlePage·renderResultPage·renderSelectPage 등)가
 * 항상 우선이다 (Toss 심사 정책). 이 화면은 SDK 화면을 쓸 수 없을 때만 나오는
 * 대체 화면이고, 목적은 두 가지다.
 *
 *   1) 검은 화면을 없앤다. 0.2.x 에서 원장이 본 것은 index.html 의 background:#000
 *      그 자체였다. 플러그인이 살아 있는지 죽어 있는지 구분할 수단이 전혀 없었다.
 *   2) 현장에서 원인을 읽을 수 있게 한다. 단말기에는 개발자도구가 없으므로
 *      최근 로그 몇 줄을 화면 아래에 작게 띄운다.
 *
 * ── 이 파일에는 버튼·입력칸이 없다 (2026-09-09, 라이브 검수 v26 반려) ──
 *   반려 사유 원문 요지: "안전망으로 인정되는 범위는 조작 요소가 없는 안내
 *   텍스트까지입니다." 0.3.23 까지 이 파일은 폴백 화면에 <button> 과 등록 폼
 *   <input> 6개를 그렸고, 그게 "화면을 대신 그리는 수준" 으로 판정됐다.
 *
 *   그래서 0.3.24 부터 조작이 필요한 화면(영수증 선택·관리자 메뉴·등록·버튼 달린
 *   오류 화면)은 전부 표준 화면 API 로 옮겼고(index.ts·sdk.ts), 이 파일은 문구와
 *   진단 로그만 그린다. 여기에 버튼을 다시 넣으면 다음 검수에서 또 반려된다 —
 *   pack 스크립트가 번들에서 createElement("button"|"input"|"form") 을 발견하면
 *   ZIP 생성을 거부하는 이유다.
 *
 * 결제창은 SDK 가 자기 UI 로 띄운다. 여기서 카드 입력 같은 걸 흉내내지 않는다.
 */

import pageoneLogoUrl from "./assets/pageone-logo-dark.png";

const ROOT_ID = "edusync-front-root";
const IDLE_STYLE_ID = "edusync-idle-style";
const MAX_DIAG_LINES = 6;

/**
 * PAGEONE 브랜드 색.
 *
 * 로고의 주황을 기준으로 잡았다. 대기화면은 이 네 갈래(네이비·주황·흰색·회색)
 * 밖으로 나가지 않는다 — 단말기 화면은 로비에서 멀리서 보이므로 색이 늘어날수록
 * 읽기만 나빠진다.
 */
const BRAND = {
  navyTop: "#0B1628",
  navyBottom: "#07111F",
  orange: "#FF8A00",
  orangeSoft: "#FF9300",
  white: "#F8FAFC",
  gray: "#94A3B8",
  grayDim: "#64748B",
} as const;

/**
 * 화면 하단 진단 줄의 최대 길이.
 *
 * ── 왜 160 에서 늘렸나 (2026-08-29, 원장 사진) ──
 *   단말기 사진에 이 줄이 찍혀 있었다:
 *     "renderIdlePage 실패 — 인자 없이 기본 대기화면으로 다시 시도합니다. :: Error: Minified R…"
 *   여기서 잘렸다. 하필 잘린 자리 바로 뒤가 React 오류 "번호" 다. 그 번호 하나면
 *   왜 Toss 템플릿이 이 펌웨어에서 터지는지 바로 알 수 있는데, 우리가 화면에서
 *   그걸 지우고 있었다. 진단 줄의 존재 이유가 "단말기 앞에서 원인을 읽는 것"인데
 *   정작 원인만 골라서 버린 셈이다.
 *
 *   단말기 화면은 세로로 길고 이 박스는 max-height:26vh + overflow:hidden 이라
 *   길어져도 레이아웃이 깨지지 않는다. 길이를 늘리는 쪽의 위험이 훨씬 작다.
 */
const MAX_DIAG_LINE_CHARS = 400;

let diagLines: string[] = [];
let currentTitle = "EduSyncPro";
let currentSubtitle = "";
let currentTone: Tone = "idle";
let versionLabel = "";

/**
 * 진단 로그 박스를 이 화면에 보여 줄 것인가.
 *
 * ── 왜 화면마다 다르게 됐나 (2026-08-29, 원장 요청) ──
 *   "대기화면에서 이건 안 보여도 될 것 같아. 어차피 컴퓨터로 172.30.1.91:9900
 *    으로 들어가서 보면 되잖아."
 *
 *   맞는 말이다. 대기화면은 학원 로비에서 학생과 학부모가 보는 화면인데 거기에
 *   영어 스택트레이스가 여섯 줄 깔려 있는 건 그냥 흉하다. 그리고 테스트 단말기는
 *   빨간 배지의 로그 뷰어로 훨씬 자세히 볼 수 있다.
 *
 *   다만 통째로 없애지는 않는다. 그 로그 뷰어는 테스트 단말기(디버그 빌드)에만
 *   있다. 라이브 배포로 넘어가면 빨간 배지도 뷰어도 사라진다. 그때 화면에도
 *   로그가 없으면 0.2.x 의 "검은 화면, 단서 없음" 으로 정확히 되돌아간다.
 *   그 상태로 며칠을 보낸 적이 있다.
 *
 *   그래서 이렇게 나눈다:
 *     대기화면 · 관리자 메뉴 · 결제중 · 영수증 → 안 보인다 (손님이 보는 화면)
 *     실패 화면 · [단말기 상태] 화면          → 보인다 (원장이 원인을 찾는 화면)
 *   로그는 계속 쌓이고 서버로도 올라간다. 화면에 그리는 것만 나눈 것이다.
 */
let showDiag = false;

// "다시 그리기 잠금"(repaintLocked)은 0.3.24 에서 지웠다.
//   paint() 이후 DOM 을 덧붙이는 화면(영수증 선택 버튼·페어링 입력폼)이 로그
//   한 줄에 지워지는 것을 막던 장치인데, 그 두 화면 자체가 표준 화면 API 로
//   옮겨 가면서(검수 반려 조치) 덧붙이는 DOM 이 사라졌다. 이제 이 파일의 모든
//   화면은 paint()/paintIdle() 하나로 완결되므로 언제 다시 그려도 잃을 것이 없다.

/**
 * 지금 화면을 그리는 함수.
 *
 * ── 왜 필요한가 ──
 *   pushDiagLine 과 setScreenVersion 은 "이미 그려져 있으면 다시 그린다" 를 하는데,
 *   예전에는 그게 무조건 paint() 였다. 대기화면을 전용 렌더러(paintIdle)로 분리한
 *   뒤에도 그대로 두면, 로그가 한 줄 들어오는 순간 브랜드 대기화면이 기본 화면으로
 *   조용히 바뀐다. 폴링 오류는 1초마다 로그를 남기므로 반드시 일어난다.
 *
 *   그래서 "무엇을 그릴지" 를 화면 진입 시점에 정해 두고, 다시 그릴 때는 그것을
 *   부른다. 기존 화면들은 전부 paint 를 그대로 쓰므로 동작이 바뀌지 않는다.
 */
let currentPainter: () => void = paint;

type Tone = "idle" | "busy" | "error";

// ScreenAction(화면 버튼)과 makeButton 은 0.3.24 에서 지웠다. 버튼이 필요한 화면은
// 전부 sdk.template.* 로 그린다 — 이 파일 헤더의 검수 반려 경위 참고.

const TONE_COLORS: Record<Tone, { bg: string; accent: string }> = {
  idle: { bg: "#0f172a", accent: "#f97316" },
  busy: { bg: "#0f172a", accent: "#38bdf8" },
  error: { bg: "#1c1013", accent: "#f87171" },
};

/**
 * 화면 첫 줄에 찍을 플러그인 버전을 알려 준다. bootstrap 맨 앞에서 한 번 부른다.
 *
 * ── 왜 필요한가 (2026-08-29) ──
 *   index.html 의 부팅 문구에는 버전을 박아 뒀는데, 정작 이 파일이 그리는 화면에는
 *   "PAGE ONE · EDUSYNCPRO" 만 있었다. 그런데 플러그인이 부팅되면 이 화면이
 *   부팅 문구를 덮는다 — 즉 정상 동작할수록 버전이 안 보인다. 원장이 보낸 단말기
 *   사진으로 "어느 ZIP 이 올라가 있는지" 를 판별할 수 없었던 이유가 이것이다.
 *   0.3.5 부터 0.3.10 까지 버전만 올리며 며칠을 보낸 대가가 컸다.
 */
export function setScreenVersion(version: string) {
  versionLabel = version;
  if (typeof document !== "undefined" && document.getElementById(ROOT_ID)) currentPainter();
}

function root(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let el = document.getElementById(ROOT_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = ROOT_ID;
    document.body.appendChild(el);
  }
  return el;
}

/**
 * index.html 의 #boot 노드를 지우지 않고 같은 문구로 갱신한다.
 *
 * ── 왜 바뀌었나 (2026-08-29, 원장 사진 한 장) ──
 *   0.3.8 까지 여기서 `document.getElementById("boot")?.remove()` 를 했다.
 *   "스크립트가 돌았으니 부팅 문구는 필요 없다"는 판단이었는데, 정확히 거꾸로였다.
 *
 *   Toss 문서(reference/plugin-sdk/front/template.html)는 이렇게 못 박는다:
 *     "프론트 플러그인의 화면은 반드시 Template API(sdk.template.*)로 구성해야 하며,
 *      HTML/CSS를 직접 작성하여 화면을 구성할 수 없어요."
 *   즉 이 파일이 만드는 자체 DOM 은 단말기에서 안 그려질 수 있다. 그런데 우리는
 *   그리기 직전에 유일하게 보이던 부팅 문구를 지웠다. 결과는 완전한 빈 화면이고,
 *   단말기 앞에서는 "플러그인이 죽었는지, 그려지지 않은 것인지" 구분할 수가 없다.
 *   여러 버전을 올리는 동안 화면이 계속 똑같았던 이유가 이것이다 —
 *   우리가 우리 진단 수단을 스스로 없앴다.
 *
 *   이제 지우지 않고 겹친다. 자체 DOM 이 그려지면 그게 위를 덮고(z-index),
 *   안 그려지면 부팅 노드가 같은 문구를 대신 보여 준다. 어느 쪽이든 빈 화면은 없다.
 */
function mirrorToBootNode() {
  const boot = document.getElementById("boot");
  if (!boot) return;
  const title = boot.querySelector(".title");
  const sub = boot.querySelector(".sub");
  if (title) title.textContent = currentTitle;
  if (sub) sub.textContent = currentSubtitle || diagLines[diagLines.length - 1] || "";
}

function paint() {
  // 이 화면이 그려지는 순간부터 "다시 그리기" 는 다시 paint 다.
  //
  // 각 show* 함수마다 이 줄을 흩어 놓지 않고 여기 한 곳에 둔 이유: 나중에 새
  // 화면이 하나 추가됐을 때 거기에 이 줄을 빠뜨리면, 그 화면이 떠 있는 동안
  // 로그 한 줄이 들어오는 순간 대기화면("결제 준비 완료")으로 다시 그려진다.
  // 결제·취소 진행 화면에서 그 일이 벌어지면 카드를 대고 있는 사람이 결제가
  // 끝난 줄 안다. paint() 를 부르는 화면은 정의상 대기화면이 아니므로, 여기서
  // 되돌리면 빠뜨릴 수가 없다. 그리는 내용에는 영향이 없다.
  currentPainter = paint;

  const el = root();
  if (!el) return;

  mirrorToBootNode();

  const { bg, accent } = TONE_COLORS[currentTone];

  el.setAttribute(
    "style",
    [
      "position:fixed",
      "inset:0",
      // #boot 노드 위에 겹친다. 이게 그려지면 부팅 문구는 가려지고,
      // 안 그려지면 아래의 부팅 문구가 그대로 보인다. 빈 화면이 되는 경우가 없다.
      "z-index:2147483000",
      `background:${bg}`,
      "color:#e2e8f0",
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "gap:18px",
      "font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif",
      "text-align:center",
      "padding:24px",
      "box-sizing:border-box",
    ].join(";")
  );

  // textContent 로만 값을 넣는다. 로그 문자열이 화면에 들어오므로 innerHTML 은 쓰지 않는다.
  el.textContent = "";

  const brand = document.createElement("div");
  brand.setAttribute("style", "font-size:15px;letter-spacing:2px;color:#64748b;font-weight:700");
  brand.textContent = versionLabel
    ? `PAGE ONE · EDUSYNCPRO · v${versionLabel}`
    : "PAGE ONE · EDUSYNCPRO";
  el.appendChild(brand);

  const title = document.createElement("div");
  title.setAttribute("style", `font-size:34px;font-weight:800;color:${accent}`);
  title.textContent = currentTitle;
  el.appendChild(title);

  if (currentSubtitle) {
    const sub = document.createElement("div");
    sub.setAttribute("style", "font-size:17px;color:#94a3b8;max-width:520px;line-height:1.5");
    sub.textContent = currentSubtitle;
    el.appendChild(sub);
  }

  if (showDiag && diagLines.length > 0) {
    const diag = document.createElement("pre");
    diag.setAttribute(
      "style",
      [
        "margin-top:20px",
        "font-size:11px",
        "line-height:1.6",
        "color:#475569",
        "background:rgba(255,255,255,0.03)",
        "border:1px solid rgba(255,255,255,0.06)",
        "border-radius:8px",
        "padding:10px 14px",
        "max-width:88vw",
        "max-height:26vh",
        "overflow:hidden",
        "white-space:pre-wrap",
        "word-break:break-all",
        "text-align:left",
      ].join(";")
    );
    diag.textContent = diagLines.join("\n");
    el.appendChild(diag);
  }
}

// ─── 대기화면 전용 렌더러 ─────────────────────────────────────────────
//
// paint() 와 분리한 이유:
//   paint() 는 결제중·실패·관리자메뉴·상태·영수증·페어링이 전부 공유한다. 그중
//   몇은 돈이 오가는 도중에 뜨는 화면이다. 대기화면 디자인을 위해 그 공용 함수를
//   고치면, 검증된 화면들이 전부 같이 흔들린다. 그래서 대기화면만 자기 렌더러를
//   갖고, paint() 가 그리는 내용은 한 글자도 바꾸지 않았다.
//   (paint() 에 들어간 유일한 변경은 currentPainter 를 자기 자신으로 되돌리는
//    한 줄이며, 그리는 결과에는 영향이 없다. 이유는 그 자리 주석에 적었다.)
//
// Toss 규정과의 관계:
//   공식 문서는 "화면은 반드시 Template API 로 구성" 을 요구한다. 그래서 goIdle()
//   은 지금도 renderIdle(=sdk.template.renderIdlePage) 을 먼저 시도하고, 그게
//   성공하면 이 화면은 아예 지워진다(confirmTemplateRendered). 이 파일이 그리는
//   것은 그 공식 경로가 이 펌웨어에서 React #299 로 실패할 때의 대체 화면이며,
//   그 우선순위는 이번 작업에서 바꾸지 않았다.

/** 대기화면 애니메이션. 한 번만 심는다. CSS 트랜스폼만 써서 GPU 부담이 없다. */
function ensureIdleStyle() {
  if (document.getElementById(IDLE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = IDLE_STYLE_ID;
  // 정적 문자열이다. 외부 값이 섞이지 않으므로 주입 위험이 없다.
  style.textContent = `
@keyframes eduRing {
  0%   { transform: scale(0.72); opacity: 0.28; }
  70%  { transform: scale(1.28); opacity: 0.04; }
  100% { transform: scale(1.34); opacity: 0; }
}
@keyframes eduPulse {
  0%, 100% { opacity: 0.45; }
  50%      { opacity: 1; }
}
/* 단말기가 애니메이션 감축을 요구하면 정적으로 둔다. */
@media (prefers-reduced-motion: reduce) {
  .edu-ring, .edu-dot { animation: none !important; }
}`;
  document.head.appendChild(style);
}

/**
 * 비접촉 결제 그래픽 (카드 + 단말기 + 전파).
 *
 * 인라인 SVG 인 이유: 외부 CDN 이미지를 쓰면 Toss 개발자센터의 ACL/CORS 를 또
 * 건드려야 한다. 그 문제로 이미 하루를 쓴 적이 있다. 여기서 그 위험을 새로
 * 만들지 않는다. 정적 문자열이므로 innerHTML 로 넣어도 주입 위험이 없다.
 */
const CONTACTLESS_SVG = `
<svg viewBox="0 0 120 120" width="100%" height="100%" fill="none"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="20" y="44" width="58" height="38" rx="7"
        stroke="${BRAND.orange}" stroke-width="3"/>
  <path d="M20 57 H78" stroke="${BRAND.orange}" stroke-width="3" opacity="0.75"/>
  <rect x="28" y="66" width="15" height="4" rx="2" fill="${BRAND.orange}" opacity="0.7"/>
  <path d="M88 48 a17 17 0 0 1 0 30" stroke="${BRAND.orangeSoft}" stroke-width="3.4" opacity="0.9"/>
  <path d="M95 40 a27 27 0 0 1 0 46" stroke="${BRAND.orangeSoft}" stroke-width="3" opacity="0.5"/>
  <path d="M102 32 a37 37 0 0 1 0 62" stroke="${BRAND.orangeSoft}" stroke-width="2.6" opacity="0.24"/>
</svg>`;

function el(tag: string, style: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.setAttribute("style", style);
  // 값은 항상 textContent 로 넣는다 (버전 문자열 등 바깥에서 온 값 포함).
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 브랜드 대기화면.
 *
 * 레이아웃 원칙 — 단말기는 세로 화면이고 해상도를 모른다:
 *   · 100vh 고정 + overflow:hidden → 스크롤바가 생기지 않는다.
 *   · 세로는 flex 3분할(헤더 / 본문 flex:1 / 하단)이라 화면이 짧아도 하단 버튼이
 *     밖으로 밀려나지 않는다. 관리자 버튼이 화면 밖으로 나가면 나가는 길이 막힌다.
 *   · 글자·여백은 전부 clamp() 라 특정 해상도에 못을 박지 않는다.
 */
function paintIdle() {
  const host = root();
  if (!host) return;

  mirrorToBootNode();
  ensureIdleStyle();

  host.setAttribute(
    "style",
    [
      "position:fixed",
      "inset:0",
      "z-index:2147483000",
      `background:radial-gradient(120% 80% at 50% 0%, #12203A 0%, ${BRAND.navyTop} 45%, ${BRAND.navyBottom} 100%)`,
      `color:${BRAND.white}`,
      "display:flex",
      "flex-direction:column",
      "font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif",
      "box-sizing:border-box",
      "padding:clamp(14px,3.2vh,28px) clamp(16px,5vw,40px)",
      // 세로 단말기에서 무엇이 잘리거나 스크롤바가 생기는 것을 원천 차단한다.
      "overflow:hidden",
      "-webkit-tap-highlight-color:transparent",
    ].join(";")
  );
  host.textContent = "";

  // ── 헤더: [로고] | EDUSYNCPRO ............ v0.3.xx ──
  const header = el(
    "div",
    "display:flex;align-items:center;gap:clamp(8px,2vw,14px);width:100%;flex:0 0 auto"
  );

  const logo = document.createElement("img");
  logo.src = pageoneLogoUrl;
  logo.alt = "PAGEONE";
  // height 만 고정하고 width:auto → 원본 비율이 절대 찌그러지지 않는다.
  logo.setAttribute(
    "style",
    "height:clamp(20px,3.4vh,30px);width:auto;display:block;flex:0 0 auto"
  );
  // 어떤 이유로든 이미지가 안 뜨면 깨진 아이콘 대신 글자 워드마크로 대체한다.
  // 단말기 앞에서 깨진 이미지가 보이는 것보다는 낫다.
  logo.addEventListener("error", () => {
    logo.remove();
    header.insertBefore(
      el(
        "div",
        `font-size:clamp(13px,2vh,17px);font-weight:800;letter-spacing:1px;color:${BRAND.white}`,
        "PAGEONE"
      ),
      header.firstChild
    );
  });
  header.appendChild(logo);

  header.appendChild(
    el("div", `width:1px;height:clamp(14px,2.4vh,20px);background:rgba(255,255,255,0.18)`)
  );
  header.appendChild(
    el(
      "div",
      `font-size:clamp(10px,1.6vh,13px);font-weight:700;letter-spacing:2.4px;color:${BRAND.gray}`,
      "EDUSYNCPRO"
    )
  );
  header.appendChild(el("div", "flex:1 1 auto"));
  if (versionLabel) {
    // 버전은 하드코딩하지 않는다. setScreenVersion 이 package.json 값을 넣어 준다.
    header.appendChild(
      el(
        "div",
        `font-size:clamp(9px,1.4vh,12px);font-weight:600;color:${BRAND.grayDim};letter-spacing:0.5px`,
        `v${versionLabel}`
      )
    );
  }
  host.appendChild(header);

  // 헤더 아래 얇은 오렌지 글로우 라인
  host.appendChild(
    el(
      "div",
      [
        "width:100%",
        "height:1px",
        "flex:0 0 auto",
        "margin-top:clamp(10px,1.8vh,16px)",
        `background:linear-gradient(90deg,rgba(255,138,0,0) 0%,${BRAND.orange} 50%,rgba(255,138,0,0) 100%)`,
        "box-shadow:0 0 12px rgba(255,138,0,0.45)",
        "opacity:0.85",
      ].join(";")
    )
  );

  // ── 본문 (남는 세로 공간을 전부 차지하고 그 안에서 가운데 정렬) ──
  const main = el(
    "div",
    [
      "flex:1 1 auto",
      "min-height:0", // flex 자식이 넘칠 때 잘리지 않고 줄어들게 하는 핵심
      "display:flex",
      "flex-direction:column",
      "align-items:center",
      "justify-content:center",
      "text-align:center",
      "gap:clamp(10px,2vh,20px)",
      "width:100%",
    ].join(";")
  );

  // 그래픽 + 레이더 링
  const visual = el(
    "div",
    [
      "position:relative",
      "width:clamp(112px,20vh,170px)",
      "height:clamp(112px,20vh,170px)",
      "flex:0 0 auto",
      "display:flex",
      "align-items:center",
      "justify-content:center",
    ].join(";")
  );
  for (let i = 0; i < 3; i++) {
    const ring = el(
      "div",
      [
        "position:absolute",
        "inset:0",
        "border-radius:50%",
        `border:1px solid ${BRAND.orange}`,
        "opacity:0",
        `animation:eduRing 3.6s ease-out ${i * 1.2}s infinite`,
      ].join(";")
    );
    ring.className = "edu-ring";
    visual.appendChild(ring);
  }
  const art = el("div", "position:relative;width:76%;height:76%");
  art.innerHTML = CONTACTLESS_SVG; // 정적 상수. 외부 입력 없음.
  visual.appendChild(art);
  main.appendChild(visual);

  // 메인 문구
  main.appendChild(
    el(
      "div",
      [
        "font-size:clamp(26px,4.6vh,40px)",
        "font-weight:800",
        `color:${BRAND.orange}`,
        "letter-spacing:-0.5px",
        "line-height:1.25",
        "text-shadow:0 0 26px rgba(255,138,0,0.28)",
      ].join(";"),
      "결제 준비 완료"
    )
  );
  // 부제. white-space:pre-line 이라 위 문자열의 \n 이 그대로 줄바꿈이 된다.
  // 줄바꿈 위치를 우리가 정하는 이유: 해상도에 따라 "선택하면 / 이" 처럼 어색한
  // 지점에서 끊기면 학부모가 읽다가 걸린다.
  main.appendChild(
    el(
      "div",
      [
        "font-size:clamp(13px,2.1vh,17px)",
        `color:${BRAND.gray}`,
        "line-height:1.65",
        // 폭 주의: ch 는 '0' 한 글자 너비다. 한글은 그 두 배쯤이라 30ch 로 잡았더니
        // 위에서 정한 두 줄이 네 줄로 다시 접히면서 "선택하면", "수 있습니다." 같은
        // 외톨이 줄이 생겼다. 줄바꿈은 \n 으로 우리가 정하고, 폭은 그 줄이 안 접힐
        // 만큼만 넉넉히 준다. 화면이 아주 좁으면 그때만 자연 줄바꿈으로 넘어간다.
        "max-width:min(94%,32rem)",
        "word-break:keep-all", // 한국어 단어가 중간에서 끊기지 않게
        "white-space:pre-line",
      ].join(";"),
      "학생 태블릿에서 결제 항목을 선택하면\n이 단말기에서 바로 결제를 진행할 수 있습니다."
    )
  );

  // 상태 pill — 새 네트워크 점검을 추가하지 않는다. 이 화면이 떠 있다는 사실
  // 자체가 "폴링이 돌고 결제를 기다리는 중" 이라는 기존 상태의 표현이다.
  const pill = el(
    "div",
    [
      "display:inline-flex",
      "align-items:center",
      "gap:8px",
      "padding:clamp(5px,0.9vh,8px) clamp(12px,2.4vw,18px)",
      "border-radius:999px",
      `border:1px solid rgba(255,138,0,0.45)`,
      "background:rgba(255,138,0,0.08)",
      "flex:0 0 auto",
    ].join(";")
  );
  const dot = el(
    "div",
    [
      "width:7px",
      "height:7px",
      "border-radius:50%",
      `background:${BRAND.orange}`,
      `box-shadow:0 0 8px ${BRAND.orange}`,
      "animation:eduPulse 2s ease-in-out infinite",
    ].join(";")
  );
  dot.className = "edu-dot";
  pill.appendChild(dot);
  pill.appendChild(
    el(
      "div",
      `font-size:clamp(11px,1.7vh,14px);font-weight:700;color:${BRAND.orangeSoft};letter-spacing:0.3px`,
      "대기 중"
    )
  );
  main.appendChild(pill);

  host.appendChild(main);

  // ── 3단계 안내 (한 줄) ──
  const steps = el(
    "div",
    [
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "gap:clamp(6px,1.6vw,14px)",
      "flex:0 0 auto",
      "width:100%",
      "margin-bottom:clamp(10px,1.8vh,18px)",
      "flex-wrap:nowrap",
    ].join(";")
  );
  const STEPS: Array<[string, string]> = [
    ["1", "항목 선택"],
    ["2", "카드/태그"],
    ["3", "결제 진행"],
  ];
  STEPS.forEach(([num, label], i) => {
    if (i > 0) {
      steps.appendChild(
        el(
          "div",
          `font-size:clamp(10px,1.5vh,13px);color:${BRAND.grayDim};flex:0 0 auto`,
          "›"
        )
      );
    }
    const item = el(
      "div",
      "display:flex;align-items:center;gap:6px;flex:0 0 auto;min-width:0"
    );
    item.appendChild(
      el(
        "div",
        [
          "width:clamp(16px,2.4vh,20px)",
          "height:clamp(16px,2.4vh,20px)",
          "border-radius:50%",
          `border:1px solid rgba(255,138,0,0.5)`,
          `color:${BRAND.orangeSoft}`,
          "font-size:clamp(9px,1.3vh,11px)",
          "font-weight:700",
          "display:flex",
          "align-items:center",
          "justify-content:center",
          "flex:0 0 auto",
        ].join(";"),
        num
      )
    );
    item.appendChild(
      el(
        "div",
        `font-size:clamp(10px,1.6vh,13px);color:${BRAND.gray};white-space:nowrap`,
        label
      )
    );
    steps.appendChild(item);
  });
  host.appendChild(steps);

  // ── 관리자 버튼은 없다 (0.3.24, 검수 반려 조치) ──
  //   이 화면은 SDK 대기화면이 실패했을 때만 나오는 폴백이고, 폴백에 허용되는 것은
  //   조작 요소 없는 안내 텍스트까지다. 관리자 진입은 표준 대기화면(renderIdlePage
  //   oneButton)의 [관리자] 버튼이 담당한다. 이 폴백이 떠 있다는 것은 그 표준
  //   화면이 이 펌웨어에서 안 그려진다는 뜻이므로, 그때의 관리 경로는 단말기
  //   자체 설정(설정 진입 → 토스 프론트 재시작)과 판매자센터(PC)다.

  // ── Footer ──
  host.appendChild(
    el(
      "div",
      [
        "flex:0 0 auto",
        "width:100%",
        "text-align:center",
        "margin-top:clamp(8px,1.4vh,14px)",
        "font-size:clamp(8px,1.2vh,10px)",
        "letter-spacing:1.6px",
        `color:${BRAND.grayDim}`,
        "opacity:0.62",
      ].join(";"),
      "PAGEONE PAYMENT SYSTEM"
    )
  );
}

/**
 * 대기 화면(폴백). SDK 의 renderIdlePage 가 실패했을 때만 나온다.
 *
 * ── 0.3.24: 관리자 버튼이 빠졌다 (라이브 검수 v26 반려 조치) ──
 *   0.3.23 까지 이 화면에는 [관리자 메뉴] 버튼이 있었다. "표준 대기화면이 안
 *   그려지는 펌웨어에서도 나가는 길은 있어야 한다"(2026-08-29 원장 지적)는 이유였다.
 *   그러나 검수 기준은 명확했다 — 폴백은 조작 요소가 없는 안내 텍스트까지만.
 *   관리자 진입은 표준 대기화면(renderIdlePage oneButton)의 [관리자] 버튼이 맡고,
 *   그마저 안 되는 펌웨어에서는 단말기 설정과 판매자센터(PC)가 관리 경로다.
 *   자체 관리자 메뉴(showAdminMenu)도 같은 이유로 지웠다 — 메뉴는
 *   sdk.template.renderSelectPage 가 그린다 (index.ts openAdminMenu).
 */
export function showIdle() {
  currentTone = "idle";
  // currentTitle/currentSubtitle 은 화면에 직접 쓰이지 않더라도 계속 채운다.
  // mirrorToBootNode() 가 이 값을 #boot 노드에 복사하기 때문이다. 우리 DOM 이
  // 어떤 이유로 안 그려져도 부팅 노드에 글자는 남아 있어야 한다 (검은 화면 방지).
  currentTitle = "결제 준비 완료";
  currentSubtitle =
    "학생 태블릿에서 결제 항목을 선택하면 이 단말기에서 바로 결제를 진행할 수 있습니다.";
  // 로비에서 학생·학부모가 보는 화면이다. 로그는 걷어낸다.
  showDiag = false;
  // 이 화면만 전용 렌더러를 쓴다. 폴링 로그(pushDiagLine)나 버전 수신
  // (setScreenVersion)이 뒤늦게 들어와 다시 그릴 때도 대기화면으로 다시
  // 그려져야 하므로, 그리기 전에 currentPainter 를 먼저 바꾼다.
  currentPainter = paintIdle;
  paintIdle();
}

/**
 * 상태·진단 화면. 관리자 메뉴의 [단말기 상태] 와 나가기 실패 안내가 여기로 온다.
 *
 * 로그가 화면에 보이는 곳은 이제 여기와 실패 화면 둘뿐이다. 원장이 원인을 찾을
 * 때만 열리고, 학생이 보는 화면에는 안 나온다.
 */
export function showStatus(opts: { title: string; detail: string; tone?: "idle" | "error" }) {
  currentTone = opts.tone === "error" ? "error" : "idle";
  currentTitle = opts.title;
  currentSubtitle = opts.detail;
  showDiag = true;
  paint();
}

/** 결제 진행 중. SDK 결제창이 이 위에 뜬다. */
export function showBusy(orderName: string, amount: number) {
  currentTone = "busy";
  currentTitle = `${amount.toLocaleString()}원`;
  currentSubtitle = `${orderName}\n카드를 넣거나 대주세요.`;
  // 카드를 대는 순간 학생이 보는 화면이다. 조작 요소 없는 안내 텍스트뿐이며,
  // 실제 결제 UI 는 SDK 가 이 위에 자기 화면으로 띄운다.
  showDiag = false;
  paint();
}

/**
 * 카드 취소 진행 중.
 *
 * 결제 화면(showBusy)과 문구를 확실히 다르게 둔다. 이 화면 앞에 서 있는 사람은
 * 돈을 내러 온 학생이 아니라 환불을 받는 학부모이고, 같은 "1,000원 / 카드를
 * 대주세요" 를 보면 결제가 또 되는 줄로 오해한다.
 */
export function showCancelBusy(amount: number) {
  currentTone = "busy";
  currentTitle = `${amount.toLocaleString()}원 결제취소`;
  currentSubtitle = "결제하셨던 카드를 넣거나 대주세요.\n취소가 끝날 때까지 카드를 빼지 마세요.";
  showDiag = false;
  paint();
}

/**
 * 치명적 실패(폴백). 원장이 읽고 조치할 수 있는 문장으로 쓴다.
 *
 * 버튼이 달린 오류 화면은 index.ts 의 showResultScreen(= renderResultPage)이
 * 그린다. 이 함수가 그려졌다는 것은 표준 화면 API 자체를 못 쓰는 상황이라는
 * 뜻이므로, 여기서는 문구와 진단 로그만 남긴다.
 */
export function showFatal(title: string, detail: string) {
  currentTone = "error";
  currentTitle = title;
  currentSubtitle = detail;
  // 실패 화면에서는 로그를 보여 준다. 여기가 원장이 원인을 읽어야 하는 자리다.
  // 라이브 배포에는 단말기 로그 뷰어가 없으므로 이 화면이 유일한 단서가 된다.
  showDiag = true;
  paint();
}

/** 로거가 호출한다. 최근 몇 줄만 화면 하단에 남긴다. */
export function pushDiagLine(line: string) {
  diagLines.push(
    line.length > MAX_DIAG_LINE_CHARS ? line.slice(0, MAX_DIAG_LINE_CHARS) + "…" : line
  );
  if (diagLines.length > MAX_DIAG_LINES) diagLines.splice(0, diagLines.length - MAX_DIAG_LINES);
  // 이미 화면이 그려져 있을 때만 다시 그린다. 모든 화면이 paint()/paintIdle()
  // 한 번으로 완결되므로(덧붙이는 버튼·입력이 없음) 언제 다시 그려도 안전하다.
  if (typeof document !== "undefined" && document.getElementById(ROOT_ID)) currentPainter();
}

/**
 * 자체 화면만 치운다. 부팅 문구(#boot)는 남긴다.
 *
 * SDK 화면에 자리를 넘겨주기 전에 부른다. 아직 SDK 가 그렸다는 증거는 없으므로
 * 마지막 안전망인 부팅 문구까지 지우지는 않는다.
 */
export function clearOwnScreen() {
  if (typeof document === "undefined") return;
  const el = document.getElementById(ROOT_ID);
  if (el) el.remove();
}

/**
 * 공식 Template API 가 실제로 그려졌음이 확인됐을 때만 부른다.
 *
 * 이때 비로소 부팅 문구를 지운다. #boot 은 position:fixed·inset:0 이라
 * 남겨 두면 템플릿 화면 위를 덮어 버리기 때문이다.
 *
 * ── 0.3.9 의 핵심 ──
 *   0.3.8 까지는 paint() 첫 줄에서 무조건 #boot 을 지웠다. "스크립트가 돌았으니
 *   부팅 문구는 필요 없다"는 판단이었는데, 그 다음에 그리는 자체 DOM 이 단말기에서
 *   안 그려지면 화면에 아무것도 남지 않는다. 여러 버전을 올리는 동안 원장이 본
 *   화면이 늘 똑같았던 이유다 — 우리가 유일한 단서를 매번 먼저 지웠다.
 *   이제 "그려졌다"는 양성 증거가 있을 때만 지운다.
 */
export function confirmTemplateRendered() {
  if (typeof document === "undefined") return;
  const el = document.getElementById(ROOT_ID);
  if (el) el.remove();
  document.getElementById("boot")?.remove();
}

/**
 * 영수증 선택 화면의 텍스트 전용 폴백.
 *
 * 1순위는 index.ts 의 sdk.template.renderResultPage(버튼 2개 + timerMs) 이고,
 * 이 함수는 그 표준 화면 렌더가 실패했을 때만 나온다 (2026-09-09 검수 반려 반영:
 * 폴백에는 조작 요소를 둘 수 없으므로 버튼 없이 자동 출력 안내만 표시).
 *
 * - 버튼이 없으므로 선택은 불가능하고, autoPrintMs 뒤 onTimeout(자동 출력) 1회 호출.
 * - 중복 호출(출력 2장) 방지는 호출부(index.ts) 의 decide-guard 가 담당한다.
 * - setInterval 카운트다운 대신 단발 setTimeout — 반려 사유였던 250ms 인터벌 제거.
 */
export function showReceiptChoiceFallback(opts: {
  title?: string;
  autoPrintMs: number;
  onTimeout: () => void;
}): void {
  currentTone = "idle";
  currentTitle = opts.title ?? "결제가 완료되었습니다";
  currentSubtitle = `잠시 후 영수증이 자동으로 출력됩니다. (약 ${Math.round(opts.autoPrintMs / 1000)}초)`;
  showDiag = false;
  paint();
  setTimeout(() => {
    try {
      opts.onTimeout();
    } catch (err) {
      // 콜백 예외는 화면 렌더에 영향 주지 않도록 흡수 — 상위(index.ts) 에서 별도 로깅.
      // eslint-disable-next-line no-console
      console.error("[receipt-choice-fallback] 콜백 예외", err);
    }
  }, opts.autoPrintMs);
}

// showPairing / PairingScreenOptions 는 2026-09-09 검수 반려로 제거되었다.
// 단말기 등록은 sdk.template.renderOnboardingPage 만 사용하고, 그 API 가 없으면
// index.ts 가 throw → showFatal(텍스트 안내) 로 떨어진다. 폴백 입력폼(6개 input)은
// "조작 요소 없는 안내 텍스트" 허용 범위를 벗어나므로 되살리면 다시 반려된다.
//
// showReceiptChoice / showReceiptResult 도 같은 이유로 제거 — 각각
// renderResultPage(버튼) / showResultScreen(index.ts) 로 대체되었다.
