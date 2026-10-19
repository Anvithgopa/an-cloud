import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { DbInstance, logAuditEvent } from '../db/database.js';
import { AppConfig } from '../config.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  requireAdminAuth,
  SESSION_COOKIE_NAME,
} from '../services/authService.js';

const setupSchema = z.object({
  username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/),
  displayName: z.string().min(1).max(80),
  email: z.string().email().optional().or(z.literal('')),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(80),
  email: z.string().email().optional().or(z.literal('')),
});

export function createAuthRouter(db: DbInstance, config: AppConfig): Router {
  const router = Router();

  const authRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.nodeEnv === 'test' ? 200 : 15,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Please try again later.', code: 'RATE_LIMITED' },
  });

  // Check setup & current session status
  router.get('/status', (req: Request, res: Response) => {
    const adminCount = (db.prepare('SELECT COUNT(*) as count FROM admin_users').get() as { count: number }).count;
    const needsSetup = adminCount === 0;

    if (needsSetup) {
      res.json({ needsSetup: true, authenticated: false, user: null });
      return;
    }

    const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
    if (!rawToken) {
      res.json({ needsSetup: false, authenticated: false, user: null });
      return;
    }

    const tokenHash = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
    const nowIso = new Date().toISOString();

    const row = db
      .prepare(
        `SELECT s.id as session_id, s.csrf_token, s.expires_at,
                u.id as user_id, u.username, u.display_name, u.email, u.last_login_at
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
          last_login_at: string | null;
        }
      | undefined;

    if (!row || row.expires_at < nowIso) {
      res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      res.json({ needsSetup: false, authenticated: false, user: null });
      return;
    }

    res.json({
      needsSetup: false,
      authenticated: true,
      csrfToken: row.csrf_token,
      user: {
        id: row.user_id,
        username: row.username,
        displayName: row.display_name,
        email: row.email,
        lastLoginAt: row.last_login_at,
      },
    });
  });

  // First-run Administrator Setup (only works when 0 admins exist)
  router.post('/setup', authRateLimiter, async (req: Request, res: Response) => {
    try {
      const adminCount = (db.prepare('SELECT COUNT(*) as count FROM admin_users').get() as { count: number }).count;
      if (adminCount > 0) {
        res.status(403).json({
          error: 'Administrator account has already been configured. Public registration is disabled.',
          code: 'SETUP_ALREADY_COMPLETED',
        });
        return;
      }

      const parsed = setupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid setup parameters', details: parsed.error.flatten(), code: 'VALIDATION_ERROR' });
        return;
      }

      const { username, displayName, email, password } = parsed.data;
      const passwordHash = await hashPassword(password);
      const userId = crypto.randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO admin_users (id, username, display_name, email, password_hash, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(userId, username.toLowerCase(), displayName, email || null, passwordHash, now, now, now);

      const session = createSession(db, userId, req.ip, req.headers['user-agent']);

      logAuditEvent(db, {
        eventType: 'ADMIN_INITIAL_SETUP',
        actor: username.toLowerCase(),
        targetType: 'admin_user',
        targetId: userId,
        ipAddress: req.ip,
      });

      res.cookie(SESSION_COOKIE_NAME, session.rawToken, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'lax',
        expires: session.expiresAt,
        path: '/',
      });

      res.status(201).json({
        authenticated: true,
        csrfToken: session.csrfToken,
        user: {
          id: userId,
          username: username.toLowerCase(),
          displayName,
          email: email || null,
          lastLoginAt: now,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to complete initial setup', code: 'INTERNAL_ERROR' });
    }
  });

  // Administrator Login
  router.post('/login', authRateLimiter, async (req: Request, res: Response) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Username and password are required', code: 'VALIDATION_ERROR' });
        return;
      }

      const { username, password } = parsed.data;
      const user = db
        .prepare('SELECT * FROM admin_users WHERE username = ?')
        .get(username.toLowerCase()) as
        | {
            id: string;
            username: string;
            display_name: string;
            email: string | null;
            password_hash: string;
          }
        | undefined;

      if (!user) {
        logAuditEvent(db, {
          eventType: 'ADMIN_LOGIN_FAILED',
          actor: username.toLowerCase(),
          ipAddress: req.ip,
          details: { reason: 'User not found' },
        });
        res.status(401).json({ error: 'Invalid username or password', code: 'INVALID_CREDENTIALS' });
        return;
      }

      const valid = await verifyPassword(user.password_hash, password);
      if (!valid) {
        logAuditEvent(db, {
          eventType: 'ADMIN_LOGIN_FAILED',
          actor: user.username,
          targetType: 'admin_user',
          targetId: user.id,
          ipAddress: req.ip,
          details: { reason: 'Invalid password' },
        });
        res.status(401).json({ error: 'Invalid username or password', code: 'INVALID_CREDENTIALS' });
        return;
      }

      const now = new Date().toISOString();
      db.prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?').run(now, user.id);

      const session = createSession(db, user.id, req.ip, req.headers['user-agent']);

      logAuditEvent(db, {
        eventType: 'ADMIN_LOGIN_SUCCESS',
        actor: user.username,
        targetType: 'admin_user',
        targetId: user.id,
        ipAddress: req.ip,
      });

      res.cookie(SESSION_COOKIE_NAME, session.rawToken, {
        httpOnly: true,
        secure: config.secureCookies,
        sameSite: 'lax',
        expires: session.expiresAt,
        path: '/',
      });

      res.json({
        authenticated: true,
        csrfToken: session.csrfToken,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          email: user.email,
          lastLoginAt: now,
        },
      });
    } catch {
      res.status(500).json({ error: 'Authentication failed', code: 'INTERNAL_ERROR' });
    }
  });

  // Logout
  router.post('/logout', requireAdminAuth(db, config), (req: Request, res: Response) => {
    if (req.admin) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(req.admin.sessionId);
      logAuditEvent(db, {
        eventType: 'ADMIN_LOGOUT',
        actor: req.admin.username,
        targetType: 'admin_user',
        targetId: req.admin.id,
        ipAddress: req.ip,
      });
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    res.json({ success: true });
  });

  // Invalidate all other sessions
  router.post('/sessions/revoke-all', requireAdminAuth(db, config), (req: Request, res: Response) => {
    const admin = req.admin!;
    const result = db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?')
      .run(admin.id, admin.sessionId);

    logAuditEvent(db, {
      eventType: 'ADMIN_SESSIONS_REVOKED',
      actor: admin.username,
      targetType: 'admin_user',
      targetId: admin.id,
      ipAddress: req.ip,
      details: { revokedCount: result.changes },
    });

    res.json({ success: true, revokedCount: result.changes });
  });

  // Change Password
  router.post('/change-password', requireAdminAuth(db, config), async (req: Request, res: Response) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid password payload', details: parsed.error.flatten(), code: 'VALIDATION_ERROR' });
      return;
    }

    const admin = req.admin!;
    const userRow = db.prepare('SELECT password_hash FROM admin_users WHERE id = ?').get(admin.id) as
      | { password_hash: string }
      | undefined;

    if (!userRow || !(await verifyPassword(userRow.password_hash, parsed.data.currentPassword))) {
      logAuditEvent(db, {
        eventType: 'ADMIN_PASSWORD_CHANGE_FAILED',
        actor: admin.username,
        ipAddress: req.ip,
      });
      res.status(401).json({ error: 'Current password is incorrect', code: 'INVALID_PASSWORD' });
      return;
    }

    const newHash = await hashPassword(parsed.data.newPassword);
    const now = new Date().toISOString();

    db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      newHash,
      now,
      admin.id
    );

    // Invalidate all other sessions on password change
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(admin.id, admin.sessionId);

    logAuditEvent(db, {
      eventType: 'ADMIN_PASSWORD_CHANGED',
      actor: admin.username,
      targetType: 'admin_user',
      targetId: admin.id,
      ipAddress: req.ip,
    });

    res.json({ success: true });
  });

  // Update Profile
  router.put('/profile', requireAdminAuth(db, config), (req: Request, res: Response) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid profile details', details: parsed.error.flatten(), code: 'VALIDATION_ERROR' });
      return;
    }

    const admin = req.admin!;
    const now = new Date().toISOString();
    db.prepare('UPDATE admin_users SET display_name = ?, email = ?, updated_at = ? WHERE id = ?').run(
      parsed.data.displayName,
      parsed.data.email || null,
      now,
      admin.id
    );

    logAuditEvent(db, {
      eventType: 'ADMIN_PROFILE_UPDATED',
      actor: admin.username,
      targetType: 'admin_user',
      targetId: admin.id,
      ipAddress: req.ip,
    });

    res.json({
      success: true,
      user: {
        id: admin.id,
        username: admin.username,
        displayName: parsed.data.displayName,
        email: parsed.data.email || null,
      },
    });
  });

  return router;
}
