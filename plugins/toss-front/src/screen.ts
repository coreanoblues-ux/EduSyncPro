/**
 * 자체 대기/상태 화면.
 *
 * 원칙: 공식 SDK 의 renderIdlePage 가 있으면 항상 그쪽이 우선이다 (Toss 심사 정책).
 * 이 화면은 SDK 유휴화면을 쓸 수 없을 때만 나오는 대체 화면이고, 목적은 두 가지다.
 *
 *   1) 검은 화면을 없앤다. 0.2.x 에서 원장이 본 것은 index.html 의 background:#000
 *      그 자체였다. 플러그인이 살아 있는지 죽어 있는지 구분할 수단이 전혀 없었다.
 *   2) 현장에서 원인을 읽을 수 있게 한다. 단말기에는 개발자도구가 없으므로
 *      최근 로그 몇 줄을 화면 아래에 작게 띄운다.
 *
 * 결제창은 SDK 가 자기 UI 로 띄운다. 여기서 카드 입력 같은 걸 흉내내지 않는다.
 */

const ROOT_ID = "edusync-front-root";
const MAX_DIAG_LINES = 6;

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
let currentActions: ScreenAction[] = [];
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

/**
 * 다시 그리기 잠금.
 *
 * paint() 는 el.textContent = "" 로 화면을 통째로 비우고 다시 만든다. 그런데
 * pushDiagLine 이 로그 한 줄마다 paint() 를 부른다. 그래서 paint() 이후에 DOM 을
 * 직접 덧붙이는 화면(영수증 선택·페어링 폼)은 로그가 한 줄 들어오는 순간
 * 버튼과 입력값이 통째로 사라진다. 폴링 오류는 1초마다 로그를 남기므로 실제로
 * 일어난다 — 원장이 영수증 버튼을 누르려는 순간 버튼이 사라지는 식이다.
 *
 * 대기화면 버튼은 currentActions 로 paint() 안에서 다시 그려지므로 이 잠금이
 * 필요 없지만, 덧붙이기 방식인 두 화면은 살아 있는 동안 잠가 둔다.
 */
let repaintLocked = false;

type Tone = "idle" | "busy" | "error";

/** 화면 하단 버튼 하나. paint() 가 매번 다시 그리므로 로그가 들어와도 사라지지 않는다. */
export interface ScreenAction {
  label: string;
  onClick: () => void;
  /** primary = 주황 강조, secondary = 어두운 테두리 버튼. */
  kind?: "primary" | "secondary";
}

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
  if (typeof document !== "undefined" && document.getElementById(ROOT_ID)) paint();
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

/** 손가락으로 누를 수 있는 크기의 버튼. 단말기는 마우스가 아니라 터치다. */
function makeButton(action: ScreenAction): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = action.label;
  const base = [
    "padding:16px 26px",
    "font-size:17px",
    "font-weight:700",
    "border-radius:12px",
    "cursor:pointer",
    "min-width:140px",
    // 단말기 웹뷰는 터치 후 300ms 지연·더블탭 확대가 기본이라 명시적으로 끈다.
    "touch-action:manipulation",
    "-webkit-tap-highlight-color:transparent",
  ].join(";");
  btn.setAttribute(
    "style",
    action.kind === "secondary"
      ? `${base};background:#1f2937;color:#e5e7eb;border:1px solid rgba(255,255,255,0.16)`
      : `${base};background:#f97316;color:#0f172a;border:none`
  );
  btn.addEventListener("click", () => {
    try {
      action.onClick();
    } catch (err) {
      // 콜백 예외가 화면을 죽이면 나가는 길이 또 막힌다. 삼키고 진단 줄로만 남긴다.
      // eslint-disable-next-line no-console
      console.error("[screen] 버튼 콜백 예외", err);
      pushDiagLine(`버튼 동작 실패: ${String((err as any)?.message ?? err)}`);
    }
  });
  return btn;
}

