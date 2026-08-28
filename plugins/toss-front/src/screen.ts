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

let diagLines: string[] = [];
let currentTitle = "EduSyncPro";
let currentSubtitle = "";
let currentTone: Tone = "idle";

type Tone = "idle" | "busy" | "error";

const TONE_COLORS: Record<Tone, { bg: string; accent: string }> = {
  idle: { bg: "#0f172a", accent: "#f97316" },
  busy: { bg: "#0f172a", accent: "#38bdf8" },
  error: { bg: "#1c1013", accent: "#f87171" },
};

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

function paint() {
  const el = root();
  if (!el) return;

  // index.html 의 부팅 문구를 치운다. 이 시점이면 스크립트가 확실히 실행된 것이다.
  document.getElementById("boot")?.remove();

  const { bg, accent } = TONE_COLORS[currentTone];

  el.setAttribute(
    "style",
    [
      "position:fixed",
      "inset:0",
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
  brand.textContent = "PAGE ONE · EDUSYNCPRO";
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

  if (diagLines.length > 0) {
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

/** 대기 화면. 결제 요청이 올 때까지 보여 준다. */
export function showIdle() {
  currentTone = "idle";
  currentTitle = "결제 요청 대기 중";
  currentSubtitle = "학생 태블릿에서 결제할 항목을 선택하면 이 화면에 결제창이 열립니다.";
  paint();
}

/** 결제 진행 중. SDK 결제창이 이 위에 뜬다. */
export function showBusy(orderName: string, amount: number) {
  currentTone = "busy";
  currentTitle = `${amount.toLocaleString()}원`;
  currentSubtitle = `${orderName}\n카드를 넣거나 대주세요.`;
  paint();
}

/** 치명적 실패. 원장이 읽고 조치할 수 있는 문장으로 쓴다. */
export function showFatal(title: string, detail: string) {
  currentTone = "error";
  currentTitle = title;
  currentSubtitle = detail;
  paint();
}

/** 로거가 호출한다. 최근 몇 줄만 화면 하단에 남긴다. */
export function pushDiagLine(line: string) {
  diagLines.push(line.length > 160 ? line.slice(0, 160) + "…" : line);
  if (diagLines.length > MAX_DIAG_LINES) diagLines.splice(0, diagLines.length - MAX_DIAG_LINES);
  // 이미 화면이 그려져 있을 때만 다시 그린다.
  if (typeof document !== "undefined" && document.getElementById(ROOT_ID)) paint();
}

/** SDK 유휴화면을 쓸 때는 우리 화면을 완전히 치운다. 두 화면이 겹치면 안 된다. */
export function clearOwnScreen() {
  if (typeof document === "undefined") return;
  const el = document.getElementById(ROOT_ID);
  if (el) el.remove();
}
