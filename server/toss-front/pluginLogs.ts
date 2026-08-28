/**
 * Front 플러그인 라이프사이클 로그 수집.
 *
 * 왜 필요한가:
 *   Toss Front 단말기가 검은 화면에서 멈췄을 때, 단말기 자체 로그 서버에는
 *   "연결됨" 류의 네트워크 로그만 남고 플러그인 내부에서 무슨 일이 있었는지는
 *   전혀 보이지 않았다. 단말기에 개발자도구를 붙일 수 없는 현장에서는
 *   console.error 가 사실상 존재하지 않는 것과 같다.
 *
 *   그래서 플러그인이 자기 라이프사이클을 서버로 밀어 올린다. 원장은 브라우저의
 *   Toss Front 관리 화면에서, 개발자는 Railway 로그에서 같은 내용을 본다.
 *
 * 왜 인증을 요구하지 않는가:
 *   진단해야 할 실패의 상당수가 "세션을 못 받는" 실패다. deviceGuard 를 걸면
 *   정작 알고 싶은 구간의 로그가 영영 안 올라온다. 대신 세 겹으로 막는다.
 *     1) 스키마로 건수·길이를 강하게 제한 (한 번에 50건, 각 1000자)
 *     2) IP 단위 분당 120요청 레이트리밋
 *     3) 토큰처럼 보이는 문자열은 저장 전에 마스킹
 *   저장은 메모리 링버퍼뿐이라 DB 를 오염시키지 않고, 재시작하면 비워진다.
 *
 * 읽기(GET)는 원장 인증을 요구한다. 쓰기만 열려 있고 읽기는 닫혀 있다.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { authGuard, tenantGuard, roleGuard } from "../middleware/auth";

const router = Router();

const MAX_BUFFER = 500;

export interface PluginLogEntry {
  /** 서버가 받은 시각 (신뢰 가능한 시계). */
  receivedAt: string;
  /** 단말기가 찍은 시각 (시계가 틀어져 있을 수 있어 참고용). */
  at: string | null;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  deviceId: string | null;
  pluginVersion: string | null;
  ip: string;
}

const buffer: PluginLogEntry[] = [];

function push(entry: PluginLogEntry) {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
}

/** 관리 화면·테스트에서 현재 버퍼를 직접 읽는다. */
export function getPluginLogs(): PluginLogEntry[] {
  return buffer;
}

// ─── 민감정보 마스킹 ────────────────────────────────────────────────────
/**
 * 로그 문자열에서 비밀값처럼 보이는 것을 잘라 낸다.
 *
 * 완벽한 탐지는 불가능하므로 "길고 무작위해 보이는 토큰"과 "key/token/secret
 * 뒤에 붙은 값"을 노린다. 앞 4자만 남기는 이유는, 원장이 "지금 이 단말기에 들어간
 * 키가 내가 발급한 그 키가 맞나"를 눈으로 대조할 수 있어야 하기 때문이다.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g;
const LABELED_SECRET_PATTERN =
  /\b(deviceKey|kioskKey|accessToken|authorization|bearer|secret|password|apiKey)\b\s*[:=]?\s*"?([A-Za-z0-9._-]{6,})"?/gi;

export function redactSecrets(input: string): string {
  return input
    .replace(JWT_PATTERN, "[JWT redacted]")
    .replace(LABELED_SECRET_PATTERN, (_m, label: string, value: string) => {
      return `${label}=${value.slice(0, 4)}…[redacted ${value.length}자]`;
    })
    .replace(LONG_TOKEN_PATTERN, (m) => `${m.slice(0, 4)}…[redacted ${m.length}자]`);
}

// ─── 레이트리밋 ─────────────────────────────────────────────────────────
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const hits = new Map<string, { count: number; windowStart: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now - cur.windowStart > RATE_WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  cur.count += 1;
  return cur.count > RATE_MAX;
}

// 맵이 무한히 커지지 않도록 5분마다 오래된 항목을 버린다.
const sweeper = setInterval(() => {
  const now = Date.now();
  // forEach 로 도는 이유: tsconfig target 이 낮아 Map 직접 순회가 막혀 있다.
  const stale: string[] = [];
  hits.forEach((v, ip) => {
    if (now - v.windowStart > RATE_WINDOW_MS * 5) stale.push(ip);
  });
  for (const ip of stale) hits.delete(ip);
}, 5 * 60_000);
// unref: 이 타이머 하나 때문에 프로세스가 안 죽는 일이 없도록 한다.
// 서버가 살아 있는 동안에는 정상적으로 돌고, 서버가 내려갈 땐 붙잡지 않는다.
sweeper.unref?.();
process.once("SIGTERM", () => clearInterval(sweeper));
process.once("SIGINT", () => clearInterval(sweeper));

// ─── 쓰기 ───────────────────────────────────────────────────────────────
const logBodySchema = z.object({
  deviceId: z.string().max(64).nullish(),
  pluginVersion: z.string().max(32).nullish(),
  entries: z
    .array(
      z.object({
        level: z.enum(["info", "warn", "error"]).default("info"),
        event: z.string().max(120),
        message: z.string().max(1000).default(""),
        at: z.string().max(40).nullish(),
      })
    )
    .max(50),
});

router.post("/plugin-logs", (req: Request, res: Response) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (rateLimited(ip)) {
    return res.status(429).json({ error: "로그 전송이 너무 잦습니다." });
  }

  const parsed = logBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message });
  }

  const { deviceId, pluginVersion, entries } = parsed.data;
  const receivedAt = new Date().toISOString();

  for (const e of entries) {
    const entry: PluginLogEntry = {
      receivedAt,
      at: e.at ?? null,
      level: e.level,
      event: redactSecrets(e.event),
      message: redactSecrets(e.message),
      deviceId: deviceId ? deviceId.slice(0, 8) : null,
      pluginVersion: pluginVersion ?? null,
      ip,
    };
    push(entry);
    // Railway 로그에도 그대로 흘려 보낸다. 원장 화면을 못 여는 상황에서의 최후 수단.
    const line = `[toss-front-plugin] ${entry.level.toUpperCase()} ${entry.event} ${entry.message}`;
    if (entry.level === "error") console.error(line);
    else if (entry.level === "warn") console.warn(line);
    else console.log(line);
  }

  return res.json({ ok: true, accepted: entries.length });
});

// ─── 읽기 (원장 전용) ───────────────────────────────────────────────────
router.get(
  "/plugin-logs",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 200, MAX_BUFFER);
    // 최신이 위로 오게 뒤집어서 준다. 원장은 "방금 뭐가 났나"를 먼저 본다.
    return res.json({ logs: buffer.slice(-limit).reverse(), total: buffer.length });
  }
);

router.delete(
  "/plugin-logs",
  authGuard,
  tenantGuard,
  roleGuard("owner", "superadmin"),
  (_req: Request, res: Response) => {
    buffer.length = 0;
    return res.json({ ok: true });
  }
);

export default router;
