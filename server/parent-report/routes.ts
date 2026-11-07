/**
 * 학부모 학습 리포트 — 부모님이 **로그인 없이** 여는 경로. ⚠️
 *
 *   GET  /p/:token                      홈 (확인 전이면 번호 뒤 4자리 입력 화면)
 *   POST /p/:token/verify               번호 뒤 4자리 확인
 *   GET  /p/:token/homework|exam|notes  상세 화면
 *   GET  /p/:token/photo/:photoId       노트 사진
 *
 * 이 파일은 레벨테스트 결과지(/r/, server/level-test/shareRoutes.ts)에 이어 **두 번째 공개 경로**다.
 * 토큰 규칙·횟수 제한·이스케이프는 server/lib/shareLink.ts 를 그대로 쓴다. 고치기 전에 그 머리말을 읽을 것.
 * 설계: docs/PARENT_REPORT_PLAN.md §4
 *
 * 지킨 선
 *   1) 토큰 하나 = 학생 한 명. 학원 id 를 주소로 받지 않는다(받으면 공격자가 고른다).
 *   2) 링크만으로는 안 열린다 — 보호자 번호 뒤 4자리를 한 번 맞혀야 한다. 4자리는 1만 가지라
 *      **링크별 잠금**이 핵심이다: 5번 틀리면 30분, 10번 틀리면 하루. 맞히면 0 으로 돌아간다.
 *   3) 한 번 맞힌 폰은 쿠키로 기억한다(180일). 쿠키 값은 링크 id·토큰·번호 뒤 4자리의 서명이라,
 *      재발급(토큰이 바뀜)하거나 보호자 번호를 고치면 저절로 무효가 된다.
 *   4) 퇴원(isActive=false)하면 링크가 저절로 닫힌다.
 *   5) 보여 주는 값은 data.ts 가 골라 담은 것뿐이다. 수납·연락처·다른 학생 점수는 나갈 길이 없다.
 *   6) 쓰기는 "열어 본 시각·횟수" 와 "틀린 횟수·잠금" 뿐이다. 토큰은 로그에 찍지 않는다.
 */

import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { parentLinks, tenants, type ParentLink } from "@shared/schema";
import { phoneLast4 } from "@shared/learningReport";
import { isWellFormedShareToken, checkShareRate, sweepShareRate } from "../lib/shareLink";
import { readPhoto } from "../learning-report/photoStore";
import { buildParentView, loadParentStudent, canParentSeePhoto } from "./data";
import { renderHome, renderHomework, renderExam, renderNotes, renderVerify, renderGate, type Nav, type View } from "./render";

const router = Router();

const COOKIE = "pr";
const COOKIE_DAYS = 180;
export const LOCK_EVERY = 5;
const SHORT_LOCK_MS = 30 * 60 * 1000;
const LONG_LOCK_MS = 24 * 60 * 60 * 1000;

/**
 * 쿠키 서명 열쇠. 운영에는 JWT_SECRET 이 있다. 둘 다 없으면(로컬) 프로세스마다 새 열쇠라
 * 서버를 다시 켜면 부모님이 번호를 한 번 더 넣게 될 뿐이다.
 */
const SECRET = process.env.PARENT_LINK_SECRET || process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");

