import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../db/database.ts';
import { SRS_DEFAULTS, type UserRole } from '../types.ts';

const JWT_SECRET = process.env.JWT_SECRET || 'hospitease-dev-secret-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '60m';

export interface AuthUserPayload {
  user_id: number;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUserPayload;
}

export function signAuthToken(payload: AuthUserPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAuthToken(token: string): AuthUserPayload {
  return jwt.verify(token, JWT_SECRET) as AuthUserPayload;
}

export function optionalAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    try {
      const decoded = verifyAuthToken(token);
      const userRow = db
        .prepare('SELECT user_id, name, email, role, status FROM users WHERE user_id = ?')
        .get(decoded.user_id) as
        | { user_id: number; name: string; email: string; role: 'user' | 'admin'; status: string }
        | undefined;
      if (userRow && userRow.status === 'active') {
        req.user = {
          user_id: userRow.user_id,
          name: userRow.name,
          email: userRow.email,
          role: userRow.role,
        };
      }
    } catch {
      // Treat invalid/expired token on optional endpoints as guest
    }
  }
  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({
      code: 'UNAUTHENTICATED',
      message: 'Please sign in to perform this action.',
      details: 'Missing Authorization Bearer token.',
    });
    return;
  }

  const token = header.slice(7).trim();
  try {
    const decoded = verifyAuthToken(token);
    const userRow = db
      .prepare('SELECT user_id, name, email, role, status FROM users WHERE user_id = ?')
      .get(decoded.user_id) as
      | { user_id: number; name: string; email: string; role: 'user' | 'admin'; status: string }
      | undefined;

    if (!userRow) {
      res.status(401).json({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Your session is no longer valid. Please sign in again.',
        details: 'User account not found.',
      });
      return;
    }

    if (userRow.status === 'suspended') {
      res.status(403).json({
        code: 'ACCOUNT_SUSPENDED',
        message: 'Your account has been suspended by an administrator.',
        details: 'Suspended accounts cannot sign in or submit updates.',
      });
      return;
    }

    req.user = {
      user_id: userRow.user_id,
      name: userRow.name,
      email: userRow.email,
      role: userRow.role,
    };
    next();
  } catch {
    res.status(401).json({
      code: 'TOKEN_EXPIRED',
      message: 'Your session has expired. Please sign in again.',
      details: 'Invalid or expired JWT token.',
    });
  }
}

export function requireRole(allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        code: 'UNAUTHENTICATED',
        message: 'Authentication is required.',
        details: null,
      });
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: 'You do not have permission to access this resource.',
        details: `Required role: ${allowedRoles.join(' or ')}.`,
      });
      return;
    }
    next();
  };
}

// NFR-SEC-05: Login throttling (5 failed attempts in 15 min) + API rate limiting
const loginFailures = new Map<string, number[]>();

export function checkLoginThrottle(key: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const windowStart = now - SRS_DEFAULTS.LOGIN_THROTTLE_WINDOW_MS;
  const recent = (loginFailures.get(key) || []).filter((ts) => ts > windowStart);
  loginFailures.set(key, recent);
  if (recent.length >= SRS_DEFAULTS.LOGIN_THROTTLE_MAX) {
    const retryAfterSec = Math.ceil((recent[0] + SRS_DEFAULTS.LOGIN_THROTTLE_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true };
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const windowStart = now - SRS_DEFAULTS.LOGIN_THROTTLE_WINDOW_MS;
  const recent = (loginFailures.get(key) || []).filter((ts) => ts > windowStart);
  recent.push(now);
  loginFailures.set(key, recent);
}

export function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

const apiBuckets = new Map<string, number[]>();

export function rateLimitMiddleware(maxRequests: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${req.ip || 'local'}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const recent = (apiBuckets.get(key) || []).filter((ts) => ts > now - windowMs);
    if (recent.length >= maxRequests) {
      res.status(429).json({
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please wait a moment and try again.',
        details: `Limit is ${maxRequests} requests per ${Math.round(windowMs / 1000)} seconds.`,
      });
      return;
    }
    recent.push(now);
    apiBuckets.set(key, recent);
    next();
  };
}
