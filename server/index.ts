import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";

// ⚠️ 순서 주의: 라우트 모듈들은 import 되는 순간 router.post(...) 를 실행한다.
// 이 import 는 그보다 위에 있어야 async 오류 보호가 적용된다. 아래 ./routes 와
// 순서를 바꾸면 보호가 조용히 무력화되고, 라우트 하나의 예외가 서버 전체를 죽인다.
import "./lib/asyncErrors";
import { pluginCors } from "./lib/pluginCors";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { startGradePromotionScheduler } from "./lib/gradePromotion";

// ─── 최후의 방어선 ─────────────────────────────────────────────────────────
// lib/asyncErrors 가 라우트 핸들러를 감싸지만, 전역 미들웨어·타이머·백그라운드
// 작업에서 난 예외까지 잡지는 못한다. 그런 것 하나 때문에 학원 전체가 멈추면 안 된다.
//
// 판단: 이 서버는 학원 한 곳이 수업 중에 쓰는 업무 프로그램이다. "상태가 이상해졌을
// 수 있으니 안전하게 종료한다"는 교과서적 처리는 여기서는 오히려 손해다. 결제·출결·
// 조회가 통째로 멈추는 비용이, 요청 하나가 이상하게 끝날 위험보다 훨씬 크다.
// 그래서 크게 로그를 남기고 살아남는 쪽을 택한다. 로그는 Railway 에서 확인한다.
process.on("unhandledRejection", (reason: any) => {
  console.error("❌ 처리되지 않은 Promise 거부 (프로세스는 계속 실행됩니다):", reason);
});
process.on("uncaughtException", (err: any) => {
  console.error("❌ 잡히지 않은 예외 (프로세스는 계속 실행됩니다):", err);
});

const app = express();

// ─── Railway / Reverse-Proxy support ───────────────────────────────────────
// Trust the first proxy hop (Railway's Nginx/Caddy) so that:
//   • req.secure === true when the original request was HTTPS
//   • secure cookies are correctly marked as secure
app.set("trust proxy", 1);

// ─── CORS for Toss Front plugin ────────────────────────────────────────────
// 단말기 경로(/api/toss-front/*, /admin 제외)는 origin 을 가리지 않고 허용하고,
// 그 밖에는 https://<appName>.plugin(-dev).tossplace.com 만 허용한다.
// 태블릿 /student-kiosk 는 우리 도메인에서 서빙되므로 same-origin 이라 무관.
//
// 규칙과 "왜 * 가 여기서는 안전한가"는 lib/pluginCors.ts 에 적어 뒀다.
// 테스트: npm run test:cors
app.use(pluginCors);

// Toss 웹훅은 HMAC 서명 검증을 위해 원문 body가 필요하다. JSON.stringify로 재직렬화하면
// Toss가 만든 원문과 공백·키 순서가 달라져 서명이 안 맞는다. 그래서 verify 콜백에서
// 웹훅 경로에 한해서만 rawBody를 request에 붙여 둔다. 다른 경로는 영향 없다.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      if ((req as any).url?.startsWith("/api/toss-front/webhooks")) {
        (req as any).rawBody = buf.toString("utf8");
      }
    },
  })
);
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const server = await registerRoutes(app);

  // ─── Global error handler ───────────────────────────────────────────────
  // NOTE: Do NOT re-throw here — that would crash the Node process after the
  // response has already been sent, causing Railway to restart the container.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error(`❌ Unhandled error [${status}]:`, err);
    if (!res.headersSent) {
      res.status(status).json({ message });
    }
  });

  // 등록되지 않은 /api 경로는 여기서 JSON 404로 끊는다.
  // 아래 SPA 폴백(app.use("*"))은 메서드를 가리지 않아 POST까지 index.html을 200으로
  // 돌려주고, 클라이언트에서는 "Unexpected token '<'"라는 엉뚱한 오류로 보인다.
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "존재하지 않는 API 경로입니다." });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ─── Startup environment check (warnings only, never crash) ─────────────
  if (!process.env.JWT_SECRET) {
    console.warn("⚠️  JWT_SECRET 미설정 — 부팅할 때마다 임시 키가 바뀌어 재시작하면 전원 로그아웃됩니다.");
  }
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("⚠️  ADMIN_PASSWORD not set — admin login will be disabled.");
  }
  if (!process.env.DATABASE_URL) {
    console.warn("⚠️  DATABASE_URL not set — database operations will fail.");
  }
  console.log(`🚀 NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  console.log(`🔑 JWT_SECRET set: ${!!process.env.JWT_SECRET}`);
  console.log(`🔑 ADMIN_PASSWORD set: ${!!process.env.ADMIN_PASSWORD}`);
  console.log(`🗄️  DATABASE_URL set: ${!!process.env.DATABASE_URL}`);
  console.log(`🤖 OPENAI_API_KEY set: ${!!process.env.OPENAI_API_KEY}`);

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 3000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '3000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
  }, () => {
    log(`serving on port ${port}`);
    // 3월이 지났으면 학년을 올린다. 서버가 뜬 뒤에 걸어야 DB가 느릴 때도
    // 응답 대기가 포트 열림을 막지 않는다.
    startGradePromotionScheduler();
  });
})();
