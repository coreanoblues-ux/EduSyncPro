/**
 * 학부모용 결과지 링크 — 라우터.
 *
 *   POST   /api/level-tests/:id/share   링크 발급 (원장·강사)
 *   DELETE /api/level-tests/:id/share   링크 끊기 (원장·강사)
 *   GET    /r/:token                    학부모용 결과지 (로그인 없음) ⚠️
 *   GET    /robots.txt                  /r/ 를 검색 로봇에서 제외
 *
 * ⚠️ /r/:token 은 이 시스템에서 유일하게 인증 없이 열리는 경로다.
 *    판단 근거와 지킨 선은 server/lib/shareLink.ts 머리말에 모아 뒀다.
 *    이 파일을 고칠 때는 그 머리말을 먼저 읽을 것.
 *
 * ── 왜 routes.ts 와 다른 파일인가 ──
 *   같은 파일에 두면 위쪽 라우트들이 전부 authGuard 를 달고 있는 사이에
 *   인증 없는 라우트 하나가 섞인다. 나중에 읽는 사람이 "여기는 다 로그인
 *   필요하겠지" 하고 넘기게 되는 자리를 만들면 안 된다. 파일을 갈라 두면
 *   "이 파일 안에 공개 경로가 있다" 가 파일 이름과 머리말로 드러난다.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";
import {
  generateShareToken,
  isWellFormedShareToken,
  shareExpiryFrom,
  shareState,
  checkShareRate,
  sweepShareRate,
  renderSharePage,
  renderShareError,
  SHARE_DEFAULT_DAYS,
} from "../lib/shareLink";

const router = Router();

const idParamSchema = z.object({ id: z.string().uuid("유효하지 않은 ID 형식입니다.") });

/**
 * 링크 유효 기간. 기본은 5일(SHARE_DEFAULT_DAYS)이고, 발급할 때
 * 1~180일 사이로 지정할 수 있다.
 *
 * · 아래쪽을 1일까지 연 이유: 기본이 5일로 짧아졌으니, "오늘 상담 끝날
 *   때까지만" 같은 더 짧은 요구가 나오면 받아 줄 수 있어야 한다.
 * · 위쪽에 상한(180일)을 두는 이유: **"영구 링크" 를 만들 방법이 없어야
 *   한다.** 끝나지 않는 링크는 나중에 반드시 사고가 된다.
 */
const issueBodySchema = z.object({
  days: z.number().int().min(1).max(180).optional(),
});

/** 응답에 실어 보내는 링크 상태. 원장 화면이 그대로 그린다. */
function shareInfo(row: {
  shareToken: string | null;
  shareCreatedAt: Date | null;
  shareExpiresAt: Date | null;
  shareRevokedAt: Date | null;
  shareViewCount: number;
  shareLastViewedAt: Date | null;
}) {
  return {
    token: row.shareToken,
    state: shareState(row),
    createdAt: row.shareCreatedAt,
    expiresAt: row.shareExpiresAt,
    revokedAt: row.shareRevokedAt,
    viewCount: row.shareViewCount,
    lastViewedAt: row.shareLastViewedAt,
  };
}

