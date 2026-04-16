import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";

const app = express();

// ─── Railway / Reverse-Proxy support ───────────────────────────────────────
// Trust the first proxy hop (Railway's Nginx/Caddy) so that:
//   • req.secure === true when the original request was HTTPS
//   • secure cookies are correctly marked as secure
app.set("trust proxy", 1);

app.use(express.json());
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
    console.warn("⚠️  JWT_SECRET not set — using insecure default. Set it in Railway Variables!");
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

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 3000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '3000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });
})();
