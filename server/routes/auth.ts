import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { db, writeAuditLog } from '../db/database.ts';
import {
  checkLoginThrottle,
  clearLoginFailures,
  rateLimitMiddleware,
  recordLoginFailure,
  requireAuth,
  signAuthToken,
  type AuthenticatedRequest,
} from '../middleware/auth.ts';
import { validateEmail, validatePasswordStrength } from '../utils/validation.ts';

export const authRouter = Router();

let cachedFirebaseCerts: { certs: Record<string, string>; expiresAt: number } | null = null;

function getFirebaseProjectId(): string | null {
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { projectId?: string };
      if (cfg.projectId) return cfg.projectId;
    }
  } catch {
    // Fallback to env var if config file is unavailable
  }
  return process.env.FIREBASE_PROJECT_ID || null;
}

async function fetchGoogleFirebaseCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedFirebaseCerts && cachedFirebaseCerts.expiresAt > now) {
    return cachedFirebaseCerts.certs;
  }
  const resp = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
  );
  if (!resp.ok) {
    throw new Error('Unable to fetch Google token verification certificates.');
  }
  const certs = (await resp.json()) as Record<string, string>;
  const cacheControl = resp.headers.get('cache-control') || '';
  const match = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSec = match ? Number.parseInt(match[1], 10) : 3600;
  cachedFirebaseCerts = { certs, expiresAt: now + maxAgeSec * 1000 };
  return certs;
}

async function verifyFirebaseIdToken(idToken: string): Promise<{
  uid: string;
  email: string;
  name: string;
  email_verified: boolean;
}> {
  const projectId = getFirebaseProjectId();
  if (!projectId) {
    throw new Error('Firebase project ID is not configured.');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase ID token.');
  }

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Firebase token signing algorithm.');
  }

  const certs = await fetchGoogleFirebaseCerts();
  let pem = certs[header.kid];
  if (!pem) {
    cachedFirebaseCerts = null;
    const freshCerts = await fetchGoogleFirebaseCerts();
    pem = freshCerts[header.kid];
  }
  if (!pem) {
    throw new Error('Unknown Firebase token signing key.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const signature = Buffer.from(parts[2], 'base64url');
  if (!verifier.verify(pem, signature)) {
    throw new Error('Invalid Firebase ID token signature.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Firebase ID token audience or issuer mismatch.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('Firebase ID token has expired.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw new Error('Firebase ID token issued-at timestamp is invalid.');
  }
  if (!payload.sub || !payload.email || payload.email_verified !== true) {
    throw new Error('Verified Google email is required to sign in.');
  }

  return {
    uid: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: (payload.name || payload.email.split('@')[0] || 'HospitEase User').trim().slice(0, 80),
    email_verified: true,
  };
}

authRouter.post('/register', rateLimitMiddleware(20, 60_000), (req, res) => {
  const { name, email, password } = req.body ?? {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (cleanName.length < 2 || cleanName.length > 80) {
    res.status(400).json({
      code: 'INVALID_NAME',
      message: 'Please enter your name (between 2 and 80 characters).',
      details: 'name must be 2-80 characters.',
    });
    return;
  }

  if (!validateEmail(cleanEmail)) {
    res.status(400).json({
      code: 'INVALID_EMAIL',
      message: 'Please enter a valid email address.',
      details: 'Email format is invalid.',
    });
    return;
  }

  const pwdCheck = validatePasswordStrength(password);
  if (!pwdCheck.valid) {
    res.status(400).json({
      code: 'WEAK_PASSWORD',
      message: pwdCheck.message || 'Password does not meet security requirements.',
      details: 'Minimum 8 characters with letters and digits required.',
    });
    return;
  }

  const existing = db.prepare('SELECT user_id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) {
    res.status(409).json({
      code: 'EMAIL_EXISTS',
      message: 'An account with this email already exists. Please sign in instead.',
      details: 'Email must be unique.',
    });
    return;
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "INSERT INTO users (name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, 'user', 'active', ?)",
    )
    .run(cleanName, cleanEmail, passwordHash, now);

  const userId = Number(result.lastInsertRowid);
  const token = signAuthToken({ user_id: userId, email: cleanEmail, name: cleanName, role: 'user' });

  res.status(201).json({
    token,
    user: {
      user_id: userId,
      name: cleanName,
      email: cleanEmail,
      role: 'user',
      status: 'active',
    },
  });
});

authRouter.post('/login', (req, res) => {
  const { email, password } = req.body ?? {};
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const throttleKey = `${req.ip || 'local'}:${cleanEmail}`;

  const throttle = checkLoginThrottle(throttleKey);
  if (!throttle.allowed) {
    res.status(429).json({
      code: 'LOGIN_THROTTLED',
      message: `Too many failed sign-in attempts. Please try again in ${Math.ceil((throttle.retryAfterSec || 60) / 60)} minutes.`,
      details: 'Exceeded 5 failed login attempts in 15 minutes.',
    });
    return;
  }

  if (!cleanEmail || typeof password !== 'string') {
    res.status(400).json({
      code: 'MISSING_CREDENTIALS',
      message: 'Please enter both your email and password.',
      details: 'email and password are required.',
    });
    return;
  }

  const user = db
    .prepare('SELECT user_id, name, email, password_hash, role, status FROM users WHERE email = ?')
    .get(cleanEmail) as
    | {
        user_id: number;
        name: string;
        email: string;
        password_hash: string;
        role: 'user' | 'admin';
        status: string;
      }
    | undefined;

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordLoginFailure(throttleKey);
    // REQ-ACC-04: Do not reveal which field was wrong
    res.status(401).json({
      code: 'INVALID_CREDENTIALS',
      message: 'Email or password is incorrect.',
      details: 'Authentication failed.',
    });
    return;
  }

  if (user.status === 'suspended') {
    res.status(403).json({
      code: 'ACCOUNT_SUSPENDED',
      message: 'This account has been suspended by an administrator.',
      details: 'Account status is suspended.',
    });
    return;
  }

  clearLoginFailures(throttleKey);
  const token = signAuthToken({
    user_id: user.user_id,
    email: user.email,
    name: user.name,
    role: user.role,
  });

  res.json({
    token,
    user: {
      user_id: user.user_id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
    },
  });
});

authRouter.post('/firebase', rateLimitMiddleware(30, 60_000), async (req, res) => {
  const { idToken } = req.body ?? {};
  if (typeof idToken !== 'string' || idToken.trim().length < 20) {
    res.status(400).json({
      code: 'MISSING_FIREBASE_TOKEN',
      message: 'A valid Firebase ID token is required.',
      details: null,
    });
    return;
  }

  try {
    const claims = await verifyFirebaseIdToken(idToken.trim());
    const existing = db
      .prepare('SELECT user_id, name, email, role, status FROM users WHERE email = ?')
      .get(claims.email) as
      | {
          user_id: number;
          name: string;
          email: string;
          role: 'user' | 'admin';
          status: string;
        }
      | undefined;

    if (existing?.status === 'suspended') {
      res.status(403).json({
        code: 'ACCOUNT_SUSPENDED',
        message: 'This account has been suspended by an administrator.',
        details: null,
      });
      return;
    }

    const isBootstrapAdmin = claims.email === 'en23cs301177@medicaps.ac.in';
    let userRow: { user_id: number; name: string; email: string; role: 'user' | 'admin'; status: string };

    if (!existing) {
      const randomPassHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);
      const role: 'user' | 'admin' = isBootstrapAdmin ? 'admin' : 'user';
      const now = new Date().toISOString();
      const insert = db
        .prepare(
          'INSERT INTO users (name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(claims.name, claims.email, randomPassHash, role, 'active', now);
      userRow = {
        user_id: Number(insert.lastInsertRowid),
        name: claims.name,
        email: claims.email,
        role,
        status: 'active',
      };
    } else {
      const nextRole: 'user' | 'admin' = isBootstrapAdmin ? 'admin' : existing.role;
      if (nextRole !== existing.role) {
        db.prepare('UPDATE users SET role = ? WHERE user_id = ?').run(nextRole, existing.user_id);
      }
      userRow = { ...existing, role: nextRole };
    }

    const token = signAuthToken({
      user_id: userRow.user_id,
      email: userRow.email,
      name: userRow.name,
      role: userRow.role,
    });

    res.json({ token, user: userRow });
  } catch (err) {
    res.status(401).json({
      code: 'INVALID_FIREBASE_TOKEN',
      message: err instanceof Error ? err.message : 'Could not verify Google Sign-In session.',
      details: null,
    });
  }
});

authRouter.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
  res.json({ user: req.user });
});

