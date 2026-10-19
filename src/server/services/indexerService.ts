import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mime from 'mime-types';
import { fileTypeFromFile } from 'file-type';
import { DbInstance, getSetting, setSetting } from '../db/database.js';
import { AppConfig } from '../config.js';
import { classifyFileCategory } from '../storage/pathSecurity.js';
import { getDiskHealthAndSpace } from '../storage/mountGuard.js';

export interface ScanResult {
  jobId: string;
  status: 'completed' | 'failed';
  scannedFiles: number;
  scannedBytes: number;
  addedUntrackedFiles: number;
  removedMissingFiles: number;
  errors: string[];
  startedAt: string;
  completedAt: string;
}

export class IndexerService {
  private isScanning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private db: DbInstance, private config: AppConfig) {}

  public startScheduledIndexing(): void {
    const intervalMin = parseInt(
      getSetting(this.db, 'indexer_interval_minutes', String(this.config.indexerIntervalMinutes)),
      10
    );
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (intervalMin > 0) {
      this.timer = setInterval(() => {
        this.runScan('scheduled').catch((err) => {
          console.error('[Indexer] Scheduled scan error:', err);
        });
      }, intervalMin * 60 * 1000);
      this.timer.unref();
    }
  }

  public stopScheduledIndexing(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public isRunning(): boolean {
    return this.isScanning;
  }

  public async runScan(trigger: 'manual' | 'scheduled' | 'startup' = 'manual'): Promise<ScanResult> {
    if (this.isScanning) {
      throw new Error('A storage indexing scan is already in progress');
    }

    this.isScanning = true;
    const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const startedAt = new Date().toISOString();
    const errors: string[] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let addedUntrackedFiles = 0;
    let removedMissingFiles = 0;

    // Persist job on HDD SQLite and jobs folder
    this.db
      .prepare(
        `INSERT INTO background_jobs (id, job_type, status, progress_percent, scanned_files, scanned_bytes, errors_count, started_at, created_at)
         VALUES (?, ?, 'running', 0, 0, 0, 0, ?, ?)`
      )
      .run(jobId, `storage_index_${trigger}`, startedAt, startedAt);

    const stateFilePath = path.join(this.config.paths.index, 'latest-scan.json');

    try {
      const diskHealth = getDiskHealthAndSpace(this.config);
      if (!diskHealth.isMounted || !diskHealth.isWritable) {
        throw new Error(diskHealth.mountError || 'HDD is not mounted or writable');
      }

      const filesRoot = this.config.paths.files;
      if (!fs.existsSync(filesRoot)) {
        fs.mkdirSync(filesRoot, { recursive: true });
      }

      // 1. Verify all database files exist on physical HDD and update sizes if changed
      const dbFiles = this.db
        .prepare('SELECT id, storage_name, relative_path, size_bytes, is_trashed FROM files')
        .all() as {
        id: string;
        storage_name: string;
        relative_path: string;
        size_bytes: number;
        is_trashed: number;
      }[];

      const knownStorageNames = new Set<string>();

      for (const record of dbFiles) {
        knownStorageNames.add(record.storage_name);
        const fullPath = record.is_trashed
          ? path.join(this.config.paths.trash, record.storage_name)
          : path.join(filesRoot, record.relative_path);

        try {
          if (!fs.existsSync(fullPath)) {
            // Check fallback by storage_name directly in filesRoot
            const altPath = path.join(filesRoot, record.storage_name);
            if (!fs.existsSync(altPath)) {
              // File was removed externally from the HDD
              this.db.prepare('DELETE FROM files WHERE id = ?').run(record.id);
              removedMissingFiles++;
              continue;
            }
          } else {
            const lstat = fs.lstatSync(fullPath);
            if (lstat.isSymbolicLink()) {
              errors.push(`Skipped symbolic link at ${record.relative_path}`);
              continue;
            }
            if (lstat.size !== record.size_bytes) {
              this.db
                .prepare('UPDATE files SET size_bytes = ?, updated_at = ? WHERE id = ?')
                .run(lstat.size, new Date().toISOString(), record.id);
            }
            scannedFiles++;
            scannedBytes += lstat.size;
          }
        } catch (err: any) {
          errors.push(`Error inspecting ${record.relative_path}: ${err.message}`);
        }
      }

      // 2. Walk physical filesRoot to discover any untracked files placed directly on the HDD
      const entries = fs.readdirSync(filesRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(filesRoot, entry.name);
        try {
          const lstat = fs.lstatSync(fullPath);
          if (lstat.isSymbolicLink()) {
            errors.push(`Ignored symbolic link ${entry.name}`);
            continue;
          }
          if (lstat.isFile() && !knownStorageNames.has(entry.name)) {
            let detectedMime = mime.lookup(entry.name) || 'application/octet-stream';
            try {
              const ft = await fileTypeFromFile(fullPath);
              if (ft?.mime) detectedMime = ft.mime;
            } catch {
              // Fallback to extension lookup
            }

            const fileId = crypto.randomUUID();
            const now = new Date().toISOString();
            const ext = path.extname(entry.name).toLowerCase();
            const category = classifyFileCategory(detectedMime, entry.name);

            this.db
              .prepare(
                `INSERT INTO files (id, folder_id, name, storage_name, relative_path, mime_type, category, extension, size_bytes, is_trashed, created_at, updated_at)
                 VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
              )
              .run(
                fileId,
                entry.name,
                entry.name,
                entry.name,
                detectedMime,
                category,
                ext,
                lstat.size,
                now,
                now
              );

            this.db
              .prepare(
                `INSERT INTO file_metadata (file_id, original_filename, detected_mime, inode, mtime_ms, indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
              )
              .run(fileId, entry.name, detectedMime, Number(lstat.ino), Math.round(lstat.mtimeMs), now);

            scannedFiles++;
            scannedBytes += lstat.size;
            addedUntrackedFiles++;
          }
        } catch (err: any) {
          errors.push(`Failed indexing ${entry.name}: ${err.message}`);
        }
      }

      // 3. Record storage growth snapshot on HDD
      const latestHealth = getDiskHealthAndSpace(this.config);
      const counts = this.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM files WHERE is_trashed = 0) as total_files,
             (SELECT COALESCE(SUM(size_bytes), 0) FROM files) as indexed_bytes,
             (SELECT COUNT(*) FROM folders WHERE is_trashed = 0) as total_folders`
        )
        .get() as { total_files: number; indexed_bytes: number; total_folders: number };

      const snapshotId = `snap_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const completedAt = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO storage_snapshots (id, total_disk_bytes, used_disk_bytes, available_disk_bytes, indexed_files_bytes, total_files_count, total_folders_count, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          snapshotId,
          latestHealth.totalBytes,
          latestHealth.usedBytes,
          latestHealth.availableBytes,
          counts.indexed_bytes,
          counts.total_files,
          counts.total_folders,
          completedAt
        );

      // Keep at most 180 snapshots to bound database size
      this.db
        .prepare(
          `DELETE FROM storage_snapshots WHERE id NOT IN (
             SELECT id FROM storage_snapshots ORDER BY recorded_at DESC LIMIT 180
           )`
        )
        .run();

      // Update job & settings
      this.db
        .prepare(
          `UPDATE background_jobs
           SET status = 'completed', progress_percent = 100, scanned_files = ?, scanned_bytes = ?, errors_count = ?, error_details = ?, completed_at = ?
           WHERE id = ?`
        )
        .run(
          scannedFiles,
          scannedBytes,
          errors.length,
          errors.length > 0 ? JSON.stringify(errors) : null,
          completedAt,
          jobId
        );

      setSetting(this.db, 'last_successful_scan_at', completedAt);
      setSetting(this.db, 'last_scan_errors', JSON.stringify(errors));

      const result: ScanResult = {
        jobId,
        status: 'completed',
        scannedFiles,
        scannedBytes,
        addedUntrackedFiles,
        removedMissingFiles,
        errors,
        startedAt,
        completedAt,
      };

      fs.writeFileSync(stateFilePath, JSON.stringify(result, null, 2), 'utf8');
      return result;
    } catch (err: any) {
      const completedAt = new Date().toISOString();
      errors.push(err.message || 'Unknown indexing error');
      this.db
        .prepare(
          `UPDATE background_jobs
           SET status = 'failed', errors_count = ?, error_details = ?, completed_at = ?
           WHERE id = ?`
        )
        .run(errors.length, JSON.stringify(errors), completedAt, jobId);
      setSetting(this.db, 'last_scan_errors', JSON.stringify(errors));

      return {
        jobId,
        status: 'failed',
        scannedFiles,
        scannedBytes,
        addedUntrackedFiles,
        removedMissingFiles,
        errors,
        startedAt,
        completedAt,
      };
    } finally {
      this.isScanning = false;
    }
  }
}
