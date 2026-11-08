/**
 * 부모님 화면 HTML. 시안: design/parent-report/report_v4_flow_english.html (원장 확정, 주황).
 *
 * 서버가 HTML 을 직접 그린다 — React 앱을 로그인 없이 내려보내지 않고, 화면 전환은 링크 이동이라
 * 오래된 폰에서도 깨질 곳이 없다. **스크립트가 한 줄도 없다** (CSP 로 script 를 통째로 막는다).
 *
 * 규칙: 화면에 찍는 값은 전부 esc() 를 거친다. 학생 이름·숙제 제목·선생님 한마디는 사람이 친 글이다.
 */

import { escapeHtml as esc } from "../lib/shareLink";
import { daysBetween } from "@shared/day";
import { VOCAB_PASS_PCT, VOCAB_REWRITE_PCT } from "@shared/learningReport";
import type { ParentView } from "./data";

export type View = "home" | "homework" | "exam" | "notes";

/** 화면이 링크를 만드는 방법. 부모님 주소(/p/토큰)와 선생님 미리보기 주소가 다르다. */
export type Nav = {
  href: (view: View, q?: { w?: string | null; c?: string | null }) => string;
  photo: (id: string) => string;
  /** 미리보기면 맨 위에 띠를 두른다. */
  preview?: boolean;
};

