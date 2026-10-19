import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { DbInstance, getSetting, logAuditEvent } from '../db/database.js';
import { AppConfig } from '../config.js';
import {
  requireAdminAuth,
  generateHighEntropyToken,
  hashToken,
  hashPassword,
  verifyPassword,
  signSharePasswordProof,
  verifySharePasswordProof,
  SHARE_AUTH_COOKIE_PREFIX,
} from '../services/authService.js';
import { assertStorageHealthy, StorageGuardError } from '../storage/mountGuard.js';
import { resolveSafePath, isSafeInlinePreviewMime } from '../storage/pathSecurity.js';
import {
  handleStreamingMultipartUpload,
  streamFileResponse,
  streamFolderZipArchive,
} from '../services/transferService.js';

const createShareLinkSchema = z.object({
  title: z.string().min(1).max(160),
  message: z.string().max(1000).optional().nullable(),
  targetType: z.enum(['file', 'folder']),
  targetId: z.string().min(1),
  permission: z.enum(['download_only', 'upload_only', 'upload_and_download']),
  password: z.string().max(128).optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
  maxDownloads: z.number().int().positive().optional().nullable(),
  maxUploads: z.number().int().positive().optional().nullable(),
  maxTotalUploadBytes: z.number().int().positive().optional().nullable(),
  maxSingleFileBytes: z.number().int().positive().optional().nullable(),
});

const updateShareLinkSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  message: z.string().max(1000).optional().nullable(),
  isEnabled: z.boolean().optional(),
  expiresAt: z.string().datetime().optional().nullable(),
  password: z.string().max(128).optional().nullable(),
  clearPassword: z.boolean().optional(),
  maxDownloads: z.number().int().positive().optional().nullable(),
  maxUploads: z.number().int().positive().optional().nullable(),
  maxTotalUploadBytes: z.number().int().positive().optional().nullable(),
  maxSingleFileBytes: z.number().int().positive().optional().nullable(),
});

interface FullShareLinkRow {
  id: string;
  token_hash: string;
  token_prefix: string;
  title: string;
  message: string | null;
  target_type: 'file' | 'folder';
  file_id: string | null;
  folder_id: string | null;
  password_hash: string | null;
  is_enabled: number;
  is_revoked: number;
  revoked_at: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  allow_download: number;
  allow_upload: number;
  allow_folder_listing: number;
  max_downloads: number | null;
  current_downloads: number;
  max_uploads: number | null;
  current_uploads: number;
  max_total_upload_bytes: number | null;
  current_uploaded_bytes: number;
  max_single_file_bytes: number | null;
  file_name?: string | null;
  file_size?: number | null;
  file_mime?: string | null;
  file_trashed?: number | null;
  folder_name?: string | null;
  folder_trashed?: number | null;
}

function computeShareStatus(row: FullShareLinkRow): 'active' | 'disabled' | 'expired' | 'revoked' | 'quota_exhausted' {
  if (row.is_revoked) return 'revoked';
  if (!row.is_enabled) return 'disabled';
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return 'expired';
  }
  if (row.allow_download && !row.allow_upload && row.max_downloads !== null && row.current_downloads >= row.max_downloads) {
    return 'quota_exhausted';
  }
  if (row.allow_upload && !row.allow_download) {
    if (row.max_uploads !== null && row.current_uploads >= row.max_uploads) {
      return 'quota_exhausted';
    }
    if (row.max_total_upload_bytes !== null && row.current_uploaded_bytes >= row.max_total_upload_bytes) {
      return 'quota_exhausted';
    }
  }
  return 'active';
}

function formatPermissionLevel(row: { allow_download: number; allow_upload: number }): 'download_only' | 'upload_only' | 'upload_and_download' {
  if (row.allow_download && row.allow_upload) return 'upload_and_download';
  if (row.allow_upload) return 'upload_only';
  return 'download_only';
}

