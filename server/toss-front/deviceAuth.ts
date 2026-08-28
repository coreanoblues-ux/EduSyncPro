/**
 * Toss Front 플러그인 단말기 인증.
 *
 * 왜 원장 로그인을 그대로 쓰지 않았나:
 *   원장 계정은 사람이 로그인·로그아웃하는 흐름이라 만료가 짧고 재로그인이 잦다.
 *   단말기는 학원 문 열려 있는 동안 늘 켜져 있어야 하고, 로그인 화면을 원장이
 *   매번 다시 눌러 주는 건 현실적이지 않다. 그래서 단말기는 별도로 "장치 키"를
 *   한 번 발급받아 두고, 그 키로 짧은 접근 토큰을 자주 갱신하는 방식으로 돈다.
 *
 * 왜 키를 서버에 원문으로 두지 않나:
 *   DB가 유출돼도 그 즉시 장치를 통제하지 못하면 결제 흐름이 열려 있다. 그래서
 *   원문은 발급 순간 응답으로만 돌려주고, 서버에는 SHA-256 해시만 남긴다.
 *   비교는 상수시간 비교로 한다.
 *
 * 접근 토큰의 유효 기간은 15분이라 만약 토큰이 새더라도 창이 짧다. 15분 안에
 * 갱신 요청이 들어오지 않으면 단말기는 다음 요청 때 401을 받고 다시 세션을 튼다.
 */

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { tossFrontDevices } from "@shared/schema";

const SECRET =
  process.env.TOSS_FRONT_DEVICE_SECRET ||
  process.env.JWT_SECRET ||
  crypto.randomBytes(32).toString("hex");

if (!process.env.TOSS_FRONT_DEVICE_SECRET && !process.env.JWT_SECRET) {
  console.warn(
    "⚠️  TOSS_FRONT_DEVICE_SECRET 미설정 — 부팅마다 새 키를 만들어 씁니다. 재시작 시 장치 토큰이 전부 무효화됩니다."
  );
}

const ACCESS_TOKEN_TTL = "15m";

export interface DeviceContext {
  id: string;
  tenantId: string;
  displayName: string;
}

declare global {
  namespace Express {
    interface Request {
      device?: DeviceContext;
    }
  }
}