const DOW = ["일", "월", "화", "수", "목", "금", "토"];
function fmtDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${m}월 ${d}일 (${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}
function fmtShort(ymd: string): string {
  return `${Number(ymd.slice(5, 7))}.${ymd.slice(8, 10)}`;
}
function fmtTime(t: string | null): string {
  if (!t) return "";
  const [h, mm] = t.split(":").map(Number);
  return `${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}시${mm ? ` ${mm}분` : ""}`;
}
/** "11월 1주차" → 달만 주황으로. */
function weekPill(label: string): string {
  const m = /^(\d+월) (.+)$/.exec(label);
  return m ? `<b>${esc(m[1])}</b> ${esc(m[2])}` : esc(label);
}
/** 재시험을 다시 봐서 통과한 날도 "통과" 로 센다 (원장 결정 2026-11-08). 카드에는 "재시 통과" 로 따로 보인다. */
function vocabCounts(list: ParentView["vocab"]) {
  return {
    pass: list.filter((x) => x.result === "pass" || (x.result === "retest" && x.retestPassed === true)).length,
    rewrite: list.filter((x) => x.result === "rewrite").length,
    retest: list.filter((x) => x.result === "retest").length,
    retestOpen: list.filter((x) => x.result === "retest" && x.retestPassed !== true).length,
  };
}
const REASON: Record<string, string> = { retest: "재시험", homework: "보강", absence: "결석 보강", other: "보강" };

// ─── 껍데기 ──────────────────────────────────────────────────────────────

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{--o:#F96E00;--c:#FF9A4D;--ink:#1C1E26;--sub:#8A93A6;--good:#1B9E5A;--line:rgba(28,30,38,.07)}
body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","맑은 고딕",sans-serif;color:var(--ink);letter-spacing:-.2px;
 background:radial-gradient(420px 300px at 85% -40px,rgba(249,110,0,.09),transparent 70%),radial-gradient(500px 360px at -60px 200px,rgba(93,135,255,.06),transparent 70%),#F7F8FB;min-height:100vh}
a{color:inherit;text-decoration:none}
.wrap{max-width:480px;margin:0 auto;padding-bottom:110px}
.pv{background:#1C1E26;color:#fff;font-size:12px;font-weight:700;text-align:center;padding:8px 12px}
.pv b{color:#FFB070}
.top{display:flex;align-items:center;gap:9px;padding:20px 20px 6px}
.lm{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--c),var(--o));color:#fff;font-size:14px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(249,110,0,.3)}
.bn{font-size:15px;font-weight:800}.bn small{display:block;font-weight:500;font-size:10px;color:var(--sub);margin-top:1px}
.hero{padding:14px 20px}
.hello{font-size:12.5px;color:var(--sub);font-weight:600;margin-bottom:3px}
.hr{display:flex;justify-content:space-between;align-items:flex-end;gap:8px}
.st{font-size:25px;font-weight:800;letter-spacing:-.8px}.st small{font-size:12px;font-weight:600;color:var(--sub);margin-left:7px;letter-spacing:0}
.wk{display:flex;align-items:center;gap:2px;background:rgba(255,255,255,.9);border:1px solid var(--line);border-radius:999px;padding:3px;white-space:nowrap}
.wk span{font-size:11.5px;font-weight:700;padding:3px 6px}.wk span b{color:var(--o)}
.wk a,.wk i{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-style:normal;font-weight:800;color:var(--sub)}
.wk a{background:#F2F4F8;color:var(--ink)}
.chips{display:flex;gap:6px;padding:0 20px 10px;flex-wrap:wrap}
.chip{font-size:12px;font-weight:700;padding:6px 12px;border-radius:999px;background:#fff;border:1px solid var(--line);color:var(--sub)}
.chip.on{background:var(--o);color:#fff;border-color:var(--o)}
.card{background:rgba(255,255,255,.92);border:1px solid rgba(255,255,255,.9);outline:1px solid var(--line);border-radius:20px;margin:0 16px 12px;padding:18px;box-shadow:0 8px 26px rgba(28,30,38,.06)}
.urgent{margin:0 16px 12px;border-radius:20px;padding:16px 18px;background:linear-gradient(120deg,#FF8B33,#F96E00);box-shadow:0 10px 26px rgba(249,110,0,.32);display:flex;align-items:center;gap:12px;color:#fff}
.urgent .d{flex-shrink:0;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.35);border-radius:13px;padding:9px 12px;font-size:16px;font-weight:800}
.urgent .t{font-size:14px;font-weight:800}.urgent .s{font-size:11px;opacity:.92;margin-top:2px;font-weight:600}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0 16px 12px}
.tile{background:rgba(255,255,255,.92);outline:1px solid var(--line);border-radius:20px;padding:16px;box-shadow:0 8px 24px rgba(28,30,38,.06);position:relative;min-height:124px;display:block}
.tile .tt{font-size:11.5px;font-weight:700;color:var(--sub)}.tile .tt:after{content:"›";float:right;color:#C3CAD8;font-weight:800}
.tile .big{font-size:26px;font-weight:800;letter-spacing:-1px;margin-top:10px}.tile .big small{font-size:13px;font-weight:700;color:var(--sub);letter-spacing:0}
.tile .n{font-size:10.5px;font-weight:700;margin-top:4px;color:var(--sub)}
.ok{color:var(--good)!important}.warn{color:#D94F00!important}.bad{color:#B3261E!important}
.ring{position:absolute;right:14px;bottom:14px}
.new{position:absolute;right:13px;bottom:15px;font-size:9.5px;font-weight:800;color:#fff;background:var(--o);padding:4px 8px;border-radius:999px}
.sh{display:flex;align-items:center;margin-bottom:10px}.sh .t{font-size:14.5px;font-weight:800}.sh .r{margin-left:auto;font-size:11px;font-weight:700;color:var(--sub)}.sh .r b{color:var(--o)}
.row{display:flex;align-items:center;gap:10px;padding:10px 0}.row+.row{border-top:1px solid var(--line)}
.row .dt{width:40px;font-size:11px;font-weight:800;color:var(--o)}.row .nm{flex:1;font-size:12.5px;font-weight:600}
.pill{font-size:10.5px;font-weight:700;padding:5px 10px;border-radius:999px;white-space:nowrap}
.p-d{color:#fff;background:var(--o)}.p-o{color:#C14E00;background:rgba(249,110,0,.1)}.p-g{color:var(--good);background:rgba(27,158,90,.09)}.p-b{color:#44639E;background:rgba(93,135,255,.1)}.p-r{color:#B3261E;background:rgba(179,38,30,.08)}.p-n{color:var(--sub);background:#F2F4F8}
.empty{font-size:12.5px;color:var(--sub);text-align:center;padding:14px 0}
.dh{display:flex;align-items:center;gap:10px;padding:20px 16px 14px}
.back{width:34px;height:34px;border-radius:12px;background:rgba(255,255,255,.9);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px}
.dh .t{font-size:17px;font-weight:800}.dh .s{margin-left:auto;font-size:11px;font-weight:700;color:var(--sub)}
.hw{padding:12px 2px}.hw+.hw{border-top:1px solid var(--line)}
.hw .top2{display:flex;align-items:center;gap:10px}.hw .n{font-size:13.5px;font-weight:700;flex:1}
.hw .sub{font-size:11.5px;color:var(--sub);margin-top:4px}
.meter{margin-top:8px;background:#EDF0F5;height:5px;border-radius:999px;overflow:hidden}.meter div{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--c),var(--o))}.meter div.g{background:linear-gradient(90deg,#6FCF9B,#1B9E5A)}
.score{display:flex;align-items:baseline;gap:6px}.score .v{font-size:36px;font-weight:800;letter-spacing:-1.5px}.score .u{font-size:12px;font-weight:700;color:var(--sub)}.score .top{margin-left:auto;font-size:14.5px;font-weight:800;color:var(--o)}
.ss{font-size:11px;color:var(--sub);margin:4px 0 14px}
.pr{display:flex;justify-content:space-between;font-size:10.5px;font-weight:600;color:var(--sub);margin-bottom:6px}.pr .me{color:var(--o);font-weight:800}
.pt{position:relative;background:#EDF0F5;height:7px;border-radius:999px;margin-bottom:4px}
.pt .f{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:linear-gradient(90deg,var(--c),var(--o))}
.pt .a{position:absolute;top:-3px;bottom:-3px;width:2px;background:#C3CAD8}
.pt .dot{position:absolute;top:50%;width:15px;height:15px;border-radius:50%;background:var(--o);border:3px solid #fff;transform:translate(-50%,-50%);box-shadow:0 2px 6px rgba(249,110,0,.4)}
.lg{display:flex;justify-content:space-between;font-size:9.5px;color:#AEB6C4}
.bar{display:grid;grid-template-columns:56px 1fr 34px;align-items:center;gap:10px;margin-bottom:11px}
.bar .l{font-size:12px;font-weight:700;color:#5A6372}.bar .tr{background:#EDF0F5;height:7px;border-radius:999px;overflow:hidden}.bar .tr div{height:100%;border-radius:999px;background:linear-gradient(90deg,#FFC08A,var(--o))}.bar .v{text-align:right;font-size:13px;font-weight:800}
.div{height:1px;background:var(--line);margin:14px 0}
.el{font-size:13px;font-weight:800;margin:2px 0 12px}.el span{font-size:10.5px;color:var(--sub);font-weight:600;margin-left:6px}
.trend{display:flex;align-items:flex-end;gap:10px;height:76px;padding:0 4px}
.trend .tb{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}
.trend .tb .b{width:16px;border-radius:6px 6px 3px 3px;background:linear-gradient(180deg,var(--c),var(--o));opacity:.45}
.trend .tb.cur .b{opacity:1}.trend .tb .v{font-size:9.5px;font-weight:800}.trend .tb .l{font-size:9px;font-weight:700;color:var(--sub)}
.quote{padding:13px 15px;border-radius:14px;background:linear-gradient(135deg,rgba(249,110,0,.07),rgba(255,154,77,.04));border-left:3px solid var(--o);margin-top:14px}
.quote .w{font-size:10.5px;font-weight:800;letter-spacing:.08em;color:var(--o);margin-bottom:4px}.quote .m{font-size:12.5px;font-weight:600;color:#4A3A2C;line-height:1.55}
.notes{display:grid;grid-template-columns:1fr;gap:12px}
.note{border-radius:16px;overflow:hidden;background:#fff;outline:1px solid var(--line)}
.note img{display:block;width:100%;height:auto}
.note .cap{display:flex;justify-content:space-between;padding:10px 12px;font-size:12.5px;font-weight:700}.note .cap span{color:var(--sub);font-weight:600;font-size:11px}
.gone{padding:30px 0;text-align:center;font-size:12px;color:var(--sub);background:#F2F4F8}
.tabbar{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);width:min(364px,calc(100% - 24px));background:rgba(28,30,38,.93);border-radius:999px;display:flex;padding:8px 9px;box-shadow:0 12px 32px rgba(28,30,38,.3)}
.tab{flex:1;text-align:center;padding:9px 0;border-radius:999px;color:#8B92A3;font-size:12px;font-weight:700}
.tab.on{background:linear-gradient(135deg,var(--c),var(--o));color:#fff;box-shadow:0 4px 12px rgba(249,110,0,.4)}
.foot{text-align:center;font-size:10.5px;color:#AEB6C4;margin:8px 0}
.gate{max-width:380px;margin:0 auto;padding:40px 20px}
.gate h1{font-size:20px;font-weight:800;margin:18px 0 6px;letter-spacing:-.5px}.gate p{font-size:13px;color:var(--sub);line-height:1.6}
.gate form{margin-top:22px}
.gate input{width:100%;font-size:28px;font-weight:800;letter-spacing:14px;text-align:center;padding:14px;border-radius:16px;border:1.5px solid #E3E6EC;background:#fff;color:var(--ink)}
.gate input:focus{outline:none;border-color:var(--o);box-shadow:0 0 0 4px rgba(249,110,0,.12)}
.gate button{width:100%;margin-top:12px;padding:15px;border:0;border-radius:16px;font-size:15px;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--c),var(--o));box-shadow:0 8px 20px rgba(249,110,0,.3)}
.err{margin-top:12px;font-size:12.5px;font-weight:700;color:#B3261E;text-align:center}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#F7F8FB">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head><body>${body}</body></html>`;
}

function brand(academyName: string): string {
  const mark = esc(Array.from(academyName.trim())[0] ?? "학");
  return `<div class="top"><div class="lm">${mark}</div><div class="bn">${esc(academyName)}<small>학부모 · 학생 조회</small></div></div>`;
}

function tabbar(nav: Nav, active: View, v: ParentView): string {
  const q = { w: v.week?.weekStart ?? null, c: v.classId };
  const t = (view: View, label: string) => `<a class="tab${active === view ? " on" : ""}" href="${esc(nav.href(view, q))}">${label}</a>`;
  return `<nav class="tabbar">${t("home", "홈")}${t("homework", "숙제")}${t("exam", "시험")}${t("notes", "노트")}</nav>`;
}

function previewBand(nav: Nav, v: ParentView): string {
  if (!nav.preview) return "";
  const state = v.week && !v.week.published ? " · <b>이 주는 아직 공개 전이라 부모님께 안 보입니다</b>" : "";
  return `<div class="pv">선생님 미리보기 화면입니다${state}</div>`;
}

function detailHead(nav: Nav, v: ParentView, title: string): string {
  return `<div class="dh"><a class="back" href="${esc(nav.href("home", { w: v.week?.weekStart, c: v.classId }))}" aria-label="뒤로">‹</a><div class="t">${esc(title)}</div><div class="s">${esc(v.student.name)}${v.className ? ` · ${esc(v.className)}` : ""}</div></div>`;
}

function schedulePill(item: ParentView["schedule"][number], today: string): string {
  if (item.status === "done") return `<span class="pill p-g">${item.reason === "retest" ? "통과" : "완료"}</span>`;
  if (item.status === "noshow") return `<span class="pill p-r">불참</span>`;
  const dd = daysBetween(today, item.date);
  if (dd < 0) return `<span class="pill p-n">지남</span>`;
  return `<span class="pill ${dd <= 3 ? "p-d" : "p-o"}">${dd === 0 ? "오늘" : `D-${dd}`}</span>`;
}

// ─── 홈 ──────────────────────────────────────────────────────────────────

export function renderHome(v: ParentView, nav: Nav): string {
  const q = { w: v.week?.weekStart, c: v.classId };
  const upcoming = v.schedule.filter((s) => s.date >= v.today && s.status === "scheduled");
  const urgent = upcoming.find((s) => daysBetween(v.today, s.date) <= 7);

  const weekNav = v.week
    ? `<div class="wk">${v.prevWeek ? `<a href="${esc(nav.href("home", { w: v.prevWeek, c: v.classId }))}" aria-label="지난 주">‹</a>` : `<i>‹</i>`}<span>${weekPill(v.week.label)}</span>${
        v.nextWeek ? `<a href="${esc(nav.href("home", { w: v.nextWeek, c: v.classId }))}" aria-label="다음 주">›</a>` : `<i>›</i>`
      }</div>`
    : "";

  const classChips =
    v.classes.length > 1
      ? `<div class="chips">${v.classes.map((c) => `<a class="chip${c.id === v.classId ? " on" : ""}" href="${esc(nav.href("home", { c: c.id }))}">${esc(c.name)}</a>`).join("")}</div>`
      : "";

  let tiles = "";
  if (v.week) {
    const pct = v.week.progressPct;
    const off = pct == null ? 113 : Math.round(113 * (1 - pct / 100));
    const doneN = v.homework.filter((h) => h.status === "done").length;
    const short = v.homework.reduce((s, h) => s + (h.shortfall ?? 0), 0);
    const anyNone = v.homework.some((h) => h.status === "none");
    const hwNote = !v.homework.length
      ? `<div class="n">이번 주 숙제 없음</div>`
      : short
        ? `<div class="n warn">${short}${esc(v.homework.find((h) => h.shortfall)?.countUnit ?? "문항")} 모자랍니다</div>`
        : anyNone
          ? `<div class="n bad">안 해온 숙제가 있어요</div>`
          : doneN === v.homework.length
            ? `<div class="n ok">모두 완료!</div>`
            : `<div class="n">검사 중이에요</div>`;
    const ex = [...v.exams].reverse().find((e) => e.total != null);
    const exNote = ex
      ? `<div class="n ${ex.passed === false ? "warn" : "ok"}">${ex.topPct ? `상위 ${ex.topPct}%` : esc(ex.name)}${ex.passed === true ? " · 통과" : ex.passed === false ? " · 재시" : ""}</div>`
      : `<div class="n">이번 주 시험 없음</div>`;
    // 단어시험은 올 때마다 본다(주 2~3회) — 부모님이 가장 자주 궁금해하는 칸이라 타일 하나를 준다.
    const vc = vocabCounts(v.vocab);
    const vocabNote = !v.vocab.length
      ? `<div class="n">이번 주 기록 없음</div>`
      : vc.retestOpen
        ? `<div class="n bad">재시험 ${vc.retestOpen}회 남음</div>`
        : vc.rewrite
          ? `<div class="n warn">반복쓰기 ${vc.rewrite}회</div>`
          : `<div class="n ok">모두 통과!</div>`;
    tiles = `<div class="tiles">
<a class="tile" href="${esc(nav.href("homework", q))}"><div class="tt">현재 진도</div><div class="big">${pct ?? "-"}<small>${pct == null ? "" : "%"}</small></div><div class="n">${esc(v.week.unit ?? v.week.textbook ?? "")}</div>
<svg class="ring" width="44" height="44" viewBox="0 0 44 44" style="transform:rotate(-90deg)"><circle cx="22" cy="22" r="18" fill="none" stroke="#EDF0F5" stroke-width="5"/><circle cx="22" cy="22" r="18" fill="none" stroke="#F96E00" stroke-width="5" stroke-linecap="round" stroke-dasharray="113" stroke-dashoffset="${off}"/></svg></a>
<a class="tile" href="${esc(nav.href("homework", q))}"><div class="tt">숙제</div><div class="big">${doneN}<small>/${v.homework.length} 완료</small></div>${hwNote}</a>
<a class="tile" href="${esc(nav.href("homework", q))}#vocab"><div class="tt">단어시험</div><div class="big">${v.vocab.length ? `${vc.pass}<small>/${v.vocab.length}회 통과</small>` : "-"}</div>${vocabNote}</a>
<a class="tile" href="${esc(nav.href("exam", q))}"><div class="tt">최근 시험</div><div class="big">${ex ? `${ex.total}<small>점</small>` : `-`}</div>${exNote}</a>
</div>`;
  } else {
    tiles = `<div class="card"><div class="empty">아직 공개된 학습 기록이 없어요.<br>선생님이 기록을 올리면 여기에 보입니다.</div></div>`;
  }

  const list = (upcoming.length ? upcoming : v.schedule.slice(-3)).slice(0, 3);
  const sched = `<div class="card"><div class="sh"><span class="t">다가오는 일정</span></div>${
    list.length
      ? list.map((s) => `<div class="row"><span class="dt">${fmtShort(s.date)}</span><span class="nm">${esc(REASON[s.reason] ?? "보강")} · ${esc(s.content)}${s.startTime ? ` <span style="color:var(--sub);font-size:11px">${fmtTime(s.startTime)}</span>` : ""}</span>${schedulePill(s, v.today)}</div>`).join("")
      : `<div class="empty">예정된 보강·재시험이 없어요</div>`
  }</div>`;

  const visiblePhotos = v.photos.filter((p) => !p.purged).length;
  const notesCard = visiblePhotos
    ? `<a class="card" style="display:flex;align-items:center;gap:10px" href="${esc(nav.href("notes", q))}"><span style="font-size:14.5px;font-weight:800">나의 노트정리</span><span style="font-size:12px;color:var(--sub)">이번 주 ${visiblePhotos}장</span><span class="pill p-d" style="margin-left:auto">NEW</span><span style="color:#C3CAD8;font-weight:800">›</span></a>`
    : "";

  const body = `${previewBand(nav, v)}<div class="wrap">${brand(v.academyName)}
<div class="hero"><div class="hello">${v.week ? "이번 주 학습 소식이에요" : "학습 리포트"}</div><div class="hr"><div class="st">${esc(v.student.name)}<small>${esc([v.student.grade, v.className].filter(Boolean).join(" · "))}</small></div>${weekNav}</div></div>
${classChips}
${urgent ? `<div class="urgent"><div class="d">${daysBetween(v.today, urgent.date) === 0 ? "오늘" : `D-${daysBetween(v.today, urgent.date)}`}</div><div><div class="t">${esc(REASON[urgent.reason] ?? "보강")} · ${esc(urgent.content)}</div><div class="s">${fmtDate(urgent.date)}${urgent.startTime ? ` ${fmtTime(urgent.startTime)}` : ""}</div></div></div>` : ""}
${tiles}
${sched}
${notesCard}
<div class="foot">선생님이 기록한 학습 정보입니다</div>
</div>${tabbar(nav, "home", v)}`;
  return page(`${v.student.name} 학습 리포트`, body);
}

// ─── 숙제 ────────────────────────────────────────────────────────────────

/** 단어시험 카드. 날짜마다 "50개 중 3개 틀림 · 통과". 재시험은 다시 봐서 통과했는지까지 보여 준다. */
function vocabCard(v: ParentView): string {
  if (!v.week) return "";
  const c = vocabCounts(v.vocab);
  const pill = (x: ParentView["vocab"][number]) =>
    x.result === "pass"
      ? `<span class="pill p-g">통과</span>`
      : x.result === "rewrite"
        ? `<span class="pill p-o">반복쓰기</span>`
        : x.retestPassed
          ? `<span class="pill p-g">재시 통과</span>`
          : `<span class="pill p-r">재시험</span>`;
  const sub = (x: ParentView["vocab"][number]) =>
    x.result === "rewrite" ? " · 틀린 단어를 남아서 다시 썼어요" : x.result === "retest" && !x.retestPassed ? " · 다시 시험을 봐요" : "";
  return `<div class="card" id="vocab"><div class="sh"><span class="t">단어시험</span><span class="r">${v.vocab.length ? `<b>${c.pass}</b> / ${v.vocab.length}회 통과` : ""}</span></div>${
    v.vocab.length
      ? v.vocab
          .map(
            (x) =>
              `<div class="hw"><div class="top2"><span class="n">${fmtDate(x.date).replace(/^\d+월 /, "")}</span>${pill(x)}</div><div class="sub">${x.total}개 중 <b>${x.total - x.wrong}개</b> 맞힘 (${x.wrong}개 틀림)${sub(x)}</div><div class="meter"><div class="${x.result === "pass" ? "g" : ""}" style="width:${Math.round(((x.total - x.wrong) / x.total) * 100)}%"></div></div></div>`
          )
          .join("")
      : `<div class="empty">이번 주 단어시험 기록이 아직 없어요</div>`
  }<div style="font-size:10.5px;color:#AEB6C4;margin-top:8px">틀린 개수 ${VOCAB_PASS_PCT}% 이하 통과 · ${VOCAB_REWRITE_PCT}% 이하 반복쓰기 · 그 이상 재시험</div></div>`;
}

export function renderHomework(v: ParentView, nav: Nav): string {
  const items = v.homework;
  const doneN = items.filter((h) => h.status === "done").length;
  const progress = v.week
    ? `<div class="card"><div class="sh"><span class="t">현재 진도</span><span class="r">${v.week.progressPct != null ? `<b>${v.week.progressPct}%</b>` : ""}</span></div>
<div style="font-size:12px;color:var(--sub);font-weight:700">${esc(v.week.textbook ?? "")}</div>
<div style="font-size:16px;font-weight:800;margin-top:3px">${esc(v.week.unit ?? "")}</div>
${v.week.topic ? `<div style="display:inline-block;margin-top:8px;font-size:11.5px;font-weight:600;color:#B35000;background:rgba(249,110,0,.08);padding:5px 10px;border-radius:8px">${esc(v.week.topic)}</div>` : ""}
${v.week.progressPct != null ? `<div class="meter" style="margin-top:12px;height:7px"><div style="width:${v.week.progressPct}%"></div></div>` : ""}</div>`
    : "";

  const row = (h: ParentView["homework"][number]) => {
    const pill =
      h.status === "done" ? `<span class="pill p-g">완료</span>` : h.status === "partial" ? `<span class="pill p-o">일부</span>` : h.status === "none" ? `<span class="pill p-r">안 해옴</span>` : `<span class="pill p-b">출제됨</span>`;
    const unit = esc(h.countUnit ?? "개");
    const due = h.dueDate ? `${fmtDate(h.dueDate).replace(/^\d+월 /, "")}까지` : "";
    let sub = "";
    if (h.status === "done") sub = `${h.totalCount ? `${h.totalCount}${unit} 전부 해옴 · ` : ""}<b class="ok">검사 통과</b>`;
    else if (h.status === "partial") sub = h.totalCount && h.doneCount != null ? `${h.totalCount}${unit} 중 ${h.doneCount}개 해옴 · <b class="warn">${h.shortfall}${unit} 모자랍니다</b>${due ? ` · ${due}` : ""}` : `일부만 해왔어요${due ? ` · ${due}` : ""}`;
    else if (h.status === "none") sub = `<b class="bad">안 해왔어요</b>${due ? ` · ${due}` : ""}`;
    else sub = due || "아직 검사 전이에요";
    const pct = h.totalCount && h.doneCount != null ? Math.round((Math.min(h.doneCount, h.totalCount) / h.totalCount) * 100) : h.status === "done" ? 100 : 0;
    return `<div class="hw"><div class="top2"><span class="n">${esc(h.title)}</span>${pill}</div><div class="sub">${sub}</div><div class="meter"><div class="${h.status === "done" ? "g" : ""}" style="width:${pct}%"></div></div></div>`;
  };

  const behind = items.filter((h) => h.status === "partial" || h.status === "none");
  const body = `${previewBand(nav, v)}<div class="wrap">${detailHead(nav, v, "숙제 검사")}
${progress}
<div class="card"><div class="sh"><span class="t">${v.week ? esc(v.week.label) : "이번 주"}</span><span class="r"><b>${doneN}</b> / ${items.length} 완료</span></div>${items.length ? items.map(row).join("") : `<div class="empty">이번 주 숙제가 없어요</div>`}</div>
${vocabCard(v)}
${behind.length ? `<div class="card"><div class="sh"><span class="t">밀린 숙제</span><span class="r"><b>${behind.length}</b>건</span></div>${behind.map((h) => `<div class="hw"><div class="top2"><span class="n">${esc(h.title)}</span><span class="pill p-o">보충 필요</span></div><div class="sub">${h.shortfall ? `${h.shortfall}${esc(h.countUnit ?? "개")} 남았어요 · ` : ""}다음 등원일에 다시 검사해요</div></div>`).join("")}</div>` : ""}
${v.history.length ? `<div class="card"><div class="sh"><span class="t">지난 기록</span></div>${v.history.map((x) => `<div class="row"><span class="dt" style="width:62px;color:var(--sub)">${esc(x.label.replace("주차", "주"))}</span><span class="nm">${x.done === x.total ? `${x.total}건 모두 완료` : `${x.done}건 완료${x.partial ? ` · ${x.partial}건 일부` : ""}${x.none ? ` · ${x.none}건 안 해옴` : ""}`}</span>${x.done === x.total ? `<span class="pill p-g">완료</span>` : `<span class="pill p-o">일부</span>`}</div>`).join("")}</div>` : ""}
</div>${tabbar(nav, "homework", v)}`;
  return page(`${v.student.name} 숙제`, body);
}

// ─── 시험 ────────────────────────────────────────────────────────────────

export function renderExam(v: ParentView, nav: Nav): string {
  const card = (e: ParentView["exams"][number]) => {
    if (e.absent) return `<div class="card"><div class="sh"><span class="t">${esc(e.name)}</span><span class="r">${fmtShort(e.examDate)}</span></div><div class="empty">결시했어요</div></div>`;
    const pos =
      e.average != null && e.total != null && e.takers >= 2
        ? `<div class="pr"><span>반 평균 ${e.average}점</span><span class="me">${esc(v.student.name)} ${e.total}점</span></div><div class="pt"><div class="f" style="width:${e.total}%"></div><div class="a" style="left:${e.average}%"></div><div class="dot" style="left:${e.total}%"></div></div><div class="lg"><span>0</span><span>50</span><span>100</span></div>`
        : "";
    const bars = e.areas
      .filter((a) => typeof e.areaScores[a] === "number")
      .map((a) => `<div class="bar"><span class="l">${esc(a)}</span><div class="tr"><div style="width:${e.areaScores[a]}%"></div></div><span class="v">${e.areaScores[a]}</span></div>`)
      .join("");
    const rule = [e.takers >= 2 ? `${e.takers}명 응시` : "", e.passScore != null ? `통과 기준 ${e.passScore}점` : ""].filter(Boolean).join(" · ");
    return `<div class="card"><div class="sh"><span class="t">${esc(e.name)}</span><span class="r">${fmtDate(e.examDate).replace(/ \(.\)$/, "")}</span></div>
<div class="score"><span class="v">${e.total ?? "-"}</span><span class="u">점</span>${e.topPct ? `<span class="top">상위 ${e.topPct}%</span>` : e.passed === true ? `<span class="top" style="color:var(--good)">통과</span>` : e.passed === false ? `<span class="top">재시험</span>` : ""}</div>
<div class="ss">${esc(rule)}</div>${pos}
${bars ? `<div class="div"></div><div class="el">영역별 성취도<span>이번 시험</span></div>${bars}` : ""}
${e.comment ? `<div class="quote"><div class="w">TEACHER'S NOTE</div><div class="m">${esc(e.comment)}</div></div>` : ""}</div>`;
  };

  const max = Math.max(100, ...v.trend.map((t) => t.total));
  const trend =
    v.trend.length >= 2
      ? `<div class="card"><div class="el">최근 추이<span>최근 ${v.trend.length}회 점수</span></div><div class="trend">${v.trend
          .map((t, i) => `<div class="tb${i === v.trend.length - 1 ? " cur" : ""}"><span class="v">${t.total}</span><div class="b" style="height:${Math.max(6, Math.round((t.total / max) * 50))}px"></div><span class="l">${fmtShort(t.date).replace(".", "/")}</span></div>`)
          .join("")}</div></div>`
      : "";
  const retests = v.schedule.filter((s) => s.reason === "retest");
  const body = `${previewBand(nav, v)}<div class="wrap">${detailHead(nav, v, "시험 결과")}
${v.exams.length ? v.exams.map(card).join("") : `<div class="card"><div class="empty">${v.week ? "이번 주 시험 기록이 없어요" : "아직 공개된 시험 기록이 없어요"}</div></div>`}
${trend}
${retests.length ? `<div class="card"><div class="sh"><span class="t">재시 기록</span></div>${retests.map((s) => `<div class="row"><span class="dt" style="color:var(--sub)">${fmtShort(s.date)}</span><span class="nm">${esc(s.content)}</span>${schedulePill(s, v.today)}</div>`).join("")}</div>` : ""}
</div>${tabbar(nav, "exam", v)}`;
  return page(`${v.student.name} 시험 결과`, body);
}

// ─── 노트 ────────────────────────────────────────────────────────────────

export function renderNotes(v: ParentView, nav: Nav): string {
  const body = `${previewBand(nav, v)}<div class="wrap">${detailHead(nav, v, "나의 노트정리")}
<div style="padding:0 20px 12px;font-size:12px;color:var(--sub)">선생님이 직접 올려 주시는 수업 노트예요.</div>
<div class="notes" style="margin:0 16px">${
    v.photos.length
      ? v.photos
          .map((p) =>
            p.purged
              ? `<div class="note"><div class="gone">보관 기간(6개월)이 지난 사진이에요</div><div class="cap">${esc(p.title)}<span>${fmtShort(p.takenDate)}</span></div></div>`
              : `<div class="note"><img src="${esc(nav.photo(p.id))}" alt="${esc(p.title)}" loading="lazy"><div class="cap">${esc(p.title)}<span>${fmtShort(p.takenDate)}</span></div></div>`
          )
          .join("")
      : `<div class="card" style="margin:0"><div class="empty">${v.week ? "이번 주 노트가 아직 없어요" : "아직 공개된 노트가 없어요"}</div></div>`
  }</div>
</div>${tabbar(nav, "notes", v)}`;
  return page(`${v.student.name} 노트`, body);
}

// ─── 문 앞 화면들 ─────────────────────────────────────────────────────────

/**
 * 보호자 번호 뒤 4자리 확인. 폼 하나뿐이고 스크립트가 없다.
 * **학생 이름을 쓰지 않는다** — 링크만 주운 사람에게 아이 이름도 알려 주지 않으려고.
 * 부모님은 카톡 안내 문구에서 이미 이름을 봤다.
 */
export function renderVerify(opts: { academyName: string; action: string; error?: string }): string {
  return page(
    `${opts.academyName} 학습 리포트`,
    `<div class="gate">${brand(opts.academyName).replace('class="top"', 'class="top" style="padding:0"')}
<h1>자녀 학습 리포트</h1>
<p>본인 확인을 위해 학원에 등록된<br><b style="color:var(--ink)">보호자 휴대폰 번호 뒤 4자리</b>를 입력해 주세요.<br>이 폰에서는 한 번만 입력하면 됩니다.</p>
<form method="post" action="${esc(opts.action)}">
<input name="last4" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" required autofocus aria-label="보호자 번호 뒤 4자리">
<button type="submit">확인</button>
${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
</form></div>`
  );
}

/** 링크로 열 수 없을 때. 레벨테스트 안내와 달리 "학습 리포트" 말로 적는다. */
export function renderGate(kind: "notfound" | "closed" | "locked" | "ratelimited" | "nophone", opts: { academyName?: string; until?: Date } = {}): string {
  const until = opts.until ? opts.until.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Seoul" }) : "";
  const msg = {
    notfound: ["리포트를 찾을 수 없습니다", "주소가 잘못되었거나 새 링크로 바뀌었습니다.<br>학원에서 받은 최신 링크를 확인해 주세요."],
    closed: ["닫힌 링크입니다", "학원에서 새 링크를 보냈거나 링크를 닫았습니다.<br>학원으로 연락 주시면 다시 보내 드립니다."],
    locked: ["잠시 잠겼습니다", `번호를 여러 번 틀려 잠시 잠갔습니다.<br>${until ? `${until} 이후에 ` : "잠시 후 "}다시 시도하시거나 학원으로 연락 주세요.`],
    ratelimited: ["잠시 후 다시 시도해 주세요", "짧은 시간에 너무 많이 열었습니다.<br>10분 뒤에 다시 눌러 주세요."],
    nophone: ["학원에 확인이 필요합니다", "본인 확인용 보호자 번호가 학원에 등록돼 있지 않습니다.<br>학원으로 연락 주세요."],
  }[kind];
  return page(msg[0], `<div class="gate">${opts.academyName ? brand(opts.academyName).replace('class="top"', 'class="top" style="padding:0"') : ""}<h1>${esc(msg[0])}</h1><p>${msg[1]}</p></div>`);
}
