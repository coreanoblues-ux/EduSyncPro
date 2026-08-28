import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { startGradePromotionScheduler } from "./lib/gradePromotion";

const app = express();

// ─── Railway / Reverse-Proxy support ───────────────────────────────────────
// Trust the first proxy hop (Railway's Nginx/Caddy) so that:
//   • req.secure === true when the original request was HTTPS
//   • secure cookies are correctly marked as secure
app.set("trust proxy", 1);

// ─── CORS for Toss Front plugin ────────────────────────────────────────────
// Toss 공식 troubleshooting 문서에 따르면 front plugin 은 실행 시점에
// https://<appName>.plugin.tossplace.com  (운영)
// https://<appName>.plugin-dev.tossplace.com  (테스트)
// origin 을 갖는다. 이 origin 에서 우리 Railway API 로 fetch 할 때 브라우저 CORS 가
// 걸리므로 정확히 이 두 패턴만 허용한다. 태블릿 /student-kiosk 는 우리 도메인에서
// 서빙되므로 same-origin 이라 CORS 미들웨어와 무관.
//
// wildcard(*) 로 열지 않는 이유: 결제 승인 상관관계가 걸린 엔드포인트라 정확한 origin 만
// 허용해 소셜엔지니어링·크로스사이트 오용 여지를 좁힌다.
const TOSS_PLUGIN_ORIGIN = /^https:\/\/[a-z0-9-]+\.plugin(?:-dev)?\.tossplace\.com$/;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (typeof origin === "string" && TOSS_PLUGIN_ORIGIN.test(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }
  }
  next();
});

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
