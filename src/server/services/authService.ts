import crypto from 'node:crypto';
import argon2 from 'argon2';
import { Request, Response, NextFunction } from 'express';
import { DbInstance } from '../db/database.js';
import { AppConfig } from '../config.js';

export const SESSION_COOKIE_NAME = 'sc_admin_session';
export const SHARE_AUTH_COOKIE_PREFIX = 'sc_share_auth_';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456, // ~19 MB — well within Raspberry Pi 4 RAM budget while meeting OWASP Argon2id recommendations
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function generateHighEntropyToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export interface AuthenticatedAdmin {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  sessionId: string;
  csrfToken: string;
}

declare global {
  namespace Express {
    interface Request {
      admin?: AuthenticatedAdmin;
    }
  }
}

export function createSession(
  db: DbInstance,
  userId: string,
  ipAddress?: string,
  userAgent?: string
): { rawToken: string; csrfToken: string; expiresAt: Date } {
  const sessionId = crypto.randomUUID();
  const rawToken = generateHighEntropyToken(32);
  const tokenHash = hashToken(rawToken);
  const csrfToken = generateHighEntropyToken(24);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Prune expired sessions opportunistically
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_token, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    userId,
    tokenHash,
    csrfToken,
    ipAddress || null,
    userAgent || null,
    now.toISOString(),
    expiresAt.toISOString(),
    now.toISOString()
  );

  return { rawToken, csrfToken, expiresAt };
}

export function requireAdminAuth(db: DbInstance, config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
    if (!rawToken || typeof rawToken !== 'string') {
      res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
      return;
    }

    const tokenHash = hashToken(rawToken);
    const nowIso = new Date().toISOString();

    const row = db
      .prepare(
        `SELECT s.id as session_id, s.csrf_token, s.expires_at,
                u.id as user_id, u.username, u.display_name, u.email
         FROM sessions s
         JOIN admin_users u ON u.id = s.user_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash) as
      | {
          session_id: string;
          csrf_token: string;
          expires_at: string;
          user_id: string;
          username: string;
          display_name: string;
          email: string | null;
        }
      | undefined;

    if (!row || row.expires_at < nowIso) {
      if (row) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
      }
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      res.status(401).json({ error: 'Session expired or invalid', code: 'SESSION_EXPIRED' });
      return;
    }

    // Enforce CSRF token on state-changing methods
    const unsafeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (unsafeMethods.includes(req.method.toUpperCase())) {
      const clientCsrf = req.headers['x-csrf-token'];
      if (!clientCsrf || clientCsrf !== row.csrf_token) {
        res.status(403).json({ error: 'Invalid or missing CSRF token', code: 'CSRF_INVALID' });
        return;
      }
    }

    // Update last_active_at
    db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(nowIso, row.session_id);

    req.admin = {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      sessionId: row.session_id,
      csrfToken: row.csrf_token,
    };

    next();
  };
}

/**
 * Creates a signed HMAC token for password-verified public share links so the recipient
 * does not have to re-type the link password on every file download/upload request within a short window.
 */
export function signSharePasswordProof(linkId: string, passwordHash: string, secret: string): string {
  const payload = `${linkId}:${passwordHash.slice(-16)}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${ hmac }`;
}

export function verifySharePasswordProof(
  proof: string | undefined,
  linkId: string,
  passwordHash: string,
  secret: string
): boolean {
  if (!proof) return false;
  const expected = signSharePasswordProof(linkId, passwordHash, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
  } catch {
    return false;
  }
}
