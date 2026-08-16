import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { storage } from '../storage';

// ─── JWT Secret ────────────────────────────────────────────────────────────
// 예전에는 문자열 상수를 기본값으로 뒀는데, 이 저장소는 공개라 그 값을 아는
// 사람은 누구나 원장 토큰을 위조할 수 있었다. 그렇다고 없을 때 죽게 만들면
// 변수 하나 빠뜨린 배포가 운영을 통째로 내리므로, 부팅할 때마다 무작위 키를
// 만들어 쓴다. 서버는 살아 있고, 대신 재시작마다 전원 재로그인이라
// 문제가 조용히 묻히지 않는다.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  JWT_SECRET 미설정 — 이번 부팅에만 쓸 임시 키를 만들었습니다. 재시작하면 모두 로그아웃됩니다. 환경변수에 JWT_SECRET을 넣으세요.');
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'teacher' | 'superadmin';
  tenantId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// JWT token generation
export const generateToken = (user: AuthUser): string => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// Password hashing
export const hashPassword = async (password: string): Promise<string> => {
  return await bcrypt.hash(password, 10);
};

// Password verification
export const verifyPassword = async (password: string, hashedPassword: string): Promise<boolean> => {
  return await bcrypt.compare(password, hashedPassword);
};

// JWT verification middleware
export const authGuard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      console.log('🔒 AuthGuard: no token found (cookies:', Object.keys(req.cookies || {}), ')');
      return res.status(401).json({ error: '인증 토큰이 필요합니다.' });
    }

    let decoded: AuthUser;
    try {
      decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    } catch (jwtErr: any) {
      console.warn('🔒 AuthGuard: JWT verify failed:', jwtErr.message);
      return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
    }

    console.log('🔒 AuthGuard: user', { id: decoded.id, role: decoded.role, email: decoded.email });

    // Handle superadmin special case - they don't exist in database
    if (decoded.role === 'superadmin' && decoded.id === 'admin') {
      console.log('🔒 AuthGuard: Superadmin — bypassing DB check');
      req.user = {
        id: decoded.id,
        email: decoded.email,
        name: decoded.name,
        role: decoded.role,
        tenantId: decoded.tenantId,
      };
      return next();
    }

    // Verify user still exists and is active (for regular users)
    const user = await storage.getUser(decoded.id);
    if (!user) {
      console.warn(`🔒 AuthGuard: user ${decoded.id} not found in DB`);
      return res.status(401).json({ error: '사용자를 찾을 수 없습니다.' });
    }
    if (!user.isActive) {
      console.warn(`🔒 AuthGuard: user ${decoded.id} is inactive`);
      return res.status(401).json({ error: '비활성화된 계정입니다.' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
    };

    next();
  } catch (error) {
    console.error('🔒 AuthGuard unexpected error:', error);
    return res.status(500).json({ error: '인증 처리 중 오류가 발생했습니다.' });
  }
};

// Tenant access guard - ensures user can only access their tenant's data
export const tenantGuard = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({ error: '인증이 필요합니다.' });
  }

  // Superadmin can access all tenants
  if (req.user.role === 'superadmin') {
    return next();
  }

  // Check if user has a tenant
  if (!req.user.tenantId) {
    return res.status(403).json({ error: '테넌트가 할당되지 않은 사용자입니다.' });
  }

  // TODO: Check if tenant is active
  next();
};

// Role-based access control
export const roleGuard = (...allowedRoles: ('owner' | 'teacher' | 'superadmin')[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: '인증이 필요합니다.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: '권한이 부족합니다.' });
    }

    next();
  };
};