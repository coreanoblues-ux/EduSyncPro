import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { storage } from '../storage';

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-for-academy';

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
    const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');

    console.log('🔒 AuthGuard: token exists:', !!token);
    console.log('🔒 AuthGuard: token length:', token?.length || 0);

    if (!token) {
      return res.status(401).json({ error: '인증 토큰이 필요합니다.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    console.log('🔒 AuthGuard: decoded user:', { id: decoded.id, role: decoded.role, email: decoded.email });
    
    // Handle superadmin special case - they don't exist in database
    if (decoded.role === 'superadmin' && decoded.id === 'admin') {
      console.log('🔒 AuthGuard: Superadmin detected - allowing access');
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
    if (!user || !user.isActive) {
      return res.status(401).json({ error: '유효하지 않은 사용자입니다.' });
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
    console.error('🔒 AuthGuard error:', error);
    return res.status(401).json({ error: '유효하지 않은 토큰입니다.' });
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