function paint() {
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

  // 버튼은 진단 박스보다 위에 둔다. 진단 박스는 길어질 수 있어서 아래에 두면
  // 화면 밖으로 밀려 나가 누를 수 없게 된다 — 나가는 길이 로그에 가려지면 안 된다.
  if (currentActions.length > 0) {
    const row = document.createElement("div");
    row.setAttribute(
      "style",
      ["display:flex", "gap:12px", "flex-wrap:wrap", "justify-content:center", "margin-top:8px"].join(";")
    );
    for (const action of currentActions) {
      row.appendChild(makeButton(action));
    }
    el.appendChild(row);
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

/**
 * 대기 화면. 결제 요청이 올 때까지 보여 준다.
 *
 * ── onAdmin 이 왜 생겼나 (2026-08-29, 원장 지적) ──
 *   원장의 말 그대로다: "단말기에서 환불을 갈려면 이 대기 화면을 나갈 수 있어야
 *   하는데 방법이 없잖아."
 *
 *   0.3.10 에서 [관리자] → [첫화면으로] 를 넣긴 했다. 그런데 그걸 전부
 *   sdk.template.renderIdlePage 의 버튼으로만 만들었다. 그리고 이 단말기의
 *   펌웨어에서 renderIdlePage 는 React 오류를 던진다 (원장 사진의 로그로 확인).
 *   그래서 실제로 화면에 뜬 것은 이 파일이 그리는 대체 화면이었고, 이 화면에는
 *   버튼이 하나도 없었다. 나가는 길을 만들어 놓고 그 길을 못 쓰는 화면에만
 *   안 만들어 둔 것이다.
 *
 *   같은 사진이 하나를 더 증명한다 — 이 자체 DOM 은 단말기에서 분명히 그려진다.
 *   (Toss 문서의 "HTML/CSS 직접 작성 금지" 는 심사 정책이지 런타임 차단이 아니다.)
 *   그러니 나가는 길은 이 화면에도 반드시 있어야 한다. 공식 템플릿이 되면 그쪽
 *   버튼을 쓰고, 안 되면 이 버튼을 쓴다. 어느 쪽이든 길은 하나 이상 남는다.
 */
export function showIdle(opts?: { onAdmin?: () => void }) {
  currentTone = "idle";
  currentTitle = "결제 요청 대기 중";
  currentSubtitle = "학생 태블릿에서 결제할 항목을 선택하면 이 화면에 결제창이 열립니다.";
  currentActions = opts?.onAdmin
    ? [{ label: "관리자", kind: "secondary", onClick: opts.onAdmin }]
    : [];
  // 로비에서 학생·학부모가 보는 화면이다. 로그는 걷어낸다.
  showDiag = false;
  repaintLocked = false;
  paint();
}

/**
 * 자체 관리자 메뉴. 대기화면의 [관리자] 버튼에서만 들어온다.
 *
 * 학원 로비의 단말기는 학생도 만진다. 그래서 나가기를 대기화면에 바로 두지 않고
 * 여기 한 단계 아래에 두었다 — 두 번 눌러야 하고, 그 사이에 경고 문구를 읽는다.
 * [닫기] 를 크게 두는 이유도 같다. 잘못 들어왔을 때 되돌아가는 길이 가장 눈에
 * 잘 띄어야 한다.
 */
export function showAdminMenu(opts: {
  title: string;
  onStatus: () => void;
  onExit: () => void;
  onClose: () => void;
}) {
  currentTone = "idle";
  currentTitle = opts.title;
  currentSubtitle =
    "[첫화면으로]를 누르면 학생이 이 단말기로 결제할 수 없습니다.\n결제 취소·환불은 토스플레이스 판매자센터(PC)에서 하세요.";
  currentActions = [
    { label: "닫기", kind: "primary", onClick: opts.onClose },
    { label: "단말기 상태", kind: "secondary", onClick: opts.onStatus },
    { label: "첫화면으로", kind: "secondary", onClick: opts.onExit },
  ];
  // 로그는 [단말기 상태] 안에서 본다. 메뉴 화면까지 스택트레이스로 채우지 않는다.
  showDiag = false;
  repaintLocked = false;
  paint();
}

/**
 * 상태·진단 화면. 관리자 메뉴의 [단말기 상태] 와 나가기 실패 안내가 여기로 온다.
 *
 * 로그가 화면에 보이는 곳은 이제 여기와 실패 화면 둘뿐이다. 원장이 원인을 찾을
 * 때만 열리고, 학생이 보는 화면에는 안 나온다.
 */
export function showStatus(opts: {
  title: string;
  detail: string;
  actions: ScreenAction[];
  tone?: "idle" | "error";
}) {
  currentTone = opts.tone === "error" ? "error" : "idle";
  currentTitle = opts.title;
  currentSubtitle = opts.detail;
  currentActions = opts.actions;
  showDiag = true;
  repaintLocked = false;
  paint();
}

/** 결제 진행 중. SDK 결제창이 이 위에 뜬다. */
export function showBusy(orderName: string, amount: number) {
  currentTone = "busy";
  currentTitle = `${amount.toLocaleString()}원`;
  currentSubtitle = `${orderName}\n카드를 넣거나 대주세요.`;
  // 결제 중에는 버튼이 없어야 한다. 카드 승인 도중 [첫화면으로] 가 눌리면
  // 승인은 났는데 화면만 나가 버리는 최악의 상태가 된다.
  currentActions = [];
  // 카드를 대는 순간 학생이 보는 화면이다.
  showDiag = false;
  repaintLocked = false;
  paint();
}

/** 치명적 실패. 원장이 읽고 조치할 수 있는 문장으로 쓴다. */
export function showFatal(title: string, detail: string, opts?: { onAdmin?: () => void }) {
  currentTone = "error";
  currentTitle = title;
  currentSubtitle = detail;
  // 실패 화면이야말로 나가는 길이 필요하다. 여기서 갇히면 단말기를 재부팅하는
  // 것 말고 할 수 있는 게 없어진다.
  currentActions = opts?.onAdmin
    ? [{ label: "관리자", kind: "secondary", onClick: opts.onAdmin }]
    : [];
  // 실패 화면에서는 로그를 보여 준다. 여기가 원장이 원인을 읽어야 하는 자리다.
  // 라이브 배포에는 단말기 로그 뷰어가 없으므로 이 화면이 유일한 단서가 된다.
  showDiag = true;
  repaintLocked = false;
  paint();
}

/** 로거가 호출한다. 최근 몇 줄만 화면 하단에 남긴다. */
export function pushDiagLine(line: string) {
  diagLines.push(
    line.length > MAX_DIAG_LINE_CHARS ? line.slice(0, MAX_DIAG_LINE_CHARS) + "…" : line
  );
  if (diagLines.length > MAX_DIAG_LINES) diagLines.splice(0, diagLines.length - MAX_DIAG_LINES);
  // 이미 화면이 그려져 있을 때만 다시 그린다.
  // repaintLocked 인 동안은 건너뛴다 — 영수증 선택·페어링 입력이 살아 있는 중이라
  // 여기서 다시 그리면 그 버튼과 입력값이 통째로 지워진다.
  if (repaintLocked) return;
  if (typeof document !== "undefined" && document.getElementById(ROOT_ID)) paint();
}

/**
 * 자체 화면만 치운다. 부팅 문구(#boot)는 남긴다.
 *
 * SDK 화면에 자리를 넘겨주기 전에 부른다. 아직 SDK 가 그렸다는 증거는 없으므로
 * 마지막 안전망인 부팅 문구까지 지우지는 않는다.
 */
export function clearOwnScreen() {
  if (typeof document === "undefined") return;
  repaintLocked = false;
  currentActions = [];
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
  repaintLocked = false;
  currentActions = [];
  const el = document.getElementById(ROOT_ID);
  if (el) el.remove();
  document.getElementById("boot")?.remove();
}

/**
 * 자체 온보딩 화면.
 *
 * 공식 sdk.template.renderOnboardingPage 가 있으면 index.ts 는 그걸 먼저 시도한다.
 * 여기 화면은 그게 없을 때만 나오는 폴백이다 — 그래도 검은 화면보다는 무한히 낫다.
 *
 * 입력값은 서버 검증(POST /session) 을 통과할 때까지 저장하지 않는다. 그래서 잘못
 * 붙여넣어도 다음 부팅에서 페어링 화면이 다시 뜬다.
 */
export interface PairingScreenOptions {
  title: string;
  subtitle: string;
  submitLabel: string;
  /**
   * 표시할 입력 필드들. 배열 순서대로 세로로 쌓인다.
   * name 은 onSubmit 콜백의 values 오브젝트 키가 된다.
   */
  inputs: Array<{
    name: string;
    label: string;
    placeholder: string;
    /** "text" | "tel" — 소프트키보드 종류에 영향. 숫자만 받으려면 tel 이 편하다. */
    type?: "text" | "tel";
    /** 자동 대문자화 (매장코드 입력용). */
    uppercase?: boolean;
    /** 최대 길이 제한. 매장코드 6자, PIN 4자 같은 짧은 값에 씀. */
    maxLength?: number;
  }>;
  /** 성공이면 null, 실패면 원인 문자열을 돌려준다. 화면이 그 값을 오류 박스에 띄운다. */
  onSubmit: (values: Record<string, string>) => Promise<string | null>;
  onCancel?: () => void;
}

/**
 * 승인 완료 후 영수증 출력 여부 선택 화면.
 *
 * 등장 시점:
 *   - 카드 승인 성공
 *   - 서버 /payments/confirm 성공
 *   - dispatch APPROVED 마킹 완료
 *   이 세 단계가 모두 끝난 뒤에만 이 화면이 뜬다. 즉 이 화면이 뜬 시점에는
 *   결제 자체는 이미 확정 상태이며, 여기서 무엇을 눌러도 결제에는 영향이 없다.
 *
 * 동작:
 *   - 8초 카운트다운을 표시한다.
 *   - "영수증 출력" 을 누르면 opts.onPrint() 를 1회 호출한다.
 *   - "영수증 생략" 을 누르면 opts.onSkip() 를 1회 호출한다.
 *   - 아무것도 안 누르고 카운트다운이 0에 도달하면 opts.onTimeout() 을 1회 호출한다.
 *   - 어떤 경로로든 결정이 한 번 발생하면 나머지 경로는 봉인된다 (내부 guard).
 *   - 화면 자체가 중복 클릭도 막는다 (버튼 disabled).
 *
 * 왜 이 화면이 own guard 도 가지나:
 *   외부(index.ts) 에도 상위 guard 가 있지만, 사용자가 두 버튼을 아주 빠르게
 *   연타하거나 setInterval 콜백이 클릭과 겹치는 극단적 상황을 두 겹으로 막기 위함.
 *   프린터는 1장 이상 뽑히면 학원 회계 실사에서 곤란해진다.
 */
export interface ReceiptChoiceOptions {
  autoPrintMs: number;
  onPrint: () => void;
  onSkip: () => void;
  onTimeout: () => void;
}

export function showReceiptChoice(opts: ReceiptChoiceOptions): void {
  if (typeof document === "undefined") return;

  currentTone = "idle";
  currentTitle = "결제가 완료되었습니다";
  currentSubtitle = "영수증을 출력하시겠습니까?";
  currentActions = [];
  showDiag = false;
  repaintLocked = false;
  paint();

  const el = root();
  if (!el) return;

  // 아래 버튼들은 paint() 가 아니라 여기서 직접 덧붙인다. 그래서 이 화면이 사는
  // 동안 다시 그리기를 잠근다 — 안 그러면 로그 한 줄에 버튼이 사라진다.
  repaintLocked = true;

  // 내부 결정 guard. 세 진입점(출력/생략/타임아웃) 중 최초 하나만 실제 콜백을 호출한다.
  let decided = false;
  let intervalId: number | null = null;
  let remainingMs = opts.autoPrintMs;

  const stopTimer = () => {
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const decide = (fire: () => void) => {
    if (decided) return;
    decided = true;
    stopTimer();
    // 결정이 끝났으니 화면을 다시 그려도 잃을 것이 없다. 잠금을 푼다.
    repaintLocked = false;
    // 화면상 버튼도 즉시 잠가 double-click 을 차단
    printBtn.disabled = true;
    skipBtn.disabled = true;
    try {
      fire();
    } catch (err) {
      // 콜백 예외는 화면 렌더에 영향 주지 않도록 흡수 — 상위(index.ts) 에서 별도 로깅.
      // eslint 무효화용: 로컬 콘솔에만 남긴다.
      // eslint-disable-next-line no-console
      console.error("[receipt-choice] 콜백 예외", err);
    }
  };

  const wrap = document.createElement("div");
  wrap.setAttribute(
    "style",
    ["display:flex", "flex-direction:column", "gap:14px", "align-items:center", "margin-top:6px"].join(";")
  );

  const countdown = document.createElement("div");
  countdown.setAttribute(
    "style",
    "font-size:15px;color:#94a3b8;letter-spacing:0.3px"
  );
  const renderCountdown = () => {
    const sec = Math.max(0, Math.ceil(remainingMs / 1000));
    countdown.textContent = `${sec}초 후 자동으로 출력됩니다`;
  };
  renderCountdown();
  wrap.appendChild(countdown);

  const buttonRow = document.createElement("div");
  buttonRow.setAttribute("style", "display:flex;gap:12px;margin-top:6px");

  const baseBtnStyle = [
    "padding:14px 26px",
    "font-size:17px",
    "font-weight:700",
    "border-radius:10px",
    "border:none",
    "cursor:pointer",
    "min-width:150px",
  ].join(";");

  const printBtn = document.createElement("button");
  printBtn.type = "button";
  printBtn.textContent = "영수증 출력";
  printBtn.setAttribute("style", `${baseBtnStyle};background:#f97316;color:#0f172a`);
  printBtn.addEventListener("click", () => decide(opts.onPrint));

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.textContent = "영수증 생략";
  skipBtn.setAttribute(
    "style",
    `${baseBtnStyle};background:#1f2937;color:#e5e7eb;border:1px solid rgba(255,255,255,0.14)`
  );
  skipBtn.addEventListener("click", () => decide(opts.onSkip));

  buttonRow.appendChild(printBtn);
  buttonRow.appendChild(skipBtn);
  wrap.appendChild(buttonRow);
  el.appendChild(wrap);

  // 1초마다 카운트다운 표시를 갱신하고, 0에 도달하면 자동 출력.
  const TICK = 250; // 화면 표기는 초 단위지만, 타이머 해상도는 250ms 로 더 촘촘히 (race 축소)
  intervalId = setInterval(() => {
    remainingMs -= TICK;
    if (remainingMs <= 0) {
      renderCountdown();
      decide(opts.onTimeout);
      return;
    }
    renderCountdown();
  }, TICK) as unknown as number;
}

/**
 * 영수증 결과 안내 (짧은 안내 화면).
 *
 * - 성공 시:  "영수증이 출력되었습니다." (선택 사용, 이번 버전은 사용 안 함 → 즉시 유휴 복귀)
 * - 실패 시:  "결제는 정상적으로 완료되었습니다. 영수증 출력에 실패했습니다."
 *
 * 이 화면은 정보 전달 목적이라 결제 결과를 되돌리지 않는다. 호출부(index.ts) 는
 * 이 화면 뒤 goIdle 로 자연스럽게 돌아간다.
 */
export function showReceiptResult(kind: "ok" | "fail", message: string) {
  currentTone = kind === "ok" ? "idle" : "error";
  currentTitle = kind === "ok" ? "영수증 출력 완료" : "영수증 출력 실패";
  currentSubtitle = message;
  currentActions = [];
  showDiag = false;
  repaintLocked = false;
  paint();
}

export function showPairing(opts: PairingScreenOptions) {
  if (typeof document === "undefined") return;
  currentTone = "idle";
  currentTitle = opts.title;
  currentSubtitle = opts.subtitle;
  currentActions = [];
  // 여기는 로그를 켠 채로 둔다. 학생이 보는 화면이 아니라 원장이 매장코드를
  // 치는 온보딩 화면이고, 페어링이 실패하는 이유(네트워크·코드 오타·서버 거절)는
  // 이 로그에만 남는다. showDiag 를 명시하지 않으면 직전 화면 값이 그대로
  // 따라와서, 어떤 경로로 들어왔느냐에 따라 보였다 안 보였다 한다.
  showDiag = true;
  repaintLocked = false;
  paint();

  const el = root();
  if (!el) return;

  // 입력 중에 다시 그리면 원장이 치던 매장코드가 지워진다. 폴링 오류 로그가
  // 1초마다 들어오는 상황에서는 아예 입력을 못 끝낸다. 이 화면이 사는 동안 잠근다.
  repaintLocked = true;

  const form = document.createElement("form");
  form.setAttribute(
    "style",
    [
      "display:flex",
      "flex-direction:column",
      "gap:12px",
      "width:min(560px,92vw)",
      "margin-top:8px",
    ].join(";")
  );

  // 필드별 라벨 + input 을 생성. 첫 필드에 자동 포커스.
  const inputEls: Array<HTMLInputElement> = [];
  opts.inputs.forEach((spec, idx) => {
    const wrap = document.createElement("div");
    wrap.setAttribute("style", "display:flex;flex-direction:column;gap:6px");

    const label = document.createElement("label");
    label.textContent = spec.label;
    label.setAttribute("style", "font-size:13px;color:#94a3b8;padding-left:2px");
    wrap.appendChild(label);

    const input = document.createElement("input");
    input.type = spec.type ?? "text";
    input.name = spec.name;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = spec.placeholder;
    if (spec.maxLength) input.maxLength = spec.maxLength;
    if (spec.uppercase) {
      input.addEventListener("input", () => {
        const p = input.selectionStart;
        input.value = input.value.toUpperCase();
        if (p != null) input.setSelectionRange(p, p);
      });
    }
    input.setAttribute(
      "style",
      [
        "padding:14px 16px",
        "font-size:20px",
        "letter-spacing:2px",
        "border-radius:10px",
        "border:1px solid rgba(255,255,255,0.14)",
        "background:#111827",
        "color:#e5e7eb",
        "outline:none",
        "font-family:ui-monospace,SFMono-Regular,Consolas,monospace",
      ].join(";")
    );
    wrap.appendChild(input);
    inputEls.push(input);
    if (idx === 0) {
      // 자동 포커스: 단말기 소프트키보드가 바로 뜨도록
      try { setTimeout(() => input.focus(), 0); } catch { /* 일부 웹뷰는 focus 를 제한한다 */ }
    }
    form.appendChild(wrap);
  });

  const err = document.createElement("div");
  err.setAttribute(
    "style",
    "font-size:13px;color:#f87171;min-height:18px;text-align:left;padding:0 4px"
  );
  form.appendChild(err);

  const buttonRow = document.createElement("div");
  buttonRow.setAttribute("style", "display:flex;gap:10px;justify-content:flex-end");

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = opts.submitLabel;
  submit.setAttribute(
    "style",
    [
      "padding:12px 22px",
      "font-size:16px",
      "font-weight:700",
      "border-radius:10px",
      "border:none",
      "cursor:pointer",
      "background:#f97316",
      "color:#0f172a",
    ].join(";")
  );
  buttonRow.appendChild(submit);
  form.appendChild(buttonRow);
  el.appendChild(form);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    submit.disabled = true;
    submit.textContent = "확인 중...";
    try {
      const values: Record<string, string> = {};
      inputEls.forEach((el) => {
        values[el.name] = el.value.trim();
      });
      const failMsg = await opts.onSubmit(values);
      if (failMsg) {
        err.textContent = failMsg;
      }
    } catch (e2: any) {
      err.textContent = e2?.message ? String(e2.message) : "등록 실패";
    } finally {
      submit.disabled = false;
      submit.textContent = opts.submitLabel;
    }
  });
}
