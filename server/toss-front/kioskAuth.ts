/**
 * 학생용 태블릿 웹앱 (StudentKiosk) 인증.
 *
 * Toss Front 하드웨어 인증(deviceAuth.ts)과는 완전히 분리된 경로다.
 * 태블릿과 프론트에 같은 키를 복사하는 실수를 방지하기 위해 별도 시크릿·별도 테이블·
 * 별도 미들웨어로 둔다.
 *
 * 흐름:
 *   1. 원장이 관리자 화면에서 kiosk 발급 → 32바이트 base64url 키 한 번 노출
 *   2. 태블릿 setup 화면에서 그 키를 붙여넣고 localStorage에 저장
 *   3. 태블릿이 매 세션마다 /kiosk/session 호출 → 15분 accessToken
 *   4. 학생 검색·청구서 조회·결제요청 dispatch 시 Bearer 토큰으로 인증
 *
 * 왜 원장 로그인을 태블릿에 두지 않나:
 *   - 태블릿은 학부모·학생이 조작하는 화면이라 원장 세션이 열려 있으면 안 됨
 *   - 원장 계정으로 API를 부르면 삭제·변경 권한까지 노출됨
 *   - 태블릿 전용 인증은 오직 조회·결제요청만 가능해 사고 반경이 좁다
 */

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { kioskDevices } from "@shared/schema";

// 태블릿·프론트에 같은 시크릿을 쓰지 않는다. 하나가 유출되어도 다른 갈래는 유지.
const SECRET =
  process.env.KIOSK_DEVICE_SECRET ||
  process.env.JWT_SECRET ||
  crypto.randomBytes(32).toString("hex");

if (!process.env.KIOSK_DEVICE_SECRET && !process.env.JWT_SECRET) {
  console.warn(
    "⚠️  KIOSK_DEVICE_SECRET 미설정 — 재배포마다 태블릿 재등록이 필요합니다."
  );
}

const ACCESS_TOKEN_TTL = "15m";

export interface KioskContext {
  id: string;
  tenantId: string;
  displayName: string;
  pairedFrontDeviceId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      kiosk?: KioskContext;
    }
  }
}

// ─── 키 생성·해시 ─────────────────────────────────────────────────────────
export function generateKioskKey(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashKioskKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

// ─── 접근 토큰 ─────────────────────────────────────────────────────────────
interface KioskTokenPayload {
  kioskId: string;
  tenantId: string;
  displayName: string;
  pairedFrontDeviceId: string | null;
}

export function issueKioskAccessToken(payload: KioskTokenPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

function verifyKioskAccessToken(token: string): KioskTokenPayload | null {
  try {
    return jwt.verify(token, SECRET) as KioskTokenPayload;
  } catch {
    return null;
  }
}

// ─── 키로 접근 토큰 발급 ──────────────────────────────────────────────────
export async function issueAccessTokenFromKioskKey(
  rawKey: string
): Promise<{ accessToken: string; kiosk: KioskContext } | null> {
  const hash = hashKioskKey(rawKey);
  const rows = await db.select().from(kioskDevices).where(eq(kioskDevices.kioskKeyHash, hash));
  const row = rows[0];
  if (!row || !row.isActive) return null;

  await db
    .update(kioskDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(kioskDevices.id, row.id));

  const ctx: KioskContext = {
    id: row.id,
    tenantId: row.tenantId,
    displayName: row.displayName,
    pairedFrontDeviceId: row.pairedFrontDeviceId ?? null,
  };
  const accessToken = issueKioskAccessToken({
    kioskId: ctx.id,
    tenantId: ctx.tenantId,
    displayName: ctx.displayName,
    pairedFrontDeviceId: ctx.pairedFrontDeviceId,
  });
  return { accessToken, kiosk: ctx };
}

// ─── 미들웨어 ─────────────────────────────────────────────────────────────
/**
 * 태블릿 웹 → 서버 요청 앞에 붙인다. Authorization: Bearer <access-token>.
 *
 * authGuard(원장)·deviceGuard(프론트)와 완전히 분리. 세 경로가 서로의 API를 부를 수 없다.
 */
export function kioskGuard(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "태블릿 인증이 필요합니다." });
  }
  const token = header.slice("Bearer ".length).trim();
  const payload = verifyKioskAccessToken(token);
  if (!payload) {
    return res.status(401).json({ error: "태블릿 토큰이 만료되었거나 유효하지 않습니다." });
  }
  req.kiosk = {
    id: payload.kioskId,
    tenantId: payload.tenantId,
    displayName: payload.displayName,
    pairedFrontDeviceId: payload.pairedFrontDeviceId ?? null,
  };
  next();
}