// ─── 장치 키 생성·해시 ──────────────────────────────────────────────────────
/** 원문 장치 키. base64url로 반환하며 응답 직후 잊는다. */
export function generateDeviceKey(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** 서버가 DB에 저장하는 값. 원문에서 해시만 도출한다. */
export function hashDeviceKey(rawKey: string): string {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

/** DB에 저장된 해시와 요청으로 들어온 원문 키를 상수시간으로 비교한다. */
function compareHashes(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ─── 페어링 코드·PIN (0.3.2~) ──────────────────────────────────────────
/**
 * 발급 시 태블릿 UX 를 위해 짧은 매장코드 + 4자리 PIN 을 만든다.
 * 매장코드에서 O/0, I/1 은 사람 눈으로 구별이 어렵고 태블릿 화면에서 오타를 유발해 제외.
 */
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32자
export function generatePairingCode(): string {
  const bytes = crypto.randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
  }
  return out;
}

/** 4자리 숫자. 앞이 0 이어도 유지되도록 padStart. */
export function generatePairingPin(): string {
  return String(crypto.randomInt(0, 10_000)).padStart(4, "0");
}

export function hashPairingPin(pin: string): string {
  return crypto.createHash("sha256").update(pin).digest("hex");
}

// ─── raw deviceKey 임시 보관용 AES-256-GCM ─────────────────────────────
/**
 * 페어링 발급 시 raw deviceKey 를 짧게(24h) 서버에 보관해야 exchange 시 단말기에 돌려줄 수 있다.
 * 평문 저장은 DB 유출 시 즉시 결제 흐름이 열리므로 대칭 암호로 감싼다.
 * exchange 성공 즉시 이 컬럼을 NULL 로 밀어 서버가 raw 를 완전히 잊게 만든다.
 *
 * 키 자료는 SECRET (env: TOSS_FRONT_DEVICE_SECRET → JWT_SECRET → 부팅 랜덤) 을 SHA-256 으로 확장.
 * SECRET 자체가 부팅마다 랜덤이면 재시작 후 exchange 가 실패한다 (기존 코드도 동일 특성 — 경고 로그 그대로).
 */
function encryptionKey(): Buffer {
  return crypto.createHash("sha256").update(String(SECRET)).digest();
}

export function encryptRawDeviceKey(raw: string): string {
  const iv = crypto.randomBytes(12); // GCM 권장 12바이트
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // 형식: base64url( iv(12) | tag(16) | ciphertext )
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

export function decryptRawDeviceKey(payload: string): string {
  const buf = Buffer.from(payload, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

/**
 * 발급 후 24h 안에 단말기가 exchange 하지 않으면 페어링을 무효로 본다.
 * 학원 영업일 기준으로 하루면 충분하고, 그 이상 놔두면 발급된 코드가 어딘가에 방치될 위험이 커진다.
 */
export const PAIRING_TTL_MS = 24 * 60 * 60 * 1000;

// ─── 접근 토큰 ─────────────────────────────────────────────────────────────
interface DeviceTokenPayload {
  deviceId: string;
  tenantId: string;
  displayName: string;
}

export function issueDeviceAccessToken(payload: DeviceTokenPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

function verifyDeviceAccessToken(token: string): DeviceTokenPayload | null {
  try {
    return jwt.verify(token, SECRET) as DeviceTokenPayload;
  } catch {
    return null;
  }
}

// ─── 장치 키로 접근 토큰 발급 ─────────────────────────────────────────────
/**
 * raw device key로 단말기 하나를 찾아 접근 토큰을 만든다.
 *
 * lastSeenAt은 진짜로 요청이 있었을 때만 찍는다. 이 값을 관리자 화면이 "이
 * 단말기 살아 있나?"의 유일한 지표로 쓰기 때문에, 만료된 요청·인증 실패로
 * 시각을 올려 두면 원장이 잘못된 판단을 내린다.
 */
export async function issueAccessTokenFromDeviceKey(
  rawKey: string
): Promise<{ accessToken: string; device: DeviceContext } | null> {
  const hash = hashDeviceKey(rawKey);
  const rows = await db.select().from(tossFrontDevices).where(eq(tossFrontDevices.deviceKeyHash, hash));
  const device = rows[0];
  if (!device || !device.isActive) return null;

  // 발급 시각을 갱신해 "최근에 세션을 튼 단말기"를 관리자 화면에서 파악한다.
  await db
    .update(tossFrontDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(tossFrontDevices.id, device.id));

  const accessToken = issueDeviceAccessToken({
    deviceId: device.id,
    tenantId: device.tenantId,
    displayName: device.displayName,
  });
  return {
    accessToken,
    device: { id: device.id, tenantId: device.tenantId, displayName: device.displayName },
  };
}

// ─── 미들웨어 ──────────────────────────────────────────────────────────────
/**
 * Front 플러그인 API 앞에 붙인다. Authorization: Bearer <access-token> 필수.
 *
 * 원장 로그인의 authGuard와 완전히 분리했다. 원장 토큰으로 단말기 API를 부를 수
 * 없고, 그 반대도 안 된다. 두 인증 경로가 섞이면 실수로 원장 세션이 결제
 * 승인 권한을 얻는 사고가 난다.
 */
export function deviceGuard(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "장치 인증이 필요합니다." });
  }
  const token = header.slice("Bearer ".length).trim();
  const payload = verifyDeviceAccessToken(token);
  if (!payload) {
    return res.status(401).json({ error: "장치 토큰이 만료되었거나 유효하지 않습니다." });
  }
  req.device = {
    id: payload.deviceId,
    tenantId: payload.tenantId,
    displayName: payload.displayName,
  };
  next();
}

/** 개발·테스트에서 원문 키 없이 직접 요청을 만들 때 쓰는 헬퍼. 운영 흐름에서는 쓰지 않는다. */
export { compareHashes as _compareHashesForTest };