export function verificationProof(link: Pick<ParentLink, "id" | "token">, last4: string): string {
  return crypto.createHmac("sha256", SECRET).update(`parent-report:${link.id}:${link.token}:${last4}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 어떤 응답이든 캐시·검색·주소 유출을 막는다. 스크립트는 통째로 금지(이 화면엔 스크립트가 없다). */
function guardHeaders(res: Response) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

type Ctx = { link: ParentLink; student: NonNullable<Awaited<ReturnType<typeof loadParentStudent>>>; last4: string };

/**
 * 문 앞 확인. 통과하면 Ctx, 막히면 안내 화면을 보내고 null.
 * rateLimit=false 는 사진 요청용 — 노트 화면 한 번에 사진 여러 장을 부르므로 횟수에 넣지 않는다
 * (사진은 확인 쿠키가 있어야만 나가므로 긁기에 쓸 수 없다).
 */
async function gate(req: Request, res: Response, rateLimit = true): Promise<Ctx | null> {
  const token = req.params.token;
  if (!isWellFormedShareToken(token)) {
    res.status(404).type("html").send(renderGate("notfound"));
    return null;
  }
  if (rateLimit) {
    sweepShareRate();
    if (!checkShareRate(req.ip || req.socket.remoteAddress || "unknown")) {
      res.status(429).type("html").send(renderGate("ratelimited"));
      return null;
    }
  }
  const [link] = await db.select().from(parentLinks).where(eq(parentLinks.token, token));
  if (!link) {
    res.status(404).type("html").send(renderGate("notfound"));
    return null;
  }
  if (link.revokedAt) {
    res.status(410).type("html").send(renderGate("closed"));
    return null;
  }
  const student = await loadParentStudent(link.tenantId, link.studentId);
  if (!student) {
    res.status(410).type("html").send(renderGate("closed"));
    return null;
  }
  const last4 = phoneLast4(student.parentPhone);
  if (!last4) {
    res.status(403).type("html").send(renderGate("nophone"));
    return null;
  }
  return { link, student, last4 };
}

function isVerified(req: Request, ctx: Ctx): boolean {
  const got = req.cookies?.[COOKIE];
  return typeof got === "string" && safeEqual(got, verificationProof(ctx.link, ctx.last4));
}

function parentNav(token: string): Nav {
  return {
    href: (view, q) => {
      const params = new URLSearchParams();
      if (q?.w) params.set("w", q.w);
      if (q?.c) params.set("c", q.c);
      const qs = params.toString();
      return `/p/${token}${view === "home" ? "" : `/${view}`}${qs ? `?${qs}` : ""}`;
    },
    photo: (id) => `/p/${token}/photo/${id}`,
  };
}

async function academyNameOf(tenantId: string): Promise<string> {
  const [t] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  return t?.name ?? "학원";
}

const RENDER: Record<View, typeof renderHome> = { home: renderHome, homework: renderHomework, exam: renderExam, notes: renderNotes };

async function showView(req: Request, res: Response, view: View) {
  guardHeaders(res);
  try {
    const ctx = await gate(req, res);
    if (!ctx) return;
    if (!isVerified(req, ctx)) {
      const academyName = await academyNameOf(ctx.link.tenantId);
      return res
        .status(200)
        .type("html")
        .send(renderVerify({ academyName, action: `/p/${ctx.link.token}/verify` }));
    }
    const v = await buildParentView({
      tenantId: ctx.link.tenantId,
      studentId: ctx.link.studentId,
      classId: typeof req.query.c === "string" ? req.query.c : undefined,
      weekStart: typeof req.query.w === "string" ? req.query.w : undefined,
    });
    if (!v) return res.status(410).type("html").send(renderGate("closed"));
    if (view === "home") {
      // 열어 본 기록. 응답을 막지 않는다 — 이것 때문에 부모님 화면이 늦어지면 안 된다.
      db.update(parentLinks)
        .set({ lastViewedAt: new Date(), viewCount: sql`${parentLinks.viewCount} + 1` })
        .where(eq(parentLinks.id, ctx.link.id))
        .catch((err) => console.error("학습 리포트 열람 기록 실패 (화면은 정상):", err));
    }
    res.status(200).type("html").send(RENDER[view](v, parentNav(ctx.link.token)));
  } catch (err) {
    console.error("학습 리포트 공개 화면 오류:", err);
    if (!res.headersSent) res.status(500).type("html").send(renderGate("notfound"));
  }
}

router.get("/p/:token", (req, res) => showView(req, res, "home"));
router.get("/p/:token/:view(homework|exam|notes)", (req, res) => showView(req, res, req.params.view as View));

router.post("/p/:token/verify", async (req: Request, res: Response) => {
  guardHeaders(res);
  try {
    const ctx = await gate(req, res);
    if (!ctx) return;
    const now = new Date();
    if (ctx.link.lockedUntil && ctx.link.lockedUntil > now) {
      return res.status(429).type("html").send(renderGate("locked", { until: ctx.link.lockedUntil }));
    }
    const input = String(req.body?.last4 ?? "").replace(/\D/g, "");
    const academyName = await academyNameOf(ctx.link.tenantId);

    if (input.length === 4 && safeEqual(input, ctx.last4)) {
      await db.update(parentLinks).set({ failedAttempts: 0, lockedUntil: null }).where(eq(parentLinks.id, ctx.link.id));
      res.cookie(COOKIE, verificationProof(ctx.link, ctx.last4), {
        httpOnly: true,
        sameSite: "lax",
        secure: req.secure,
        maxAge: COOKIE_DAYS * 24 * 60 * 60 * 1000,
        // 이 링크 주소 아래에서만 쓰인다. 같은 폰으로 형제 두 명 링크를 열어도 서로 섞이지 않는다.
        path: `/p/${ctx.link.token}`,
      });
      return res.redirect(303, `/p/${ctx.link.token}`);
    }

    // 틀림. 맞힐 때까지 누적한다 — 5번째마다 잠그고, 10번을 넘기면 하루씩 잠근다.
    const attempts = ctx.link.failedAttempts + 1;
    const lock = attempts % LOCK_EVERY === 0 ? new Date(now.getTime() + (attempts >= LOCK_EVERY * 2 ? LONG_LOCK_MS : SHORT_LOCK_MS)) : null;
    await db.update(parentLinks).set({ failedAttempts: attempts, lockedUntil: lock }).where(eq(parentLinks.id, ctx.link.id));
    if (lock) return res.status(429).type("html").send(renderGate("locked", { academyName, until: lock }));
    const left = LOCK_EVERY - (attempts % LOCK_EVERY);
    res
      .status(401)
      .type("html")
      .send(
        renderVerify({
          academyName,
          action: `/p/${ctx.link.token}/verify`,
          error: `번호가 맞지 않습니다. ${left}번 더 틀리면 잠시 잠깁니다.`,
        })
      );
  } catch (err) {
    console.error("학습 리포트 번호 확인 오류:", err);
    if (!res.headersSent) res.status(500).type("html").send(renderGate("notfound"));
  }
});

router.get("/p/:token/photo/:photoId", async (req: Request, res: Response) => {
  try {
    const ctx = await gate(req, res, false);
    if (!ctx) return;
    if (!isVerified(req, ctx) || !/^[0-9a-f-]{36}$/i.test(req.params.photoId)) return res.status(404).end();
    if (!(await canParentSeePhoto(ctx.link.tenantId, ctx.link.studentId, req.params.photoId))) return res.status(404).end();
    const file = await readPhoto(req.params.photoId);
    if (!file) return res.status(404).end();
    res.setHeader("Content-Type", file.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.end(file.data);
  } catch (err) {
    console.error("학습 리포트 사진 오류:", err);
    if (!res.headersSent) res.status(500).end();
  }
});

export default router;
