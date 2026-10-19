import fs from 'node:fs';
import path from 'node:path';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { DbInstance, getSetting, setSetting, logAuditEvent } from '../db/database.js';
import { AppConfig } from '../config.js';
import { requireAdminAuth } from '../services/authService.js';
import { getDiskHealthAndSpace } from '../storage/mountGuard.js';
import { IndexerService } from '../services/indexerService.js';

const updateSettingsSchema = z.object({
  guestUploadsEnabled: z.boolean().optional(),
  maxUploadFileSizeBytes: z.number().int().positive().optional(),
  defaultGuestQuotaBytes: z.number().int().positive().optional(),
  totalGuestUploadQuotaBytes: z.number().int().positive().optional(),
  maxConcurrentGuestUploads: z.number().int().min(1).max(20).optional(),
  trackDownloads: z.boolean().optional(),
  indexerIntervalMinutes: z.number().int().min(0).max(1440).optional(),
});

export function createSystemRouter(
  db: DbInstance,
  config: AppConfig,
  indexer: IndexerService
): Router {
  const router = Router();
  router.use(requireAdminAuth(db, config));

  // GET /api/v1/system/dashboard — Complete live dashboard statistics and analytics
  router.get('/dashboard', (_req: Request, res: Response) => {
    const disk = getDiskHealthAndSpace(config);

    // Core counts
    const summaryCounts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM files WHERE is_trashed = 0) as total_files,
           (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE is_trashed = 0) as active_indexed_bytes,
           (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE is_trashed = 1) as trash_bytes,
           (SELECT COUNT(*) FROM files WHERE is_trashed = 1) as trashed_files,
           (SELECT COUNT(*) FROM folders WHERE is_trashed = 0) as total_folders,
           (SELECT COUNT(*) FROM files WHERE is_trashed = 0 AND created_at >= datetime('now', '-7 days')) as recent_uploads_7d,
           (SELECT COUNT(*) FROM share_links WHERE is_revoked = 0) as total_shared_links,
           (SELECT COUNT(*) FROM share_links sl
            JOIN share_permissions sp ON sp.link_id = sl.id
            WHERE sl.is_revoked = 0 AND sl.is_enabled = 1 AND sp.allow_upload = 1
              AND (sl.expires_at IS NULL OR sl.expires_at > datetime('now'))) as active_upload_links,
           (SELECT COUNT(*) FROM transfer_activity WHERE direction = 'download' AND status = 'completed') as total_downloads,
           (SELECT COUNT(*) FROM transfer_activity WHERE direction = 'upload' AND status = 'completed') as total_uploads`
      )
      .get() as {
      total_files: number;
      active_indexed_bytes: number;
      trash_bytes: number;
      trashed_files: number;
      total_folders: number;
      recent_uploads_7d: number;
      total_shared_links: number;
      active_upload_links: number;
      total_downloads: number;
      total_uploads: number;
    };

    const totalIndexedBytes = summaryCounts.active_indexed_bytes + summaryCounts.trash_bytes;
    const unindexedSystemBytes = Math.max(0, disk.usedBytes - totalIndexedBytes);

    // File-type distribution by count and storage size
    const categoryStats = db
      .prepare(
        `SELECT category,
                COUNT(*) as count,
                COALESCE(SUM(size_bytes), 0) as total_bytes
         FROM files
         WHERE is_trashed = 0
         GROUP BY category
         ORDER BY total_bytes DESC`
      )
      .all() as { category: string; count: number; total_bytes: number }[];

    // Storage growth over time (snapshots + current live point)
    const snapshots = db
      .prepare(
        `SELECT recorded_at, used_disk_bytes, indexed_files_bytes, total_files_count
         FROM storage_snapshots
         ORDER BY recorded_at ASC
         LIMIT 60`
      )
      .all() as {
      recorded_at: string;
      used_disk_bytes: number;
      indexed_files_bytes: number;
      total_files_count: number;
    }[];

    const growthSeries = [
      ...snapshots.map((s) => ({
        timestamp: s.recorded_at,
        usedDiskBytes: s.used_disk_bytes,
        indexedFilesBytes: s.indexed_files_bytes,
        totalFilesCount: s.total_files_count,
      })),
      {
        timestamp: new Date().toISOString(),
        usedDiskBytes: disk.usedBytes,
        indexedFilesBytes: totalIndexedBytes,
        totalFilesCount: summaryCounts.total_files,
      },
    ];

    // Largest files
    const largestFiles = db
      .prepare(
        `SELECT f.id, f.name, f.category, f.mime_type, f.size_bytes, f.created_at, d.name as folder_name
         FROM files f
         LEFT JOIN folders d ON d.id = f.folder_id
         WHERE f.is_trashed = 0
         ORDER BY f.size_bytes DESC
         LIMIT 10`
      )
      .all() as any[];

    // Largest folders by indexed file size
    const largestFolders = db
      .prepare(
        `SELECT d.id, d.name, d.created_at,
                COUNT(f.id) as file_count,
                COALESCE(SUM(f.size_bytes), 0) as total_bytes
         FROM folders d
         LEFT JOIN files f ON f.folder_id = d.id AND f.is_trashed = 0
         WHERE d.is_trashed = 0
         GROUP BY d.id
         ORDER BY total_bytes DESC
         LIMIT 10`
      )
      .all() as any[];

    // Recent upload and download activity
    const recentTransfers = db
      .prepare(
        `SELECT id, direction, actor_type, item_name, bytes_transferred, ip_address, status, created_at
         FROM transfer_activity
         ORDER BY created_at DESC
         LIMIT 20`
      )
      .all() as any[];

    // Recent file operations / audit events
    const recentOperations = db
      .prepare(
        `SELECT id, event_type, actor, target_type, target_id, ip_address, details, created_at
         FROM audit_events
         ORDER BY created_at DESC
         LIMIT 20`
      )
      .all() as any[];

    // Indexing status
    const lastScanAt = getSetting(db, 'last_successful_scan_at', '');
    let lastScanErrors: string[] = [];
    try {
      lastScanErrors = JSON.parse(getSetting(db, 'last_scan_errors', '[]'));
    } catch {
      lastScanErrors = [];
    }

    const recentJobs = db
      .prepare(
        `SELECT id, job_type, status, progress_percent, scanned_files, scanned_bytes, errors_count, started_at, completed_at
         FROM background_jobs
         ORDER BY created_at DESC
         LIMIT 5`
      )
      .all();

    res.json({
      disk: {
        totalBytes: disk.totalBytes,
        usedBytes: disk.usedBytes,
        availableBytes: disk.availableBytes,
        usagePercent: disk.usagePercent,
        activeIndexedBytes: summaryCounts.active_indexed_bytes,
        trashBytes: summaryCounts.trash_bytes,
        totalIndexedBytes,
        unindexedSystemBytes,
        isMounted: disk.isMounted,
        isWritable: disk.isWritable,
        identityVerified: disk.identityVerified,
        mountPath: config.paths.root,
        mountError: disk.mountError,
        lastCheckedAt: disk.lastCheckedAt,
      },
      summary: {
        totalFiles: summaryCounts.total_files,
        trashedFiles: summaryCounts.trashed_files,
        totalFolders: summaryCounts.total_folders,
        recentUploads7d: summaryCounts.recent_uploads_7d,
        totalSharedLinks: summaryCounts.total_shared_links,
        activeUploadLinks: summaryCounts.active_upload_links,
        totalDownloads: summaryCounts.total_downloads,
        totalUploads: summaryCounts.total_uploads,
        trackDownloadsEnabled: getSetting(db, 'track_downloads', 'true') === 'true',
        guestUploadsEnabled: getSetting(db, 'guest_uploads_enabled', 'true') === 'true',
      },
      categoryDistribution: categoryStats.map((c) => ({
        category: c.category,
        count: c.count,
        totalBytes: c.total_bytes,
      })),
      storageGrowth: growthSeries,
      largestFiles: largestFiles.map((f) => ({
        id: f.id,
        name: f.name,
        folderName: f.folder_name || 'Root Drive',
        category: f.category,
        mimeType: f.mime_type,
        sizeBytes: f.size_bytes,
        createdAt: f.created_at,
      })),
      largestFolders: largestFolders.map((d) => ({
        id: d.id,
        name: d.name,
        fileCount: d.file_count,
        totalBytes: d.total_bytes,
        createdAt: d.created_at,
      })),
      recentTransfers: recentTransfers.map((t) => ({
        id: t.id,
        direction: t.direction,
        actorType: t.actor_type,
        itemName: t.item_name,
        bytesTransferred: t.bytes_transferred,
        ipAddress: t.ip_address,
        status: t.status,
        createdAt: t.created_at,
      })),
      recentOperations: recentOperations.map((op) => ({
        id: op.id,
        eventType: op.event_type,
        actor: op.actor,
        targetType: op.target_type,
        targetId: op.target_id,
        ipAddress: op.ip_address,
        details: op.details,
        createdAt: op.created_at,
      })),
      indexing: {
        isRunning: indexer.isRunning(),
        lastSuccessfulScanAt: lastScanAt || null,
        lastScanErrors,
        recentJobs,
      },
    });
  });

  // POST /api/v1/system/indexer/scan — Trigger manual storage rescan
  router.post('/indexer/scan', async (req: Request, res: Response) => {
    try {
      const result = await indexer.runScan('manual');
      logAuditEvent(db, {
        eventType: 'MANUAL_INDEX_SCAN',
        actor: req.admin!.username,
        ipAddress: req.ip,
        details: {
          scannedFiles: result.scannedFiles,
          addedUntrackedFiles: result.addedUntrackedFiles,
          removedMissingFiles: result.removedMissingFiles,
        },
      });
      res.json({ scan: result });
    } catch (err: any) {
      res.status(409).json({ error: err.message || 'Scan failed', code: 'SCAN_IN_PROGRESS' });
    }
  });

  // GET /api/v1/system/settings — Retrieve admin settings
  router.get('/settings', (_req: Request, res: Response) => {
    const guestUploadedTotal = (
      db
        .prepare('SELECT COALESCE(SUM(size_bytes), 0) as total FROM guest_upload_records')
        .get() as { total: number }
    ).total;

    res.json({
      settings: {
        guestUploadsEnabled: getSetting(db, 'guest_uploads_enabled', 'true') === 'true',
        maxUploadFileSizeBytes: parseInt(
          getSetting(db, 'max_upload_file_size_bytes', String(config.maxUploadFileSizeBytes)),
          10
        ),
        defaultGuestQuotaBytes: parseInt(
          getSetting(db, 'default_guest_quota_bytes', String(config.defaultGuestQuotaBytes)),
          10
        ),
        totalGuestUploadQuotaBytes: parseInt(
          getSetting(db, 'total_guest_upload_quota_bytes', String(50 * 1024 * 1024 * 1024)),
          10
        ),
        currentTotalGuestUploadedBytes: guestUploadedTotal,
        maxConcurrentGuestUploads: parseInt(
          getSetting(db, 'max_concurrent_guest_uploads', String(config.maxConcurrentGuestUploads)),
          10
        ),
        trackDownloads: getSetting(db, 'track_downloads', 'true') === 'true',
        indexerIntervalMinutes: parseInt(
          getSetting(db, 'indexer_interval_minutes', String(config.indexerIntervalMinutes)),
          10
        ),
      },
      paths: {
        root: config.paths.root,
        files: config.paths.files,
        database: config.paths.database,
        temp: config.paths.temp,
        backups: config.paths.backups,
        logs: config.paths.logs,
      },
    });
  });

  // PUT /api/v1/system/settings — Update admin settings (including immediate Guest Upload Kill Switch)
  router.put('/settings', (req: Request, res: Response) => {
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid settings values',
        details: parsed.error.flatten(),
        code: 'VALIDATION_ERROR',
      });
      return;
    }

    const d = parsed.data;
    if (d.guestUploadsEnabled !== undefined) {
      setSetting(db, 'guest_uploads_enabled', String(d.guestUploadsEnabled));
    }
    if (d.maxUploadFileSizeBytes !== undefined) {
      setSetting(db, 'max_upload_file_size_bytes', String(d.maxUploadFileSizeBytes));
    }
    if (d.defaultGuestQuotaBytes !== undefined) {
      setSetting(db, 'default_guest_quota_bytes', String(d.defaultGuestQuotaBytes));
    }
    if (d.totalGuestUploadQuotaBytes !== undefined) {
      setSetting(db, 'total_guest_upload_quota_bytes', String(d.totalGuestUploadQuotaBytes));
    }
    if (d.maxConcurrentGuestUploads !== undefined) {
      setSetting(db, 'max_concurrent_guest_uploads', String(d.maxConcurrentGuestUploads));
    }
    if (d.trackDownloads !== undefined) {
      setSetting(db, 'track_downloads', String(d.trackDownloads));
    }
    if (d.indexerIntervalMinutes !== undefined) {
      setSetting(db, 'indexer_interval_minutes', String(d.indexerIntervalMinutes));
      indexer.startScheduledIndexing();
    }

    logAuditEvent(db, {
      eventType: 'SETTINGS_UPDATED',
      actor: req.admin!.username,
      ipAddress: req.ip,
      details: d as Record<string, unknown>,
    });

    res.json({ success: true });
  });

  // POST /api/v1/system/backup — Create a consistent hot SQLite backup on `/mnt/cloud/data/backups`
  router.post('/backup', async (req: Request, res: Response) => {
    try {
      if (!fs.existsSync(config.paths.backups)) {
        fs.mkdirSync(config.paths.backups, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFilename = `cloud-db-backup-${timestamp}.sqlite`;
      const backupPath = path.join(config.paths.backups, backupFilename);

      await db.backup(backupPath);
      const stat = fs.statSync(backupPath);

      logAuditEvent(db, {
        eventType: 'DATABASE_BACKUP_CREATED',
        actor: req.admin!.username,
        ipAddress: req.ip,
        details: { backupFilename, sizeBytes: stat.size },
      });

      res.status(201).json({
        success: true,
        backup: {
          filename: backupFilename,
          sizeBytes: stat.size,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Database backup failed', code: 'BACKUP_FAILED' });
    }
  });

  // GET /api/v1/system/backups — List available database backups on HDD
  router.get('/backups', (_req: Request, res: Response) => {
    try {
      if (!fs.existsSync(config.paths.backups)) {
        res.json({ backups: [] });
        return;
      }
      const entries = fs.readdirSync(config.paths.backups, { withFileTypes: true });
      const backups = entries
        .filter((e) => e.isFile() && e.name.endsWith('.sqlite'))
        .map((e) => {
          const stat = fs.statSync(path.join(config.paths.backups, e.name));
          return {
            filename: e.name,
            sizeBytes: stat.size,
            createdAt: new Date(stat.mtimeMs).toISOString(),
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      res.json({ backups });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to list backups', code: 'LIST_BACKUPS_FAILED' });
    }
  });

  return router;
}