authRouter.patch('/profile', requireAuth, (req: AuthenticatedRequest, res) => {
  const { name } = req.body ?? {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (cleanName.length < 2 || cleanName.length > 80) {
    res.status(400).json({
      code: 'INVALID_NAME',
      message: 'Name must be between 2 and 80 characters.',
      details: null,
    });
    return;
  }
  db.prepare('UPDATE users SET name = ? WHERE user_id = ?').run(cleanName, req.user!.user_id);
  const updated = { ...req.user!, name: cleanName };
  const token = signAuthToken(updated);
  res.json({ token, user: updated });
});

authRouter.patch('/password', requireAuth, (req: AuthenticatedRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({
      code: 'MISSING_FIELDS',
      message: 'Please enter both your current password and a new password.',
      details: null,
    });
    return;
  }

  const row = db
    .prepare('SELECT password_hash FROM users WHERE user_id = ?')
    .get(req.user!.user_id) as { password_hash: string } | undefined;

  if (!row || !bcrypt.compareSync(currentPassword, row.password_hash)) {
    res.status(401).json({
      code: 'WRONG_PASSWORD',
      message: 'Your current password is incorrect.',
      details: null,
    });
    return;
  }

  const check = validatePasswordStrength(newPassword);
  if (!check.valid) {
    res.status(400).json({
      code: 'WEAK_PASSWORD',
      message: check.message || 'New password is too weak.',
      details: null,
    });
    return;
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?').run(newHash, req.user!.user_id);
  res.json({ message: 'Your password has been updated.' });
});

// REQ-ACC-09: Account deletion retains past updates only in anonymised form
authRouter.delete('/account', requireAuth, (req: AuthenticatedRequest, res) => {
  const userId = req.user!.user_id;
  if (req.user!.role === 'admin') {
    res.status(403).json({
      code: 'ADMIN_DELETE_BLOCKED',
      message: 'Administrator accounts cannot be self-deleted.',
      details: null,
    });
    return;
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE crowd_updates SET user_id = NULL WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
    writeAuditLog(null, 'USER_SELF_DELETE', `user:${userId}`, 'User deleted account; past updates anonymised.');
  });
  tx();

  res.json({ message: 'Your account has been deleted and past contributions have been anonymised.' });
});
