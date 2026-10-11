/**
 * 레벨테스트 결과지 API + 앱 전달.
 *
 * 지금까지 레벨테스트 앱은 결과를 "누적 엑셀 파일 한 개"에 쌓았다. 그 방식의
 * 문제는 파일이 한 대의 PC 에만 있다는 것이다 — 다른 선생님 컴퓨터에서 열면
 * 그동안의 기록이 없고, 파일을 덮어쓰면 과거가 사라지고, 백업은 사람 손에
 * 달려 있다. 그래서 저장 위치를 EduSyncPro 서버 DB 로 옮긴다.
 *
 * ── 이 라우터가 하는 일 ──
 *   GET    /api/level-tests        목록 (결과지 원본 raw_state 제외)
 *   GET    /api/level-tests/:id    한 건 (재출력용, raw_state 포함)
 *   POST   /api/level-tests        저장. 같은 회차면 덮어쓴다(upsert)
 *   DELETE /api/level-tests/:id    삭제 (원장만)
 *   GET    /level-test/app         레벨테스트 앱 HTML (로그인 필수)
 *
 * ── 왜 앱을 새 탭으로 여는가 (iframe 이 아니라) ──
 *   이 앱의 결과지는 A4 인쇄를 mm 단위로 맞춰 둔 CSS 다 (186mm × 270mm).
 *   iframe 안에 넣으면 인쇄 시 부모 문서 기준으로 잘려서, 원장이 학부모에게
 *   주는 결과지의 여백이 틀어진다. 인쇄 품질이 이 기능의 핵심이라 건드리지
 *   않는다. React 화면은 목록·조회만 담당하고, 채점·인쇄는 원래 앱이 그대로 한다.
 *
 * ── 왜 정적 폴더에 두지 않는가 ──
 *   HTML 안에 12개월치 문제와 정답이 들어 있다. dist/public 에 두면 로그인
 *   없이 내려받힌다. scripts/copy-level-test-app.mjs 주석 참조.
 */

import { Router, Request, Response } from "express";
import { existsSync } from "fs";
import path from "path";
import { z } from "zod";
import { storage } from "../storage";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";
import { saveLevelTestBodySchema } from "@shared/schema";

const router = Router();

/**
 * 앱 HTML 의 실제 경로를 찾는다.
 *
 * 배포 형태마다 파일이 있는 곳이 다르다:
 *   · Railway(NIXPACKS): 소스 트리가 그대로 남아 apps/ 와 dist/ 둘 다 있다
 *   · docker/Dockerfile 런타임: dist/ 만 복사된다
 *   · 로컬 개발(npm run dev): 빌드를 안 했으면 apps/ 만 있다
 * 세 경우를 모두 통과시키려고 후보를 순서대로 확인한다. "내 PC 에서는 됐는데
 * 배포하면 404" 를 구조적으로 막기 위한 장치다.
 *
 * export 해 둔 이유: scripts/test-level-test.ts 가 "빌드 후에 앱 파일이 실제로
 * 찾아지는지" 를 확인한다. 라우터 안에서만 쓰는 함수지만, 못 찾으면 레벨테스트
 * 화면 전체가 죽는 자리라 테스트에서 직접 보게 한다.
 */