// ─── 발급 ────────────────────────────────────────────────────────────────
router.post(
  "/api/level-tests/:id/share",
  authGuard,
  tenantGuard,
  roleGuard("owner", "teacher"),
  async (req: Request, res: Response) => {
    const parsedId = idParamSchema.safeParse(req.params);
    if (!parsedId.success) {
      return res.status(400).json({ error: "유효하지 않은 ID 형식입니다." });
    }
    const parsedBody = issueBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return res.status(400).json({ error: "링크 기간은 7일에서 180일 사이여야 합니다." });
    }

    try {
      const tenantId = req.user!.tenantId!;
      const row = await storage.getLevelTest(parsedId.data.id, tenantId);
      if (!row) return res.status(404).json({ error: "레벨테스트 기록을 찾을 수 없습니다." });

      /**
       * 채점이 안 끝난 기록은 링크를 만들지 않는다.
       *
       * 미채점이 남은 점수를 학부모가 먼저 보면 그 숫자가 최종 점수로
       * 기억된다. 나중에 올라간 점수를 다시 보내도 "처음엔 낮게 나왔다는데"
       * 가 남는다. 되돌릴 수 없는 종류의 사고라 서버에서 막는다.
       */
      if (row.totalScore == null || (row.pendingCount ?? 0) > 0) {
        return res.status(400).json({
          error: "채점이 끝나지 않은 결과지는 링크를 만들 수 없습니다. 미채점 문항을 먼저 채워 주세요.",
        });
      }

      /**
       * 이미 살아 있는 링크가 있으면 **새로 만들지 않고 그대로 돌려준다.**
       *
       * 원장이 "링크 복사" 를 누를 때마다 새 토큰을 발급하면, 이미 카카오톡으로
       * 보낸 링크가 그 순간 죽는다. 학부모는 눌러도 안 열리는 주소를 받은 채로
       * 남고, 원장은 자기가 끊은 줄 모른다. 가장 조용하고 나쁜 고장이다.
       * 새 토큰이 필요하면 "링크 끊기" 를 먼저 누르게 한다(명시적인 행동).
       */
      if (shareState(row) === "active") {
        return res.json({ share: shareInfo(row), reused: true });
      }

      const expiresAt = shareExpiryFrom(new Date(), parsedBody.data.days ?? SHARE_DEFAULT_DAYS);
      const updated = await storage.issueLevelTestShare(parsedId.data.id, tenantId, {
        token: generateShareToken(),
        expiresAt,
      });
      if (!updated) return res.status(404).json({ error: "레벨테스트 기록을 찾을 수 없습니다." });

      // 토큰은 로그에 남기지 않는다. 로그를 보는 사람 전원이 결과지를 열 수 있게 된다.
      console.log(`레벨테스트 결과지 링크 발급: record=${parsedId.data.id} tenant=${tenantId}`);
      res.json({ share: shareInfo(updated), reused: false });
    } catch (error) {
      console.error("Issue level test share error:", error);
      res.status(500).json({ error: "결과지 링크 발급 중 오류가 발생했습니다." });
    }
  }
);

// ─── 끊기 ────────────────────────────────────────────────────────────────
router.delete(
  "/api/level-tests/:id/share",
  authGuard,
  tenantGuard,
  roleGuard("owner", "teacher"),
  async (req: Request, res: Response) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "유효하지 않은 ID 형식입니다." });
    }
    try {
      const tenantId = req.user!.tenantId!;
      const row = await storage.getLevelTest(parsed.data.id, tenantId);
      if (!row) return res.status(404).json({ error: "레벨테스트 기록을 찾을 수 없습니다." });

      const updated = await storage.revokeLevelTestShare(parsed.data.id, tenantId);
      if (!updated) return res.status(404).json({ error: "레벨테스트 기록을 찾을 수 없습니다." });

      console.log(`레벨테스트 결과지 링크 끊기: record=${parsed.data.id} tenant=${tenantId}`);
      res.json({ share: shareInfo(updated), message: "링크를 닫았습니다." });
    } catch (error) {
      console.error("Revoke level test share error:", error);
      res.status(500).json({ error: "결과지 링크 해제 중 오류가 발생했습니다." });
    }
  }
);

// ─── 검색 로봇 제외 ──────────────────────────────────────────────────────
/**
 * 카카오톡으로 보낸 링크가 검색 결과에 올라가면 안 된다.
 *
 * 페이지 자체에도 noindex 헤더·메타태그를 넣지만, robots.txt 는 로봇이
 * 페이지를 **열기도 전에** 막는 층이다. 둘 다 둔다.
 */
router.get("/robots.txt", (_req: Request, res: Response) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /r/\nDisallow: /level-test/\nDisallow: /api/\n");
});