export function createAdminSharesRouter(db: DbInstance, config: AppConfig): Router {
  const router = Router();
  router.use(requireAdminAuth(db, config));

  // GET /api/v1/shares — List all share links with stats and guest upload records
  router.get('/', (req: Request, res: Response) => {
    const filter = String(req.query.filter || 'all'); // 'all' | 'upload' | 'download'
    const rows = db
      .prepare(
        `SELECT sl.*,
                sp.allow_download, sp.allow_upload, sp.allow_folder_listing,
                sq.max_downloads, sq.current_downloads, sq.max_uploads, sq.current_uploads,
                sq.max_total_upload_bytes, sq.current_uploaded_bytes, sq.max_single_file_bytes,
                f.name as file_name, f.size_bytes as file_size, f.mime_type as file_mime, f.is_trashed as file_trashed,
                d.name as folder_name, d.is_trashed as folder_trashed
         FROM share_links sl
         JOIN share_permissions sp ON sp.link_id = sl.id
         JOIN share_link_quotas sq ON sq.link_id = sl.id
         LEFT JOIN files f ON f.id = sl.file_id
         LEFT JOIN folders d ON d.id = sl.folder_id
         ORDER BY sl.created_at DESC`
      )
      .all() as FullShareLinkRow[];

    const filtered = rows.filter((r) => {
      if (filter === 'upload') return r.allow_upload === 1;
      if (filter === 'download') return r.allow_download === 1;
      return true;
    });

    const getUploadsStmt = db.prepare(
      `SELECT id, file_id, original_filename, size_bytes, mime_type, uploader_ip, uploaded_at
       FROM guest_upload_records
       WHERE link_id = ?
       ORDER BY uploaded_at DESC
       LIMIT 50`
    );

    const links = filtered.map((r) => {
      const guestUploads = r.allow_upload ? getUploadsStmt.all(r.id) : [];
      return {
        id: r.id,
        tokenPrefix: r.token_prefix,
        title: r.title,
        message: r.message,
        targetType: r.target_type,
        targetId: r.target_type === 'file' ? r.file_id : r.folder_id,
        targetName: r.target_type === 'file' ? r.file_name || 'Deleted File' : r.folder_name || 'Deleted Folder',
        targetSize: r.target_type === 'file' ? r.file_size : null,
        permission: formatPermissionLevel(r),
        allowDownload: Boolean(r.allow_download),
        allowUpload: Boolean(r.allow_upload),
        hasPassword: Boolean(r.password_hash),
        isEnabled: Boolean(r.is_enabled),
        isRevoked: Boolean(r.is_revoked),
        revokedAt: r.revoked_at,
        expiresAt: r.expires_at,
        status: computeShareStatus(r),
        quotas: {
          maxDownloads: r.max_downloads,
          currentDownloads: r.current_downloads,
          maxUploads: r.max_uploads,
          currentUploads: r.current_uploads,
          maxTotalUploadBytes: r.max_total_upload_bytes,
          currentUploadedBytes: r.current_uploaded_bytes,
          remainingUploadBytes:
            r.max_total_upload_bytes !== null
              ? Math.max(0, r.max_total_upload_bytes - r.current_uploaded_bytes)
              : null,
          maxSingleFileBytes: r.max_single_file_bytes,
        },
        guestUploads: (guestUploads as any[]).map((gu) => ({
          id: gu.id,
          fileId: gu.file_id,
          originalFilename: gu.original_filename,
          sizeBytes: gu.size_bytes,
          mimeType: gu.mime_type,
          uploaderIp: gu.uploader_ip,
          uploadedAt: gu.uploaded_at,
        })),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });

    res.json({ links });
  });

  // POST /api/v1/shares — Create a new public share link (returns raw token once; stores ONLY SHA-256 hash)
  router.post('/', async (req: Request, res: Response) => {
    try {
      const parsed = createShareLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid share link parameters',
          details: parsed.error.flatten(),
          code: 'VALIDATION_ERROR',
        });
        return;
      }

      const data = parsed.data;

      // Upload permission is only valid for folders
      if (data.permission !== 'download_only' && data.targetType !== 'folder') {
        res.status(400).json({
          error: 'Guest upload links can only target a designated folder',
          code: 'UPLOAD_REQUIRES_FOLDER',
        });
        return;
      }

      // Verify target exists and is not trashed
      let targetName = '';
      if (data.targetType === 'file') {
        const file = db
          .prepare('SELECT id, name FROM files WHERE id = ? AND is_trashed = 0')
          .get(data.targetId) as { id: string; name: string } | undefined;
        if (!file) {
          res.status(404).json({ error: 'Target file not found', code: 'FILE_NOT_FOUND' });
          return;
        }
        targetName = file.name;
      } else {
        const folder = db
          .prepare('SELECT id, name FROM folders WHERE id = ? AND is_trashed = 0')
          .get(data.targetId) as { id: string; name: string } | undefined;
        if (!folder) {
          res.status(404).json({ error: 'Target folder not found', code: 'FOLDER_NOT_FOUND' });
          return;
        }
        targetName = folder.name;
      }

      const rawToken = generateHighEntropyToken(32); // 256-bit cryptographically random token
      const tokenHash = hashToken(rawToken);
      const tokenPrefix = rawToken.slice(0, 8);
      const linkId = crypto.randomUUID();
      const now = new Date().toISOString();

      const passwordHash =
        data.password && data.password.trim().length > 0
          ? await hashPassword(data.password.trim())
          : null;

      const allowDownload =
        data.permission === 'download_only' || data.permission === 'upload_and_download' ? 1 : 0;
      const allowUpload =
        data.permission === 'upload_only' || data.permission === 'upload_and_download' ? 1 : 0;
      const allowFolderListing = allowDownload && data.targetType === 'folder' ? 1 : 0;

      const defaultGuestQuota = parseInt(
        getSetting(db, 'default_guest_quota_bytes', String(config.defaultGuestQuotaBytes)),
        10
      );
      const defaultMaxSingleFile = parseInt(
        getSetting(db, 'max_upload_file_size_bytes', String(config.maxUploadFileSizeBytes)),
        10
      );

      const maxTotalUploadBytes = allowUpload
        ? data.maxTotalUploadBytes ?? defaultGuestQuota
        : null;
      const maxSingleFileBytes = allowUpload
        ? data.maxSingleFileBytes ?? defaultMaxSingleFile
        : null;

      const createTx = db.transaction(() => {
        db.prepare(
          `INSERT INTO share_links (
             id, token_hash, token_prefix, title, message, target_type,
             file_id, folder_id, password_hash, is_enabled, is_revoked,
             expires_at, created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`
        ).run(
          linkId,
          tokenHash,
          tokenPrefix,
          data.title.trim(),
          data.message ? data.message.trim() : null,
          data.targetType,
          data.targetType === 'file' ? data.targetId : null,
          data.targetType === 'folder' ? data.targetId : null,
          passwordHash,
          data.expiresAt || null,
          req.admin!.id,
          now,
          now
        );

        db.prepare(
          `INSERT INTO share_permissions (link_id, allow_download, allow_upload, allow_folder_listing)
           VALUES (?, ?, ?, ?)`
        ).run(linkId, allowDownload, allowUpload, allowFolderListing);

        db.prepare(
          `INSERT INTO share_link_quotas (
             link_id, max_downloads, current_downloads, max_uploads, current_uploads,
             max_total_upload_bytes, current_uploaded_bytes, max_single_file_bytes
           ) VALUES (?, ?, 0, ?, 0, ?, 0, ?)`
        ).run(
          linkId,
          data.maxDownloads ?? null,
          data.maxUploads ?? null,
          maxTotalUploadBytes,
          maxSingleFileBytes
        );
      });

      createTx();

      logAuditEvent(db, {
        eventType: 'SHARE_LINK_CREATED',
        actor: req.admin!.username,
        targetType: data.targetType,
        targetId: data.targetId,
        ipAddress: req.ip,
        details: {
          linkId,
          permission: data.permission,
          hasPassword: Boolean(passwordHash),
          expiresAt: data.expiresAt || null,
        },
      });

      res.status(201).json({
        rawToken,
        shareUrlPath: `/s/${rawToken}`,
        link: {
          id: linkId,
          tokenPrefix,
          title: data.title.trim(),
          message: data.message || null,
          targetType: data.targetType,
          targetId: data.targetId,
          targetName,
          permission: data.permission,
          allowDownload: Boolean(allowDownload),
          allowUpload: Boolean(allowUpload),
          hasPassword: Boolean(passwordHash),
          isEnabled: true,
          isRevoked: false,
          expiresAt: data.expiresAt || null,
          status: 'active',
          quotas: {
            maxDownloads: data.maxDownloads ?? null,
            currentDownloads: 0,
            maxUploads: data.maxUploads ?? null,
            currentUploads: 0,
            maxTotalUploadBytes,
            currentUploadedBytes: 0,
            remainingUploadBytes: maxTotalUploadBytes,
            maxSingleFileBytes,
          },
          createdAt: now,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to create share link', code: 'CREATE_SHARE_FAILED' });
    }
  });

  // PATCH /api/v1/shares/:id — Edit allowed settings on an existing share link
  router.patch('/:id', async (req: Request, res: Response) => {
    const parsed = updateShareLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid share update payload', code: 'VALIDATION_ERROR' });
      return;
    }

    const linkId = String(req.params.id);
    const existing = db
      .prepare('SELECT * FROM share_links WHERE id = ?')
      .get(linkId) as FullShareLinkRow | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Share link not found', code: 'SHARE_NOT_FOUND' });
      return;
    }

    if (existing.is_revoked) {
      res.status(400).json({ error: 'Revoked links cannot be modified', code: 'SHARE_REVOKED' });
      return;
    }

    const d = parsed.data;
    const now = new Date().toISOString();

    let newPasswordHash = existing.password_hash;
    if (d.clearPassword) {
      newPasswordHash = null;
    } else if (d.password && d.password.trim().length > 0) {
      newPasswordHash = await hashPassword(d.password.trim());
    }

    const updateTx = db.transaction(() => {
      db.prepare(
        `UPDATE share_links
         SET title = COALESCE(?, title),
             message = CASE WHEN ? THEN ? ELSE message END,
             is_enabled = COALESCE(?, is_enabled),
             expires_at = CASE WHEN ? THEN ? ELSE expires_at END,
             password_hash = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(
        d.title ?? null,
        d.message !== undefined ? 1 : 0,
        d.message ?? null,
        d.isEnabled !== undefined ? (d.isEnabled ? 1 : 0) : null,
        d.expiresAt !== undefined ? 1 : 0,
        d.expiresAt ?? null,
        newPasswordHash,
        now,
        linkId
      );

      if (
        d.maxDownloads !== undefined ||
        d.maxUploads !== undefined ||
        d.maxTotalUploadBytes !== undefined ||
        d.maxSingleFileBytes !== undefined
      ) {
        const currentQuotas = db
          .prepare('SELECT * FROM share_link_quotas WHERE link_id = ?')
          .get(linkId) as any;

        db.prepare(
          `UPDATE share_link_quotas
           SET max_downloads = ?,
               max_uploads = ?,
               max_total_upload_bytes = ?,
               max_single_file_bytes = ?
           WHERE link_id = ?`
        ).run(
          d.maxDownloads !== undefined ? d.maxDownloads : currentQuotas.max_downloads,
          d.maxUploads !== undefined ? d.maxUploads : currentQuotas.max_uploads,
          d.maxTotalUploadBytes !== undefined ? d.maxTotalUploadBytes : currentQuotas.max_total_upload_bytes,
          d.maxSingleFileBytes !== undefined ? d.maxSingleFileBytes : currentQuotas.max_single_file_bytes,
          linkId
        );
      }
    });

    updateTx();

    logAuditEvent(db, {
      eventType: 'SHARE_LINK_UPDATED',
      actor: req.admin!.username,
      targetType: 'share_link',
      targetId: linkId,
      ipAddress: req.ip,
    });

    res.json({ success: true });
  });

  // POST /api/v1/shares/:id/regenerate-token — Issue a new cryptographically random token for an existing link
  router.post('/:id/regenerate-token', (req: Request, res: Response) => {
    const linkId = String(req.params.id);
    const existing = db.prepare('SELECT id, is_revoked FROM share_links WHERE id = ?').get(linkId) as
      | { id: string; is_revoked: number }
      | undefined;

    if (!existing || existing.is_revoked) {
      res.status(404).json({ error: 'Active share link not found', code: 'SHARE_NOT_FOUND' });
      return;
    }

    const rawToken = generateHighEntropyToken(32);
    const tokenHash = hashToken(rawToken);
    const tokenPrefix = rawToken.slice(0, 8);
    const now = new Date().toISOString();

    db.prepare(
      'UPDATE share_links SET token_hash = ?, token_prefix = ?, updated_at = ? WHERE id = ?'
    ).run(tokenHash, tokenPrefix, now, linkId);

    logAuditEvent(db, {
      eventType: 'SHARE_TOKEN_REGENERATED',
      actor: req.admin!.username,
      targetType: 'share_link',
      targetId: linkId,
      ipAddress: req.ip,
    });

    res.json({
      rawToken,
      shareUrlPath: `/s/${rawToken}`,
      tokenPrefix,
    });
  });

  // POST /api/v1/shares/:id/revoke — Revoke link immediately
  router.post('/:id/revoke', (req: Request, res: Response) => {
    const linkId = String(req.params.id);
    const now = new Date().toISOString();

    const result = db
      .prepare('UPDATE share_links SET is_revoked = 1, is_enabled = 0, revoked_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, linkId);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Share link not found', code: 'SHARE_NOT_FOUND' });
      return;
    }

    logAuditEvent(db, {
      eventType: 'SHARE_LINK_REVOKED',
      actor: req.admin!.username,
      targetType: 'share_link',
      targetId: linkId,
      ipAddress: req.ip,
    });

    res.json({ success: true, revokedAt: now });
  });

  // DELETE /api/v1/shares/:id — Delete share link record
  router.delete('/:id', (req: Request, res: Response) => {
    const linkId = String(req.params.id);
    db.prepare('DELETE FROM share_links WHERE id = ?').run(linkId);
    res.json({ success: true });
  });

  return router;
}

/**
 * PUBLIC SHARE ROUTER (`/api/v1/public/shares/:token`)
 * Completely separate from private administrative APIs. Does not require user accounts or login sessions.
 * Enforces permissions, expiration, revocation, passwords, rate limits, concurrency limits, and quotas on EVERY request.
 */
export function createPublicSharesRouter(db: DbInstance, config: AppConfig): Router {
  const router = Router();
  let activeGuestUploadsCount = 0;

  const publicLookupLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: config.nodeEnv === 'test' ? 500 : 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests from this IP. Please wait a moment.', code: 'RATE_LIMITED' },
  });

  const publicUploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.nodeEnv === 'test' ? 500 : 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Guest upload rate limit reached. Please try again later.', code: 'UPLOAD_RATE_LIMITED' },
  });

  const publicPasswordLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: config.nodeEnv === 'test' ? 500 : 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many failed password attempts from this IP. Please try again in 15 minutes.',
      code: 'PASSWORD_RATE_LIMITED',
    },
  });

  router.use(publicLookupLimiter);

  function loadAndValidateShareLink(
    req: Request,
    res: Response,
    options: { requireDownload?: boolean; requireUpload?: boolean; skipPasswordCheck?: boolean } = {}
  ): FullShareLinkRow | null {
    const rawToken = String(req.params.token || '').trim();
    if (!rawToken || rawToken.length < 16) {
      res.status(404).json({ error: 'Invalid or non-existent share link', code: 'SHARE_INVALID' });
      return null;
    }

    const tokenHash = hashToken(rawToken);
    const row = db
      .prepare(
        `SELECT sl.*,
                sp.allow_download, sp.allow_upload, sp.allow_folder_listing,
                sq.max_downloads, sq.current_downloads, sq.max_uploads, sq.current_uploads,
                sq.max_total_upload_bytes, sq.current_uploaded_bytes, sq.max_single_file_bytes,
                f.name as file_name, f.size_bytes as file_size, f.mime_type as file_mime, f.is_trashed as file_trashed,
                d.name as folder_name, d.is_trashed as folder_trashed
         FROM share_links sl
         JOIN share_permissions sp ON sp.link_id = sl.id
         JOIN share_link_quotas sq ON sq.link_id = sl.id
         LEFT JOIN files f ON f.id = sl.file_id
         LEFT JOIN folders d ON d.id = sl.folder_id
         WHERE sl.token_hash = ?`
      )
      .get(tokenHash) as FullShareLinkRow | undefined;

    if (!row) {
      res.status(404).json({ error: 'This share link does not exist', code: 'SHARE_NOT_FOUND' });
      return null;
    }

    if (row.is_revoked) {
      res.status(410).json({ error: 'This share link has been revoked by the owner', code: 'SHARE_REVOKED' });
      return null;
    }

    if (!row.is_enabled) {
      res.status(403).json({ error: 'This share link is currently disabled', code: 'SHARE_DISABLED' });
      return null;
    }

    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      res.status(410).json({ error: 'This share link has expired', code: 'SHARE_EXPIRED' });
      return null;
    }

    // Check target still exists and is not in trash
    if (row.target_type === 'file' && (!row.file_id || !row.file_name || row.file_trashed)) {
      res.status(404).json({ error: 'The shared file is no longer available', code: 'TARGET_UNAVAILABLE' });
      return null;
    }
    if (row.target_type === 'folder' && (!row.folder_id || !row.folder_name || row.folder_trashed)) {
      res.status(404).json({ error: 'The shared folder is no longer available', code: 'TARGET_UNAVAILABLE' });
      return null;
    }

    // Check optional password protection
    if (row.password_hash && !options.skipPasswordCheck) {
      const cookieName = `${SHARE_AUTH_COOKIE_PREFIX}${row.id}`;
      const proofCookie = req.cookies?.[cookieName];
      const headerPassword = req.headers['x-share-password']
        ? String(req.headers['x-share-password'])
        : undefined;

      const cookieValid = verifySharePasswordProof(
        proofCookie,
        row.id,
        row.password_hash,
        config.sessionSecret
      );

      if (!cookieValid && !headerPassword) {
        res.status(401).json({
          error: 'Password required to access this link',
          code: 'PASSWORD_REQUIRED',
          requiresPassword: true,
          title: row.title,
        });
        return null;
      }
    }

    // Explicit permission checks (NEVER assume upload permission implies download permission!)
    if (options.requireDownload && !row.allow_download) {
      res.status(403).json({
        error: 'This link grants upload permission only. Browsing or downloading files is not authorized.',
        code: 'DOWNLOAD_FORBIDDEN',
      });
      return null;
    }

    if (options.requireUpload && !row.allow_upload) {
      res.status(403).json({
        error: 'This link does not grant upload permission.',
        code: 'UPLOAD_FORBIDDEN',
      });
      return null;
    }

    // Check global guest upload master switch if upload is requested
    if (options.requireUpload) {
      const globalGuestUploadsEnabled = getSetting(db, 'guest_uploads_enabled', 'true') === 'true';
      if (!globalGuestUploadsEnabled) {
        res.status(403).json({
          error: 'Guest uploads have been temporarily disabled by the administrator.',
          code: 'GUEST_UPLOADS_DISABLED_GLOBALLY',
        });
        return null;
      }
    }

    return row;
  }

  // POST /api/v1/public/shares/:token/verify-password
  router.post('/:token/verify-password', publicPasswordLimiter, async (req: Request, res: Response) => {
    const row = loadAndValidateShareLink(req, res, { skipPasswordCheck: true });
    if (!row) return;

    if (!row.password_hash) {
      res.json({ verified: true });
      return;
    }

    const password = String(req.body?.password || '');
    const valid = await verifyPassword(row.password_hash, password);
    if (!valid) {
      logAuditEvent(db, {
        eventType: 'PUBLIC_SHARE_PASSWORD_FAILED',
        actor: 'guest',
        targetType: 'share_link',
        targetId: row.id,
        ipAddress: req.ip,
      });
      res.status(401).json({ error: 'Incorrect link password', code: 'INVALID_SHARE_PASSWORD' });
      return;
    }

    const proof = signSharePasswordProof(row.id, row.password_hash, config.sessionSecret);
    const cookieName = `${SHARE_AUTH_COOKIE_PREFIX}${row.id}`;

    res.cookie(cookieName, proof, {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'lax',
      maxAge: 2 * 60 * 60 * 1000, // 2 hours
      path: '/',
    });

    res.json({ verified: true });
  });

  // GET /api/v1/public/shares/:token — Inspect public share metadata
  router.get('/:token', async (req: Request, res: Response) => {
    const row = loadAndValidateShareLink(req, res, { skipPasswordCheck: true });
    if (!row) return;

    // Check if password is required and not yet verified
    if (row.password_hash) {
      const cookieName = `${SHARE_AUTH_COOKIE_PREFIX}${row.id}`;
      const proofCookie = req.cookies?.[cookieName];
      const headerPassword = req.headers['x-share-password']
        ? String(req.headers['x-share-password'])
        : undefined;

      let authorized = verifySharePasswordProof(
        proofCookie,
        row.id,
        row.password_hash,
        config.sessionSecret
      );
      if (!authorized && headerPassword) {
        authorized = await verifyPassword(row.password_hash, headerPassword);
      }

      if (!authorized) {
        res.json({
          requiresPassword: true,
          title: row.title,
          targetType: row.target_type,
          permission: formatPermissionLevel(row),
          expiresAt: row.expires_at,
        });
        return;
      }
    }

    // Only list files inside a shared folder if allow_download is explicitly enabled!
    // Guest upload-only links NEVER expose existing files in the destination folder.
    let sharedFolderFiles: any[] = [];
    if (row.target_type === 'folder' && row.allow_download && row.folder_id) {
      const files = db
        .prepare(
          `SELECT id, name, mime_type, category, extension, size_bytes, created_at
           FROM files
           WHERE folder_id = ? AND is_trashed = 0
           ORDER BY name COLLATE NOCASE ASC`
        )
        .all(row.folder_id) as any[];

      sharedFolderFiles = files.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mime_type,
        category: f.category,
        extension: f.extension,
        sizeBytes: f.size_bytes,
        canPreviewInline: isSafeInlinePreviewMime(f.mime_type),
        createdAt: f.created_at,
      }));
    }

    const globalGuestUploadsEnabled = getSetting(db, 'guest_uploads_enabled', 'true') === 'true';

    res.json({
      requiresPassword: false,
      title: row.title,
      message: row.message,
      targetType: row.target_type,
      targetName: row.target_type === 'file' ? row.file_name : row.folder_name,
      fileMeta:
        row.target_type === 'file' && row.allow_download
          ? {
              name: row.file_name,
              sizeBytes: row.file_size,
              mimeType: row.file_mime,
              canPreviewInline: isSafeInlinePreviewMime(row.file_mime || ''),
            }
          : null,
      folderFiles: row.allow_download ? sharedFolderFiles : undefined,
      permission: formatPermissionLevel(row),
      allowDownload: Boolean(row.allow_download),
      allowUpload: Boolean(row.allow_upload) && globalGuestUploadsEnabled,
      guestUploadsGloballyDisabled: Boolean(row.allow_upload) && !globalGuestUploadsEnabled,
      expiresAt: row.expires_at,
      quotas: {
        maxDownloads: row.max_downloads,
        currentDownloads: row.current_downloads,
        remainingDownloads:
          row.max_downloads !== null ? Math.max(0, row.max_downloads - row.current_downloads) : null,
        maxUploads: row.max_uploads,
        currentUploads: row.current_uploads,
        remainingUploads:
          row.max_uploads !== null ? Math.max(0, row.max_uploads - row.current_uploads) : null,
        maxTotalUploadBytes: row.max_total_upload_bytes,
        currentUploadedBytes: row.current_uploaded_bytes,
        remainingUploadBytes:
          row.max_total_upload_bytes !== null
            ? Math.max(0, row.max_total_upload_bytes - row.current_uploaded_bytes)
            : null,
        maxSingleFileBytes: row.max_single_file_bytes,
      },
    });
  });

  // GET /api/v1/public/shares/:token/download — Public download of file or folder (or specific file inside shared folder)
  router.get('/:token/download', async (req: Request, res: Response) => {
    const row = loadAndValidateShareLink(req, res, { requireDownload: true });
    if (!row) return;

    // Verify password if header-based
    if (row.password_hash) {
      const cookieName = `${SHARE_AUTH_COOKIE_PREFIX}${row.id}`;
      const proofCookie = req.cookies?.[cookieName];
      const headerPassword = req.headers['x-share-password']
        ? String(req.headers['x-share-password'])
        : undefined;
      let ok = verifySharePasswordProof(proofCookie, row.id, row.password_hash, config.sessionSecret);
      if (!ok && headerPassword) {
        ok = await verifyPassword(row.password_hash, headerPassword);
      }
      if (!ok) {
        res.status(401).json({ error: 'Password required', code: 'PASSWORD_REQUIRED' });
        return;
      }
    }

    // Check download limit quota
    if (row.max_downloads !== null && row.current_downloads >= row.max_downloads) {
      res.status(429).json({
        error: 'Maximum download limit reached for this share link',
        code: 'DOWNLOAD_LIMIT_REACHED',
      });
      return;
    }

    const wantInline = req.query.inline === 'true' || req.query.inline === '1';
    const subFileId = req.query.fileId ? String(req.query.fileId) : null;
    const isRangeContinuation = Boolean(req.headers.range && !req.headers.range.startsWith('bytes=0-'));
    const trackDownloads = getSetting(db, 'track_downloads', 'true') === 'true';

    try {
      if (row.target_type === 'file') {
        const fileRow = db
          .prepare('SELECT * FROM files WHERE id = ? AND is_trashed = 0')
          .get(row.file_id!) as any;
        if (!fileRow) {
          res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
          return;
        }

        const diskPath = resolveSafePath(config.paths.files, fileRow.relative_path);

        if (!isRangeContinuation && !wantInline) {
          db.prepare(
            'UPDATE share_link_quotas SET current_downloads = current_downloads + 1 WHERE link_id = ?'
          ).run(row.id);

          if (trackDownloads) {
            db.prepare(
              `INSERT INTO transfer_activity (id, direction, actor_type, link_id, file_id, item_name, bytes_transferred, ip_address, status, created_at)
               VALUES (?, 'download', 'guest', ?, ?, ?, ?, ?, 'completed', ?)`
            ).run(
              `tr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
              row.id,
              fileRow.id,
              fileRow.name,
              fileRow.size_bytes,
              req.ip || null,
              new Date().toISOString()
            );
          }
        }

        streamFileResponse({
          req,
          res,
          diskPath,
          displayName: fileRow.name,
          mimeType: fileRow.mime_type,
          sizeBytes: fileRow.size_bytes,
          inline: wantInline && isSafeInlinePreviewMime(fileRow.mime_type),
        });
      } else {
        // Folder target: either download a specific direct child file or stream the entire folder as a ZIP archive
        if (subFileId) {
          const childFile = db
            .prepare('SELECT * FROM files WHERE id = ? AND folder_id = ? AND is_trashed = 0')
            .get(subFileId, row.folder_id!) as any;

          if (!childFile) {
            res.status(404).json({ error: 'File not found in shared folder', code: 'FILE_NOT_FOUND' });
            return;
          }

          const diskPath = resolveSafePath(config.paths.files, childFile.relative_path);

          if (!isRangeContinuation && !wantInline) {
            db.prepare(
              'UPDATE share_link_quotas SET current_downloads = current_downloads + 1 WHERE link_id = ?'
            ).run(row.id);

            if (trackDownloads) {
              db.prepare(
                `INSERT INTO transfer_activity (id, direction, actor_type, link_id, file_id, folder_id, item_name, bytes_transferred, ip_address, status, created_at)
                 VALUES (?, 'download', 'guest', ?, ?, ?, ?, ?, ?, 'completed', ?)`
              ).run(
                `tr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
                row.id,
                childFile.id,
                row.folder_id,
                childFile.name,
                childFile.size_bytes,
                req.ip || null,
                new Date().toISOString()
              );
            }
          }

          streamFileResponse({
            req,
            res,
            diskPath,
            displayName: childFile.name,
            mimeType: childFile.mime_type,
            sizeBytes: childFile.size_bytes,
            inline: wantInline && isSafeInlinePreviewMime(childFile.mime_type),
          });
          return;
        }

        // Stream full folder archive
        db.prepare(
          'UPDATE share_link_quotas SET current_downloads = current_downloads + 1 WHERE link_id = ?'
        ).run(row.id);

        const totalBytes = await streamFolderZipArchive({
          res,
          db,
          config,
          rootFolderId: row.folder_id!,
          rootFolderName: row.folder_name || 'Shared_Folder',
        });

        if (trackDownloads) {
          db.prepare(
            `INSERT INTO transfer_activity (id, direction, actor_type, link_id, folder_id, item_name, bytes_transferred, ip_address, status, created_at)
             VALUES (?, 'download', 'guest', ?, ?, ?, ?, ?, 'completed', ?)`
          ).run(
            `tr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            row.id,
            row.folder_id,
            `${row.folder_name}.zip`,
            totalBytes,
            req.ip || null,
            new Date().toISOString()
          );
        }
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Download failed', code: 'DOWNLOAD_ERROR' });
      }
    }
  });

  // POST /api/v1/public/shares/:token/upload — Guest file upload into designated folder without login
  router.post('/:token/upload', publicUploadLimiter, async (req: Request, res: Response) => {
    const row = loadAndValidateShareLink(req, res, { requireUpload: true });
    if (!row) return;

    // Verify password if protected
    if (row.password_hash) {
      const cookieName = `${SHARE_AUTH_COOKIE_PREFIX}${row.id}`;
      const proofCookie = req.cookies?.[cookieName];
      const headerPassword = req.headers['x-share-password']
        ? String(req.headers['x-share-password'])
        : undefined;
      let ok = verifySharePasswordProof(proofCookie, row.id, row.password_hash, config.sessionSecret);
      if (!ok && headerPassword) {
        ok = await verifyPassword(row.password_hash, headerPassword);
      }
      if (!ok) {
        res.status(401).json({ error: 'Password required to upload files', code: 'PASSWORD_REQUIRED' });
        return;
      }
    }

    // Check concurrent guest upload limit
    const maxConcurrent = parseInt(
      getSetting(db, 'max_concurrent_guest_uploads', String(config.maxConcurrentGuestUploads)),
      10
    );
    if (activeGuestUploadsCount >= maxConcurrent) {
      res.status(429).json({
        error: 'Server is currently busy processing other guest uploads. Please retry shortly.',
        code: 'CONCURRENT_UPLOAD_LIMIT',
      });
      return;
    }

    // Check file count quota before starting
    if (row.max_uploads !== null && row.current_uploads >= row.max_uploads) {
      res.status(413).json({
        error: 'Maximum number of uploaded files reached for this link',
        code: 'UPLOAD_COUNT_EXHAUSTED',
      });
      return;
    }

    // Check per-link byte quota before starting
    if (
      row.max_total_upload_bytes !== null &&
      row.current_uploaded_bytes >= row.max_total_upload_bytes
    ) {
      res.status(413).json({
        error: 'Storage quota for this upload link has been exhausted',
        code: 'QUOTA_EXCEEDED',
      });
      return;
    }

    // Check global total guest upload quota across entire drive
    const totalGlobalGuestQuota = parseInt(
      getSetting(db, 'total_guest_upload_quota_bytes', String(50 * 1024 * 1024 * 1024)),
      10
    );
    const currentGlobalGuestBytes = (
      db
        .prepare('SELECT COALESCE(SUM(size_bytes), 0) as total FROM guest_upload_records')
        .get() as { total: number }
    ).total;

    if (currentGlobalGuestBytes >= totalGlobalGuestQuota) {
      res.status(413).json({
        error: 'Global guest upload storage quota has been reached on this server',
        code: 'GLOBAL_GUEST_QUOTA_EXCEEDED',
      });
      return;
    }

    const globalMaxSingleFile = parseInt(
      getSetting(db, 'max_upload_file_size_bytes', String(config.maxUploadFileSizeBytes)),
      10
    );
    const maxSingleFileBytes =
      row.max_single_file_bytes !== null
        ? Math.min(row.max_single_file_bytes, globalMaxSingleFile)
        : globalMaxSingleFile;

    const remainingLinkQuota =
      row.max_total_upload_bytes !== null
        ? Math.max(0, row.max_total_upload_bytes - row.current_uploaded_bytes)
        : totalGlobalGuestQuota - currentGlobalGuestBytes;

    const effectiveRemainingQuota = Math.min(
      remainingLinkQuota,
      totalGlobalGuestQuota - currentGlobalGuestBytes
    );

    const remainingFileCount =
      row.max_uploads !== null ? Math.max(0, row.max_uploads - row.current_uploads) : 50;

    // Fast fail if Content-Length header already exceeds quota
    const declaredLength = req.headers['content-length']
      ? parseInt(String(req.headers['content-length']), 10)
      : 0;
    if (declaredLength > effectiveRemainingQuota + 64 * 1024) {
      res.status(413).json({
        error: `Upload exceeds remaining link quota (${effectiveRemainingQuota} bytes available)`,
        code: 'QUOTA_EXCEEDED',
      });
      return;
    }

    activeGuestUploadsCount++;
    try {
      const uploadedFiles = await handleStreamingMultipartUpload({
        req,
        db,
        config,
        defaultFolderId: row.folder_id!,
        allowRelativePaths: false, // Guest uploads go strictly into the designated folder
        maxSingleFileBytes,
        maxTotalUploadBytes: effectiveRemainingQuota,
        maxFileCount: remainingFileCount,
        uploadedViaLinkId: row.id,
      });

      const batchBytes = uploadedFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
      const now = new Date().toISOString();

      const recordGuestUploadTx = db.transaction(() => {
        db.prepare(
          `UPDATE share_link_quotas
           SET current_uploads = current_uploads + ?,
               current_uploaded_bytes = current_uploaded_bytes + ?
           WHERE link_id = ?`
        ).run(uploadedFiles.length, batchBytes, row.id);

        const insertRecord = db.prepare(
          `INSERT INTO guest_upload_records (
             id, link_id, file_id, original_filename, stored_filename,
             size_bytes, mime_type, uploader_ip, user_agent, uploaded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        const insertTransfer = db.prepare(
          `INSERT INTO transfer_activity (
             id, direction, actor_type, link_id, file_id, folder_id,
             item_name, bytes_transferred, ip_address, status, created_at
           ) VALUES (?, 'upload', 'guest', ?, ?, ?, ?, ?, ?, 'completed', ?)`
        );

        for (const f of uploadedFiles) {
          insertRecord.run(
            crypto.randomUUID(),
            row.id,
            f.id,
            f.name,
            f.storageName,
            f.sizeBytes,
            f.mimeType,
            req.ip || null,
            req.headers['user-agent'] || null,
            now
          );

          insertTransfer.run(
            `tr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
            row.id,
            f.id,
            row.folder_id,
            f.name,
            f.sizeBytes,
            req.ip || null,
            now
          );
        }
      });

      recordGuestUploadTx();

      logAuditEvent(db, {
        eventType: 'GUEST_FILES_UPLOADED',
        actor: 'guest',
        targetType: 'share_link',
        targetId: row.id,
        ipAddress: req.ip,
        details: {
          count: uploadedFiles.length,
          totalBytes: batchBytes,
          filenames: uploadedFiles.map((u) => u.name),
        },
      });

      const updatedQuotas = db
        .prepare('SELECT * FROM share_link_quotas WHERE link_id = ?')
        .get(row.id) as any;

      res.status(201).json({
        success: true,
        uploaded: uploadedFiles.map((f) => ({
          name: f.name,
          sizeBytes: f.sizeBytes,
          uploadedAt: f.createdAt,
        })),
        quotas: {
          currentUploads: updatedQuotas.current_uploads,
          maxUploads: updatedQuotas.max_uploads,
          currentUploadedBytes: updatedQuotas.current_uploaded_bytes,
          maxTotalUploadBytes: updatedQuotas.max_total_upload_bytes,
          remainingUploadBytes:
            updatedQuotas.max_total_upload_bytes !== null
              ? Math.max(0, updatedQuotas.max_total_upload_bytes - updatedQuotas.current_uploaded_bytes)
              : null,
        },
      });
    } catch (err: any) {
      if (err instanceof StorageGuardError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err.message || 'Guest upload failed', code: 'GUEST_UPLOAD_FAILED' });
    } finally {
      activeGuestUploadsCount = Math.max(0, activeGuestUploadsCount - 1);
    }
  });

  return router;
}
