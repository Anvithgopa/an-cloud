import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { DbInstance, getSetting, logAuditEvent } from '../db/database.js';
import { AppConfig } from '../config.js';
import { requireAdminAuth } from '../services/authService.js';
import { assertStorageHealthy, StorageGuardError } from '../storage/mountGuard.js';
import {
  sanitizeDisplayName,
  generateSafeStorageFilename,
  resolveDuplicateDisplayName,
  resolveSafePath,
  isSafeInlinePreviewMime,
} from '../storage/pathSecurity.js';
import {
  handleStreamingMultipartUpload,
  streamFileResponse,
  streamFolderZipArchive,
} from '../services/transferService.js';

const createFolderSchema = z.object({
  name: z.string().min(1).max(200),
  parentId: z.string().nullable().optional(),
});

const renameItemSchema = z.object({
  name: z.string().min(1).max(200),
});

const moveItemSchema = z.object({
  targetFolderId: z.string().nullable(),
});

const bulkActionSchema = z.object({
  action: z.enum(['trash', 'restore', 'delete', 'move', 'star', 'unstar']),
  fileIds: z.array(z.string()).default([]),
  folderIds: z.array(z.string()).default([]),
  targetFolderId: z.string().nullable().optional(),
});

export function createDriveRouter(db: DbInstance, config: AppConfig): Router {
  const router = Router();
  router.use(requireAdminAuth(db, config));

  // Helper to build breadcrumbs from folderId up to root
  function getBreadcrumbs(folderId: string | null): { id: string; name: string }[] {
    const crumbs: { id: string; name: string }[] = [];
    let currentId = folderId;
    const visited = new Set<string>();

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);
      const row = db
        .prepare('SELECT id, parent_id, name FROM folders WHERE id = ?')
        .get(currentId) as { id: string; parent_id: string | null; name: string } | undefined;
      if (!row) break;
      crumbs.unshift({ id: row.id, name: row.name });
      currentId = row.parent_id;
    }
    return crumbs;
  }

  // Helper to check if candidateFolderId is a descendant of folderId (prevents circular folder move)
  function isFolderDescendant(folderId: string, candidateDescendantId: string | null): boolean {
    let current = candidateDescendantId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      if (current === folderId) return true;
      visited.add(current);
      const row = db
        .prepare('SELECT parent_id FROM folders WHERE id = ?')
        .get(current) as { parent_id: string | null } | undefined;
      current = row ? row.parent_id : null;
    }
    return false;
  }

  // Helper to permanently delete a file from HDD and DB
  function permanentlyDeleteFile(fileId: string): void {
    const fileRow = db
      .prepare('SELECT id, name, storage_name, relative_path, is_trashed FROM files WHERE id = ?')
      .get(fileId) as
      | { id: string; name: string; storage_name: string; relative_path: string; is_trashed: number }
      | undefined;

    if (!fileRow) return;

    const activePath = resolveSafePath(config.paths.files, fileRow.relative_path);
    const trashedPath = resolveSafePath(config.paths.trash, fileRow.storage_name);

    try {
      if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
    } catch {
      // Ignore if already removed
    }
    try {
      if (fs.existsSync(trashedPath)) fs.unlinkSync(trashedPath);
    } catch {
      // Ignore
    }

    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  }

  // Helper to recursively trash or restore or delete a folder and all its descendants
  function setFolderTrashStateRecursive(folderId: string, trash: boolean, nowIso: string): void {
    db.prepare('UPDATE folders SET is_trashed = ?, trashed_at = ?, updated_at = ? WHERE id = ?').run(
      trash ? 1 : 0,
      trash ? nowIso : null,
      nowIso,
      folderId
    );

    const files = db
      .prepare('SELECT id, storage_name, relative_path, is_trashed FROM files WHERE folder_id = ?')
      .all(folderId) as { id: string; storage_name: string; relative_path: string; is_trashed: number }[];

    for (const f of files) {
      moveFileBetweenActiveAndTrash(f, trash, nowIso);
    }

    const children = db
      .prepare('SELECT id FROM folders WHERE parent_id = ?')
      .all(folderId) as { id: string }[];

    for (const child of children) {
      setFolderTrashStateRecursive(child.id, trash, nowIso);
    }
  }

  function moveFileBetweenActiveAndTrash(
    fileRow: { id: string; storage_name: string; relative_path: string; is_trashed: number },
    toTrash: boolean,
    nowIso: string
  ): void {
    const activePath = resolveSafePath(config.paths.files, fileRow.relative_path);
    const trashPath = resolveSafePath(config.paths.trash, fileRow.storage_name);

    if (toTrash && !fileRow.is_trashed) {
      if (fs.existsSync(activePath)) {
        fs.renameSync(activePath, trashPath);
      }
      db.prepare('UPDATE files SET is_trashed = 1, trashed_at = ?, updated_at = ? WHERE id = ?').run(
        nowIso,
        nowIso,
        fileRow.id
      );
    } else if (!toTrash && fileRow.is_trashed) {
      if (fs.existsSync(trashPath)) {
        fs.renameSync(trashPath, activePath);
      }
      db.prepare('UPDATE files SET is_trashed = 0, trashed_at = NULL, updated_at = ? WHERE id = ?').run(
        nowIso,
        fileRow.id
      );
    }
  }

  function permanentlyDeleteFolderRecursive(folderId: string): void {
    const files = db
      .prepare('SELECT id FROM files WHERE folder_id = ?')
      .all(folderId) as { id: string }[];
    for (const f of files) {
      permanentlyDeleteFile(f.id);
    }

    const children = db
      .prepare('SELECT id FROM folders WHERE parent_id = ?')
      .all(folderId) as { id: string }[];
    for (const child of children) {
      permanentlyDeleteFolderRecursive(child.id);
    }

    db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
  }

  // GET /api/v1/drive/items — List folders & files with filtering, search, sort, pagination
  router.get('/items', (req: Request, res: Response) => {
    try {
      const view = String(req.query.view || 'folder'); // 'folder' | 'recent' | 'starred' | 'trash' | 'category' | 'search'
      const rawFolderId = req.query.folderId ? String(req.query.folderId) : null;
      const folderId = rawFolderId && rawFolderId !== 'root' && rawFolderId !== 'null' ? rawFolderId : null;
      const search = req.query.search ? String(req.query.search).trim() : '';
      const category = req.query.category ? String(req.query.category).trim() : '';
      const sortBy = String(req.query.sortBy || 'name'); // 'name' | 'size' | 'date' | 'type'
      const sortDir = String(req.query.sortDir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
      const limit = Math.min(500, Math.max(10, parseInt(String(req.query.limit || '100'), 10)));
      const offset = (page - 1) * limit;

      const fileOrderMap: Record<string, string> = {
        name: `f.name COLLATE NOCASE ${sortDir}`,
        size: `f.size_bytes ${sortDir}`,
        date: `f.updated_at ${sortDir}`,
        type: `f.category ${sortDir}, f.name COLLATE NOCASE ASC`,
      };
      const folderOrderMap: Record<string, string> = {
        name: `d.name COLLATE NOCASE ${sortDir}`,
        size: `d.name COLLATE NOCASE ${sortDir}`,
        date: `d.updated_at ${sortDir}`,
        type: `d.name COLLATE NOCASE ${sortDir}`,
      };

      const fileOrderBy = fileOrderMap[sortBy] || fileOrderMap.name;
      const folderOrderBy = folderOrderMap[sortBy] || folderOrderMap.name;

      let folders: any[] = [];
      let files: any[] = [];
      let totalFiles = 0;

      if (view === 'trash') {
        folders = db
          .prepare(
            `SELECT d.*,
                    CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_starred,
                    (SELECT COUNT(*) FROM files cf WHERE cf.folder_id = d.id) as item_count
             FROM folders d
             LEFT JOIN starred_items s ON s.folder_id = d.id AND s.item_type = 'folder'
             WHERE d.is_trashed = 1
             ORDER BY d.trashed_at DESC`
          )
          .all();

        files = db
          .prepare(
            `SELECT f.*,
                    CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_starred
             FROM files f
             LEFT JOIN starred_items s ON s.file_id = f.id AND s.item_type = 'file'
             WHERE f.is_trashed = 1
             ORDER BY f.trashed_at DESC
             LIMIT ? OFFSET ?`
          )
          .all(limit, offset);

        totalFiles = (
          db.prepare('SELECT COUNT(*) as c FROM files WHERE is_trashed = 1').get() as { c: number }
        ).c;
      } else if (view === 'starred') {
        folders = db
          .prepare(
            `SELECT d.*, 1 as is_starred,
                    (SELECT COUNT(*) FROM files cf WHERE cf.folder_id = d.id AND cf.is_trashed = 0) as item_count,
                    (SELECT COALESCE(SUM(cf.size_bytes), 0) FROM files cf WHERE cf.folder_id = d.id AND cf.is_trashed = 0) as folder_size_bytes
             FROM folders d
             JOIN starred_items s ON s.folder_id = d.id AND s.item_type = 'folder'
             WHERE d.is_trashed = 0
             ORDER BY ${folderOrderBy}`
          )
          .all();

        files = db
          .prepare(
            `SELECT f.*, 1 as is_starred
             FROM files f
             JOIN starred_items s ON s.file_id = f.id AND s.item_type = 'file'
             WHERE f.is_trashed = 0
             ORDER BY ${fileOrderBy}
             LIMIT ? OFFSET ?`
          )
          .all(limit, offset);

        totalFiles = (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM files f
               JOIN starred_items s ON s.file_id = f.id AND s.item_type = 'file'
               WHERE f.is_trashed = 0`
            )
            .get() as { c: number }
        ).c;
      } else if (view === 'recent') {
        files = db
          .prepare(
            `SELECT f.*,
                    CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_starred,
                    d.name as folder_name
             FROM files f
             LEFT JOIN starred_items s ON s.file_id = f.id AND s.item_type = 'file'
             LEFT JOIN folders d ON d.id = f.folder_id
             WHERE f.is_trashed = 0
             ORDER BY f.created_at DESC
             LIMIT ? OFFSET ?`
          )
          .all(limit, offset);

        totalFiles = (
          db.prepare('SELECT COUNT(*) as c FROM files WHERE is_trashed = 0').get() as { c: number }
        ).c;
      } else if (search || category || view === 'category' || view === 'search') {
        const conditions: string[] = ['f.is_trashed = 0'];
        const params: any[] = [];

        if (search) {
          conditions.push('f.name LIKE ?');
          params.push(`%${search}%`);
        }
        if (category && category !== 'all') {
          conditions.push('f.category = ?');
          params.push(category);
        }

        const whereClause = conditions.join(' AND ');

        if (search && (!category || category === 'all')) {
          folders = db
            .prepare(
              `SELECT d.*,
                      CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_starred,
                      (SELECT COUNT(*) FROM files cf WHERE cf.folder_id = d.id AND cf.is_trashed = 0) as item_count,
                      (SELECT COALESCE(SUM(cf.size_bytes), 0) FROM files cf WHERE cf.folder_id = d.id AND cf.is_trashed = 0) as folder_size_bytes
               FROM folders d
               LEFT JOIN starred_items s ON s.folder_id = d.id AND s.item_type = 'folder'
               WHERE d.is_trashed = 0 AND d.name LIKE ?
               ORDER BY ${folderOrderBy}`
            )
            .all(`%${search}%`);
        }

        files = db
          .prepare(
            `SELECT f.*,
                    CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_starred,
                    d.name as folder_name
             FROM files f
             LEFT JOIN starred_items s ON s.file_id = f.id AND s.item_type = 'file'
             LEFT JOIN folders d ON d.id = f.folder_id
             WHERE ${whereClause}
             ORDER BY ${fileOrderBy}
             LIMIT ? OFFSET ?`
          )
          .all(...params, limit, offset);

        totalFiles = (
          db.prepare(`SELECT COUNT(*) as c FROM files f WHERE ${whereClause}`).get(...params) as {
            c: number;
          }
        ).c;
      } else {
        // Standard directory listing inside folderId (or root when folderId === null)
        folders = db
          .prepare(
            `SELECT d.*,
                    CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_starred,
                    (SELECT COUNT(*) FROM files cf WHERE cf.folder_id = d.id AND cf.is_trashed = 0) as item_count,
                    (SELECT COALESCE(SUM(cf.size_bytes), 0) FROM files cf WHERE cf.folder_id = d.id AND cf.is_trashed = 0) as folder_size_bytes
             FROM folders d
             LEFT JOIN starred_items s ON s.folder_id = d.id AND s.item_type = 'folder'
             WHERE d.is_trashed = 0
               AND (d.parent_id = ? OR (d.parent_id IS NULL AND ? IS NULL))
             ORDER BY ${folderOrderBy}`
          )
          .all(folderId, folderId);

        files = db
          .prepare(
            `SELECT f.*,
                    CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_starred
             FROM files f
             LEFT JOIN starred_items s ON s.file_id = f.id AND s.item_type = 'file'
             WHERE f.is_trashed = 0
               AND (f.folder_id = ? OR (f.folder_id IS NULL AND ? IS NULL))
             ORDER BY ${fileOrderBy}
             LIMIT ? OFFSET ?`
          )
          .all(folderId, folderId, limit, offset);

        totalFiles = (
          db
            .prepare(
              `SELECT COUNT(*) as c FROM files f
               WHERE f.is_trashed = 0
                 AND (f.folder_id = ? OR (f.folder_id IS NULL AND ? IS NULL))`
            )
            .get(folderId, folderId) as { c: number }
        ).c;
      }

      const breadcrumbs = getBreadcrumbs(folderId);

      res.json({
        folderId,
        breadcrumbs,
        folders: folders.map((d) => ({
          id: d.id,
          parentId: d.parent_id,
          name: d.name,
          isTrashed: Boolean(d.is_trashed),
          trashedAt: d.trashed_at,
          isStarred: Boolean(d.is_starred),
          itemCount: d.item_count ?? 0,
          sizeBytes: d.folder_size_bytes ?? 0,
          createdAt: d.created_at,
          updatedAt: d.updated_at,
        })),
        files: files.map((f) => ({
          id: f.id,
          folderId: f.folder_id,
          folderName: f.folder_name || null,
          name: f.name,
          mimeType: f.mime_type,
          category: f.category,
          extension: f.extension,
          sizeBytes: f.size_bytes,
          sha256: f.sha256,
          isTrashed: Boolean(f.is_trashed),
          trashedAt: f.trashed_at,
          isStarred: Boolean(f.is_starred),
          canPreviewInline: isSafeInlinePreviewMime(f.mime_type),
          uploadedViaLinkId: f.uploaded_via_link_id,
          createdAt: f.created_at,
          updatedAt: f.updated_at,
        })),
        pagination: {
          page,
          limit,
          totalFiles,
          totalPages: Math.max(1, Math.ceil(totalFiles / limit)),
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to list drive items', code: 'LIST_FAILED' });
    }
  });

  // GET /api/v1/drive/folders/tree — List all non-trashed folders for folder picker / move dialogs
  router.get('/folders/tree', (_req: Request, res: Response) => {
    const rows = db
      .prepare('SELECT id, parent_id, name, created_at FROM folders WHERE is_trashed = 0 ORDER BY name COLLATE NOCASE ASC')
      .all() as { id: string; parent_id: string | null; name: string; created_at: string }[];

    res.json({
      folders: rows.map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        name: r.name,
        createdAt: r.created_at,
      })),
    });
  });

  // POST /api/v1/drive/folders — Create a new folder
  router.post('/folders', (req: Request, res: Response) => {
    try {
      assertStorageHealthy(config);
      const parsed = createFolderSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid folder name', details: parsed.error.flatten(), code: 'VALIDATION_ERROR' });
        return;
      }

      const parentId =
        parsed.data.parentId && parsed.data.parentId !== 'root' && parsed.data.parentId !== 'null'
          ? parsed.data.parentId
          : null;

      if (parentId) {
        const parentExists = db
          .prepare('SELECT id FROM folders WHERE id = ? AND is_trashed = 0')
          .get(parentId);
        if (!parentExists) {
          res.status(404).json({ error: 'Parent folder not found', code: 'FOLDER_NOT_FOUND' });
          return;
        }
      }

      const desiredName = sanitizeDisplayName(parsed.data.name);
      const existingSiblings = db
        .prepare(
          `SELECT name FROM folders
           WHERE (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))
             AND is_trashed = 0`
        )
        .all(parentId, parentId) as { name: string }[];

      const uniqueName = resolveDuplicateDisplayName(
        desiredName,
        new Set(existingSiblings.map((s) => s.name))
      );

      const folderId = crypto.randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO folders (id, parent_id, name, is_trashed, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`
      ).run(folderId, parentId, uniqueName, now, now);

      logAuditEvent(db, {
        eventType: 'FOLDER_CREATED',
        actor: req.admin!.username,
        targetType: 'folder',
        targetId: folderId,
        ipAddress: req.ip,
        details: { name: uniqueName, parentId },
      });

      res.status(201).json({
        folder: {
          id: folderId,
          parentId,
          name: uniqueName,
          isTrashed: false,
          isStarred: false,
          itemCount: 0,
          sizeBytes: 0,
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (err: any) {
      if (err instanceof StorageGuardError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err.message || 'Failed to create folder', code: 'CREATE_FOLDER_FAILED' });
    }
  });

  // POST /api/v1/drive/upload — Streaming file & folder upload
  router.post('/upload', async (req: Request, res: Response) => {
    try {
      const queryFolderId = req.query.folderId ? String(req.query.folderId) : null;
      const defaultFolderId =
        queryFolderId && queryFolderId !== 'root' && queryFolderId !== 'null' ? queryFolderId : null;

      const maxSingleFileBytes = parseInt(
        getSetting(db, 'max_upload_file_size_bytes', String(config.maxUploadFileSizeBytes)),
        10
      );

      const uploaded = await handleStreamingMultipartUpload({
        req,
        db,
        config,
        defaultFolderId,
        allowRelativePaths: true,
        maxSingleFileBytes,
      });

      const now = new Date().toISOString();
      const insertTransfer = db.prepare(
        `INSERT INTO transfer_activity (id, direction, actor_type, file_id, folder_id, item_name, bytes_transferred, ip_address, status, created_at)
         VALUES (?, 'upload', 'admin', ?, ?, ?, ?, ?, 'completed', ?)`
      );

      for (const item of uploaded) {
        insertTransfer.run(
          `tr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          item.id,
          item.folderId,
          item.name,
          item.sizeBytes,
          req.ip || null,
          now
        );
      }

      logAuditEvent(db, {
        eventType: 'ADMIN_FILES_UPLOADED',
        actor: req.admin!.username,
        targetType: 'folder',
        targetId: defaultFolderId || 'root',
        ipAddress: req.ip,
        details: {
          count: uploaded.length,
          totalBytes: uploaded.reduce((sum, f) => sum + f.sizeBytes, 0),
        },
      });

      res.status(201).json({ files: uploaded });
    } catch (err: any) {
      if (err instanceof StorageGuardError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err.message || 'Upload failed', code: 'UPLOAD_FAILED' });
    }
  });

  // GET /api/v1/drive/files/:id/content — Stream file download or inline preview
  router.get('/files/:id/content', (req: Request, res: Response) => {
    try {
      const fileId = req.params.id;
      const wantInline = req.query.inline === 'true' || req.query.inline === '1';

      const fileRow = db
        .prepare('SELECT * FROM files WHERE id = ?')
        .get(fileId) as
        | {
            id: string;
            folder_id: string | null;
            name: string;
            storage_name: string;
            relative_path: string;
            mime_type: string;
            size_bytes: number;
            is_trashed: number;
          }
        | undefined;

      if (!fileRow) {
        res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
        return;
      }

      const diskPath = fileRow.is_trashed
        ? resolveSafePath(config.paths.trash, fileRow.storage_name)
        : resolveSafePath(config.paths.files, fileRow.relative_path);

      const safeInline = wantInline && isSafeInlinePreviewMime(fileRow.mime_type);

      // Log download activity if not a range continuation or inline preview
      if (!wantInline && !req.headers.range) {
        db.prepare(
          `INSERT INTO transfer_activity (id, direction, actor_type, file_id, folder_id, item_name, bytes_transferred, ip_address, status, created_at)
           VALUES (?, 'download', 'admin', ?, ?, ?, ?, ?, 'completed', ?)`
        ).run(
          `tr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
          fileRow.id,
          fileRow.folder_id,
          fileRow.name,
          fileRow.size_bytes,
          req.ip || null,
          new Date().toISOString()
        );
      }

      streamFileResponse({
        req,
        res,
        diskPath,
        displayName: fileRow.name,
        mimeType: fileRow.mime_type,
        sizeBytes: fileRow.size_bytes,
        inline: safeInline,
      });
    } catch (err: any) {
      if (err instanceof StorageGuardError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: 'Failed to stream file', code: 'STREAM_ERROR' });
    }
  });

  // GET /api/v1/drive/folders/:id/download — Stream folder as ZIP archive
  router.get('/folders/:id/download', async (req: Request, res: Response) => {
    try {
      const folderId = req.params.id;
      const folder = db
        .prepare('SELECT id, name FROM folders WHERE id = ? AND is_trashed = 0')
        .get(folderId) as { id: string; name: string } | undefined;

      if (!folder) {
        res.status(404).json({ error: 'Folder not found', code: 'FOLDER_NOT_FOUND' });
        return;
      }

      const totalBytes = await streamFolderZipArchive({
        res,
        db,
        config,
        rootFolderId: folder.id,
        rootFolderName: folder.name,
      });

      db.prepare(
        `INSERT INTO transfer_activity (id, direction, actor_type, folder_id, item_name, bytes_transferred, ip_address, status, created_at)
         VALUES (?, 'download', 'admin', ?, ?, ?, ?, 'completed', ?)`
      ).run(
        `tr_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        folder.id,
        `${folder.name}.zip`,
        totalBytes,
        req.ip || null,
        new Date().toISOString()
      );
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Failed to archive folder', code: 'ARCHIVE_ERROR' });
      }
    }
  });

  // PATCH /api/v1/drive/files/:id/rename
  router.patch('/files/:id/rename', (req: Request, res: Response) => {
    const parsed = renameItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid filename', code: 'VALIDATION_ERROR' });
      return;
    }

    const fileRow = db
      .prepare('SELECT id, folder_id, name FROM files WHERE id = ?')
      .get(req.params.id) as { id: string; folder_id: string | null; name: string } | undefined;

    if (!fileRow) {
      res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
      return;
    }

    const desiredName = sanitizeDisplayName(parsed.data.name);
    const siblings = db
      .prepare(
        `SELECT name FROM files
         WHERE (folder_id = ? OR (folder_id IS NULL AND ? IS NULL))
           AND id != ? AND is_trashed = 0`
      )
      .all(fileRow.folder_id, fileRow.folder_id, fileRow.id) as { name: string }[];

    const finalName = resolveDuplicateDisplayName(
      desiredName,
      new Set(siblings.map((s) => s.name))
    );
    const ext = path.extname(finalName).toLowerCase();
    const now = new Date().toISOString();

    db.prepare('UPDATE files SET name = ?, extension = ?, updated_at = ? WHERE id = ?').run(
      finalName,
      ext,
      now,
      fileRow.id
    );

    logAuditEvent(db, {
      eventType: 'FILE_RENAMED',
      actor: req.admin!.username,
      targetType: 'file',
      targetId: fileRow.id,
      ipAddress: req.ip,
      details: { from: fileRow.name, to: finalName },
    });

    res.json({ id: fileRow.id, name: finalName, updatedAt: now });
  });

  // PATCH /api/v1/drive/folders/:id/rename
  router.patch('/folders/:id/rename', (req: Request, res: Response) => {
    const parsed = renameItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid folder name', code: 'VALIDATION_ERROR' });
      return;
    }

    const folderRow = db
      .prepare('SELECT id, parent_id, name FROM folders WHERE id = ?')
      .get(req.params.id) as { id: string; parent_id: string | null; name: string } | undefined;

    if (!folderRow) {
      res.status(404).json({ error: 'Folder not found', code: 'FOLDER_NOT_FOUND' });
      return;
    }

    const desiredName = sanitizeDisplayName(parsed.data.name);
    const siblings = db
      .prepare(
        `SELECT name FROM folders
         WHERE (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))
           AND id != ? AND is_trashed = 0`
      )
      .all(folderRow.parent_id, folderRow.parent_id, folderRow.id) as { name: string }[];

    const finalName = resolveDuplicateDisplayName(
      desiredName,
      new Set(siblings.map((s) => s.name))
    );
    const now = new Date().toISOString();

    db.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(
      finalName,
      now,
      folderRow.id
    );

    logAuditEvent(db, {
      eventType: 'FOLDER_RENAMED',
      actor: req.admin!.username,
      targetType: 'folder',
      targetId: folderRow.id,
      ipAddress: req.ip,
      details: { from: folderRow.name, to: finalName },
    });

    res.json({ id: folderRow.id, name: finalName, updatedAt: now });
  });

  // PATCH /api/v1/drive/files/:id/move
  router.patch('/files/:id/move', (req: Request, res: Response) => {
    const parsed = moveItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid target folder', code: 'VALIDATION_ERROR' });
      return;
    }

    const targetFolderId =
      parsed.data.targetFolderId && parsed.data.targetFolderId !== 'root'
        ? parsed.data.targetFolderId
        : null;

    if (targetFolderId) {
      const targetFolder = db
        .prepare('SELECT id FROM folders WHERE id = ? AND is_trashed = 0')
        .get(targetFolderId);
      if (!targetFolder) {
        res.status(404).json({ error: 'Target folder not found', code: 'FOLDER_NOT_FOUND' });
        return;
      }
    }

    const fileRow = db
      .prepare('SELECT id, name, folder_id FROM files WHERE id = ?')
      .get(req.params.id) as { id: string; name: string; folder_id: string | null } | undefined;

    if (!fileRow) {
      res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
      return;
    }

    const siblings = db
      .prepare(
        `SELECT name FROM files
         WHERE (folder_id = ? OR (folder_id IS NULL AND ? IS NULL))
           AND id != ? AND is_trashed = 0`
      )
      .all(targetFolderId, targetFolderId, fileRow.id) as { name: string }[];

    const finalName = resolveDuplicateDisplayName(
      fileRow.name,
      new Set(siblings.map((s) => s.name))
    );
    const now = new Date().toISOString();

    db.prepare('UPDATE files SET folder_id = ?, name = ?, updated_at = ? WHERE id = ?').run(
      targetFolderId,
      finalName,
      now,
      fileRow.id
    );

    logAuditEvent(db, {
      eventType: 'FILE_MOVED',
      actor: req.admin!.username,
      targetType: 'file',
      targetId: fileRow.id,
      ipAddress: req.ip,
      details: { fromFolderId: fileRow.folder_id, toFolderId: targetFolderId },
    });

    res.json({ id: fileRow.id, folderId: targetFolderId, name: finalName, updatedAt: now });
  });

  // PATCH /api/v1/drive/folders/:id/move
  router.patch('/folders/:id/move', (req: Request, res: Response) => {
    const parsed = moveItemSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid target folder', code: 'VALIDATION_ERROR' });
      return;
    }

    const folderId = String(req.params.id);
    const targetFolderId =
      parsed.data.targetFolderId && parsed.data.targetFolderId !== 'root'
        ? parsed.data.targetFolderId
        : null;

    if (targetFolderId === folderId || isFolderDescendant(folderId, targetFolderId)) {
      res.status(400).json({
        error: 'Cannot move a folder into itself or one of its subfolders',
        code: 'INVALID_FOLDER_MOVE',
      });
      return;
    }

    const folderRow = db
      .prepare('SELECT id, name, parent_id FROM folders WHERE id = ?')
      .get(folderId) as { id: string; name: string; parent_id: string | null } | undefined;

    if (!folderRow) {
      res.status(404).json({ error: 'Folder not found', code: 'FOLDER_NOT_FOUND' });
      return;
    }

    const siblings = db
      .prepare(
        `SELECT name FROM folders
         WHERE (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))
           AND id != ? AND is_trashed = 0`
      )
      .all(targetFolderId, targetFolderId, folderRow.id) as { name: string }[];

    const finalName = resolveDuplicateDisplayName(
      folderRow.name,
      new Set(siblings.map((s) => s.name))
    );
    const now = new Date().toISOString();

    db.prepare('UPDATE folders SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?').run(
      targetFolderId,
      finalName,
      now,
      folderRow.id
    );

    res.json({ id: folderRow.id, parentId: targetFolderId, name: finalName, updatedAt: now });
  });

  // POST /api/v1/drive/files/:id/copy — Duplicate a file on the HDD
  router.post('/files/:id/copy', (req: Request, res: Response) => {
    try {
      const fileRow = db
        .prepare('SELECT * FROM files WHERE id = ? AND is_trashed = 0')
        .get(req.params.id) as any;

      if (!fileRow) {
        res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
        return;
      }

      assertStorageHealthy(config, fileRow.size_bytes);

      const sourcePath = resolveSafePath(config.paths.files, fileRow.relative_path);
      if (!fs.existsSync(sourcePath)) {
        res.status(404).json({ error: 'Source file missing on HDD', code: 'FILE_MISSING_ON_DISK' });
        return;
      }

      const targetFolderId =
        req.body?.targetFolderId !== undefined
          ? req.body.targetFolderId === 'root'
            ? null
            : req.body.targetFolderId
          : fileRow.folder_id;

      const siblings = db
        .prepare(
          `SELECT name FROM files
           WHERE (folder_id = ? OR (folder_id IS NULL AND ? IS NULL))
             AND is_trashed = 0`
        )
        .all(targetFolderId, targetFolderId) as { name: string }[];

      const ext = path.extname(fileRow.name);
      const base = path.basename(fileRow.name, ext);
      const copyDesired = `${base} (Copy)${ext}`;
      const newDisplayName = resolveDuplicateDisplayName(
        copyDesired,
        new Set(siblings.map((s) => s.name))
      );

      const newStorageName = generateSafeStorageFilename(newDisplayName);
      const destPath = resolveSafePath(config.paths.files, newStorageName);

      fs.copyFileSync(sourcePath, destPath);
      const lstat = fs.lstatSync(destPath);
      const newId = crypto.randomUUID();
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO files (
           id, folder_id, name, storage_name, relative_path, mime_type,
           category, extension, size_bytes, sha256, is_trashed, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(
        newId,
        targetFolderId,
        newDisplayName,
        newStorageName,
        newStorageName,
        fileRow.mime_type,
        fileRow.category,
        fileRow.extension,
        lstat.size,
        fileRow.sha256,
        now,
        now
      );

      db.prepare(
        `INSERT INTO file_metadata (file_id, original_filename, detected_mime, inode, mtime_ms, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(newId, newDisplayName, fileRow.mime_type, Number(lstat.ino), Math.round(lstat.mtimeMs), now);

      logAuditEvent(db, {
        eventType: 'FILE_COPIED',
        actor: req.admin!.username,
        targetType: 'file',
        targetId: newId,
        ipAddress: req.ip,
        details: { sourceFileId: fileRow.id, newName: newDisplayName },
      });

      res.status(201).json({
        file: {
          id: newId,
          folderId: targetFolderId,
          name: newDisplayName,
          mimeType: fileRow.mime_type,
          category: fileRow.category,
          extension: fileRow.extension,
          sizeBytes: lstat.size,
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (err: any) {
      if (err instanceof StorageGuardError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err.message || 'Failed to copy file', code: 'COPY_FAILED' });
    }
  });

  // POST /api/v1/drive/star — Toggle star on file or folder
  router.post('/star', (req: Request, res: Response) => {
    const { itemType, itemId, starred } = req.body || {};
    if ((itemType !== 'file' && itemType !== 'folder') || !itemId) {
      res.status(400).json({ error: 'Invalid star parameters', code: 'VALIDATION_ERROR' });
      return;
    }

    const now = new Date().toISOString();
    if (starred) {
      const col = itemType === 'file' ? 'file_id' : 'folder_id';
      db.prepare(
        `INSERT OR IGNORE INTO starred_items (id, item_type, ${col}, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(crypto.randomUUID(), itemType, itemId, now);
    } else {
      const col = itemType === 'file' ? 'file_id' : 'folder_id';
      db.prepare(`DELETE FROM starred_items WHERE item_type = ? AND ${col} = ?`).run(itemType, itemId);
    }

    res.json({ itemType, itemId, isStarred: Boolean(starred) });
  });

  // POST /api/v1/drive/bulk — Multi-select and bulk operations (trash, restore, delete, move, star, unstar)
  router.post('/bulk', (req: Request, res: Response) => {
    try {
      assertStorageHealthy(config);
      const parsed = bulkActionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid bulk action request', code: 'VALIDATION_ERROR' });
        return;
      }

      const { action, fileIds, folderIds, targetFolderId } = parsed.data;
      const now = new Date().toISOString();

      const tx = db.transaction(() => {
        if (action === 'trash' || action === 'restore') {
          const toTrash = action === 'trash';
          for (const fid of fileIds) {
            const f = db
              .prepare('SELECT id, storage_name, relative_path, is_trashed FROM files WHERE id = ?')
              .get(fid) as any;
            if (f) moveFileBetweenActiveAndTrash(f, toTrash, now);
          }
          for (const did of folderIds) {
            setFolderTrashStateRecursive(did, toTrash, now);
          }
        } else if (action === 'delete') {
          for (const fid of fileIds) {
            permanentlyDeleteFile(fid);
          }
          for (const did of folderIds) {
            permanentlyDeleteFolderRecursive(did);
          }
        } else if (action === 'move') {
          const destFolderId = targetFolderId && targetFolderId !== 'root' ? targetFolderId : null;
          for (const fid of fileIds) {
            db.prepare('UPDATE files SET folder_id = ?, updated_at = ? WHERE id = ?').run(
              destFolderId,
              now,
              fid
            );
          }
          for (const did of folderIds) {
            if (did !== destFolderId && !isFolderDescendant(did, destFolderId)) {
              db.prepare('UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?').run(
                destFolderId,
                now,
                did
              );
            }
          }
        } else if (action === 'star' || action === 'unstar') {
          const isStar = action === 'star';
          for (const fid of fileIds) {
            if (isStar) {
              db.prepare(
                `INSERT OR IGNORE INTO starred_items (id, item_type, file_id, created_at) VALUES (?, 'file', ?, ?)`
              ).run(crypto.randomUUID(), fid, now);
            } else {
              db.prepare(`DELETE FROM starred_items WHERE item_type = 'file' AND file_id = ?`).run(fid);
            }
          }
          for (const did of folderIds) {
            if (isStar) {
              db.prepare(
                `INSERT OR IGNORE INTO starred_items (id, item_type, folder_id, created_at) VALUES (?, 'folder', ?, ?)`
              ).run(crypto.randomUUID(), did, now);
            } else {
              db.prepare(`DELETE FROM starred_items WHERE item_type = 'folder' AND folder_id = ?`).run(did);
            }
          }
        }
      });

      tx();

      logAuditEvent(db, {
        eventType: `BULK_${action.toUpperCase()}`,
        actor: req.admin!.username,
        ipAddress: req.ip,
        details: { fileCount: fileIds.length, folderCount: folderIds.length },
      });

      res.json({ success: true, action, affectedFiles: fileIds.length, affectedFolders: folderIds.length });
    } catch (err: any) {
      if (err instanceof StorageGuardError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: err.message || 'Bulk action failed', code: 'BULK_ACTION_FAILED' });
    }
  });

  // DELETE /api/v1/drive/trash/empty — Empty entire trash permanently
  router.delete('/trash/empty', (req: Request, res: Response) => {
    try {
      assertStorageHealthy(config);
      const trashedFiles = db
        .prepare('SELECT id FROM files WHERE is_trashed = 1')
        .all() as { id: string }[];
      const trashedFolders = db
        .prepare('SELECT id FROM folders WHERE is_trashed = 1')
        .all() as { id: string }[];

      const tx = db.transaction(() => {
        for (const f of trashedFiles) {
          permanentlyDeleteFile(f.id);
        }
        for (const d of trashedFolders) {
          permanentlyDeleteFolderRecursive(d.id);
        }
      });

      tx();

      logAuditEvent(db, {
        eventType: 'TRASH_EMPTIED',
        actor: req.admin!.username,
        ipAddress: req.ip,
        details: { deletedFiles: trashedFiles.length, deletedFolders: trashedFolders.length },
      });

      res.json({
        success: true,
        deletedFiles: trashedFiles.length,
        deletedFolders: trashedFolders.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to empty trash', code: 'EMPTY_TRASH_FAILED' });
    }
  });

  return router;
}