// ─── 학부모용 결과지 (로그인 없음) ⚠️ ────────────────────────────────────
/**
 * 주소가 `/r/:token` 으로 짧은 이유: 카카오톡·문자에서 줄바꿈 없이 한 줄로
 * 보이고, 학부모가 눌렀을 때 주소가 길어 의심스러워 보이지 않는다.
 *
 * ── 이 핸들러가 하는 일의 전부 ──
 *   1) 토큰 모양 확인 → 2) 횟수 제한 → 3) 토큰으로 한 건 조회 →
 *   4) 만료·해지 확인 → 5) 열어 본 횟수 +1 → 6) 결과지 HTML 응답
 *   조회는 그 한 건뿐이고, 쓰기는 5번뿐이다.
 */
router.get("/r/:token", async (req: Request, res: Response) => {
  // 어떤 경우에도 중간 캐시·브라우저에 남기지 않는다. 가족 공용 PC 에서
  // 뒤로가기로 남의 결과지가 뜨는 일이 없어야 한다.
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  /**
   * CSP: 이 페이지는 서버가 만든 HTML + 인라인 <style> 뿐이다. 스크립트가
   * 아예 없으므로 script-src 를 통째로 막는다. 혹시 미래에 누가 이스케이프를
   * 빠뜨려도 <script> 가 실행되지 않는 마지막 층이 된다.
   */
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"
  );

  try {
    const token = req.params.token;

    // 1) 모양이 다르면 DB 를 보지도 않는다.
    if (!isWellFormedShareToken(token)) {
      return res.status(404).type("html").send(renderShareError("notfound"));
    }

    // 2) 무차별 긁기 완화. 정상적인 가족 사용에는 걸리지 않는 수치다.
    sweepShareRate();
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkShareRate(ip)) {
      return res.status(429).type("html").send(renderShareError("ratelimited"));
    }

    // 3) 토큰이 신원이다. tenantId 를 받지 않는다(받으면 공격자가 고른다).
    const row = await storage.getLevelTestByShareToken(token);
    if (!row) {
      return res.status(404).type("html").send(renderShareError("notfound"));
    }

    // 4) 끝난 링크인가.
    const state = shareState(row);
    if (state === "revoked") {
      return res.status(410).type("html").send(renderShareError("revoked"));
    }
    if (state !== "active") {
      return res.status(410).type("html").send(renderShareError("expired"));
    }

    const tenant = await storage.getTenant(row.tenantId);

    // 5) 열어 본 사실을 적는다. **응답을 막지 않는다** — 이 기록은 편의
    //    기능이고, 이것 때문에 학부모 화면이 늦어지거나 실패하면 안 된다.
    storage.recordLevelTestShareView(row.id).catch((err) => {
      console.error("결과지 열람 기록 실패 (화면은 정상 표시됨):", err);
    });

    // 6) 보여 줄 칸만 골라 넘긴다 (행을 그대로 넘기지 않는다).
    //    연락처·학교·상담id·원본(rawState)은 여기서 끊긴다.
    res
      .status(200)
      .type("html")
      .send(
        renderSharePage({
          row: {
            studentName: row.studentName,
            grade: row.grade,
            testDate: row.testDate,
            examTitle: row.examTitle,
            totalScore: row.totalScore,
            readingScore: row.readingScore,
            grammarScore: row.grammarScore,
            vocabScore: row.vocabScore,
            writingScore: row.writingScore,
            questionCount: row.questionCount,
            correctCount: row.correctCount,
            notes: row.notes,
            teacherName: row.teacherName,
          },
          academyName: tenant?.name ?? "학원",
          academyPhone: tenant?.ownerPhone ?? null,
          expiresAt: row.shareExpiresAt,
        })
      );
  } catch (error) {
    console.error("Public share page error:", error);
    // 학부모에게 스택이나 내부 사정을 보여 주지 않는다.
    res.status(500).type("html").send(renderShareError("notfound"));
  }
});

export default router;