export function resolveAppHtml(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "dist", "level-test", "index.html"),
    path.resolve(process.cwd(), "apps", "level-test", "index.html"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ─── 앱 HTML 전달 ───────────────────────────────────────────────────────
router.get(
  "/level-test/app",
  authGuard,
  tenantGuard,
  roleGuard("owner", "teacher"),
  (_req: Request, res: Response) => {
    const file = resolveAppHtml();
    if (!file) {
      console.error("레벨테스트 앱 HTML 을 찾을 수 없습니다. npm run build 가 실행됐는지 확인하세요.");
      return res
        .status(500)
        .type("html")
        .send(
          "<meta charset='utf-8'><h1>레벨테스트 앱 파일을 찾을 수 없습니다</h1>" +
            "<p>배포 산출물에 앱이 포함되지 않았습니다. 관리자에게 알려 주세요.</p>"
        );
    }
    // 문제·정답이 담긴 파일이다. 중간 캐시(프록시)에 남지 않게 한다.
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(file);
  }
);

// ─── 목록 ───────────────────────────────────────────────────────────────
router.get(
  "/api/level-tests",
  authGuard,
  tenantGuard,
  roleGuard("owner", "teacher"),
  async (req: Request, res: Response) => {
    try {
      const rows = await storage.getLevelTestsByTenant(req.user!.tenantId!);
      res.json(rows);
    } catch (error) {
      console.error("Get level tests error:", error);
      res.status(500).json({ error: "레벨테스트 목록 조회 중 오류가 발생했습니다." });
    }
  }
);

const idParamSchema = z.object({ id: z.string().uuid("유효하지 않은 ID 형식입니다.") });

// ─── 한 건 조회 (결과지 재출력용) ───────────────────────────────────────
router.get(
  "/api/level-tests/:id",
  authGuard,
  tenantGuard,
  roleGuard("owner", "teacher"),
  async (req: Request, res: Response) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "유효하지 않은 ID 형식입니다." });
    }
    try {
      // tenantId 를 같이 넘긴다 — storage 가 WHERE 에 넣어 남의 학원 기록을 막는다.
      const row = await storage.getLevelTest(parsed.data.id, req.user!.tenantId!);
      if (!row) return res.status(404).json({ error: "레벨테스트 기록을 찾을 수 없습니다." });
      res.json(row);
    } catch (error) {
      console.error("Get level test error:", error);
      res.status(500).json({ error: "레벨테스트 조회 중 오류가 발생했습니다." });
    }
  }
);

// ─── 저장 (같은 회차면 덮어쓰기) ────────────────────────────────────────
router.post(
  "/api/level-tests",
  authGuard,
  tenantGuard,
  roleGuard("owner", "teacher"),
  async (req: Request, res: Response) => {
    const parsed = saveLevelTestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      // 앱 화면에 그대로 띄울 수 있게 첫 번째 메시지를 꺼내 준다.
      const first = parsed.error.errors[0];
      console.error("🚨 레벨테스트 저장 검증 실패:", JSON.stringify(parsed.error.errors));
      return res.status(400).json({
        error: first?.message ?? "입력 데이터가 올바르지 않습니다.",
        details: parsed.error.errors,
      });
    }
    try {
      // tenantId / createdBy 는 토큰에서만 온다. 본문 값은 무시한다.
      const saved = await storage.upsertLevelTest({
        ...parsed.data,
        tenantId: req.user!.tenantId!,
        createdBy: req.user!.id,
      });
      res.status(200).json(saved);
    } catch (error) {
      console.error("Save level test error:", error);
      res.status(500).json({ error: "레벨테스트 저장 중 오류가 발생했습니다." });
    }
  }
);

// ─── 삭제 ───────────────────────────────────────────────────────────────
// 성적 기록을 지우는 일이라 원장만 가능하게 둔다.
router.delete(
  "/api/level-tests/:id",
  authGuard,
  tenantGuard,
  roleGuard("owner"),
  async (req: Request, res: Response) => {
    const parsed = idParamSchema.safeParse(req.params);
    if (!parsed.success) {
      return res.status(400).json({ error: "유효하지 않은 ID 형식입니다." });
    }
    try {
      const existing = await storage.getLevelTest(parsed.data.id, req.user!.tenantId!);
      if (!existing) return res.status(404).json({ error: "레벨테스트 기록을 찾을 수 없습니다." });
      await storage.deleteLevelTest(parsed.data.id, req.user!.tenantId!);
      res.json({ message: "레벨테스트 기록이 삭제되었습니다." });
    } catch (error) {
      console.error("Delete level test error:", error);
      res.status(500).json({ error: "레벨테스트 삭제 중 오류가 발생했습니다." });
    }
  }
);

export default router;
