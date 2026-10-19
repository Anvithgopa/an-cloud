import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { AppConfig } from '../config.js';

export type DbInstance = Database.Database;

export function initializeDatabase(config: AppConfig): DbInstance {
  const dbDir = path.dirname(config.paths.dbFile);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(config.paths.dbFile);

  // Set WAL mode for performance and concurrency on HDD, and enforce foreign keys
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = FILE');

  runMigrations(db, config);

  return db;
}

function runMigrations(db: DbInstance, config: AppConfig): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = db
    .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
    .all() as { version: number }[];
  const appliedSet = new Set(applied.map((r) => r.version));

  if (!appliedSet.has(1)) {
    const migrateV1 = db.transaction(() => {
      db.exec(`
        -- 1. Administrator Users
        CREATE TABLE IF NOT EXISTS admin_users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          email TEXT,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT
        );

        -- 2. Persistent Server-Side Sessions
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          csrf_token TEXT NOT NULL,
          ip_address TEXT,
          user_agent TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_active_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

        -- 3. Folders (Hierarchical)
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          is_trashed INTEGER NOT NULL DEFAULT 0,
          trashed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_folders_parent_id ON folders(parent_id);
        CREATE INDEX IF NOT EXISTS idx_folders_trashed ON folders(is_trashed);

        -- 4. Files
        CREATE TABLE IF NOT EXISTS files (
          id TEXT PRIMARY KEY,
          folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          storage_name TEXT NOT NULL UNIQUE,
          relative_path TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          category TEXT NOT NULL,
          extension TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT,
          is_trashed INTEGER NOT NULL DEFAULT 0,
          trashed_at TEXT,
          uploaded_via_link_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);
        CREATE INDEX IF NOT EXISTS idx_files_category ON files(category);
        CREATE INDEX IF NOT EXISTS idx_files_trashed ON files(is_trashed);
        CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
        CREATE INDEX IF NOT EXISTS idx_files_size ON files(size_bytes);
        CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);

        -- 5. File Metadata (extended attributes, image dimensions, duration, indexing checksums)
        CREATE TABLE IF NOT EXISTS file_metadata (
          file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
          original_filename TEXT NOT NULL,
          detected_mime TEXT,
          inode INTEGER,
          mtime_ms INTEGER,
          indexed_at TEXT NOT NULL,
          notes TEXT
        );

        -- 6. Starred Items
        CREATE TABLE IF NOT EXISTS starred_items (
          id TEXT PRIMARY KEY,
          item_type TEXT NOT NULL CHECK(item_type IN ('file', 'folder')),
          file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
          folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          UNIQUE(item_type, file_id),
          UNIQUE(item_type, folder_id)
        );

        -- 7. Share Links (Store ONLY hashed token; optional encrypted/masked display hint or URL suffix is never the raw auth secret unless returned on creation, or we store a public lookup prefix + Argon2/SHA-256 token hash)
        CREATE TABLE IF NOT EXISTS share_links (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          token_prefix TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT,
          target_type TEXT NOT NULL CHECK(target_type IN ('file', 'folder')),
          file_id TEXT REFERENCES files(id) ON DELETE CASCADE,
          folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
          password_hash TEXT,
          is_enabled INTEGER NOT NULL DEFAULT 1,
          is_revoked INTEGER NOT NULL DEFAULT 0,
          revoked_at TEXT,
          expires_at TEXT,
          created_by TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_share_links_token_hash ON share_links(token_hash);
        CREATE INDEX IF NOT EXISTS idx_share_links_file_id ON share_links(file_id);
        CREATE INDEX IF NOT EXISTS idx_share_links_folder_id ON share_links(folder_id);

        -- 8. Share Permissions (Explicitly separate download vs upload permissions)
        CREATE TABLE IF NOT EXISTS share_permissions (
          link_id TEXT PRIMARY KEY REFERENCES share_links(id) ON DELETE CASCADE,
          allow_download INTEGER NOT NULL DEFAULT 0,
          allow_upload INTEGER NOT NULL DEFAULT 0,
          allow_folder_listing INTEGER NOT NULL DEFAULT 0
        );

        -- 9. Share Quotas & Limits
        CREATE TABLE IF NOT EXISTS share_link_quotas (
          link_id TEXT PRIMARY KEY REFERENCES share_links(id) ON DELETE CASCADE,
          max_downloads INTEGER,
          current_downloads INTEGER NOT NULL DEFAULT 0,
          max_uploads INTEGER,
          current_uploads INTEGER NOT NULL DEFAULT 0,
          max_total_upload_bytes INTEGER,
          current_uploaded_bytes INTEGER NOT NULL DEFAULT 0,
          max_single_file_bytes INTEGER
        );

        -- 10. Guest Upload Records
        CREATE TABLE IF NOT EXISTS guest_upload_records (
          id TEXT PRIMARY KEY,
          link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
          file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
          original_filename TEXT NOT NULL,
          stored_filename TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          uploader_ip TEXT,
          user_agent TEXT,
          uploaded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_guest_uploads_link_id ON guest_upload_records(link_id);

        -- 11. Download & Upload Activity Log
        CREATE TABLE IF NOT EXISTS transfer_activity (
          id TEXT PRIMARY KEY,
          direction TEXT NOT NULL CHECK(direction IN ('upload', 'download')),
          actor_type TEXT NOT NULL CHECK(actor_type IN ('admin', 'guest')),
          link_id TEXT REFERENCES share_links(id) ON DELETE SET NULL,
          file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
          folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
          item_name TEXT NOT NULL,
          bytes_transferred INTEGER NOT NULL DEFAULT 0,
          ip_address TEXT,
          status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'rejected')),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_transfer_activity_created_at ON transfer_activity(created_at);
        CREATE INDEX IF NOT EXISTS idx_transfer_activity_link_id ON transfer_activity(link_id);

        -- 12. Storage Growth History Snapshots
        CREATE TABLE IF NOT EXISTS storage_snapshots (
          id TEXT PRIMARY KEY,
          total_disk_bytes INTEGER NOT NULL,
          used_disk_bytes INTEGER NOT NULL,
          available_disk_bytes INTEGER NOT NULL,
          indexed_files_bytes INTEGER NOT NULL,
          total_files_count INTEGER NOT NULL,
          total_folders_count INTEGER NOT NULL,
          recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_storage_snapshots_recorded_at ON storage_snapshots(recorded_at);

        -- 13. Background Jobs & Indexing State
        CREATE TABLE IF NOT EXISTS background_jobs (
          id TEXT PRIMARY KEY,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
          progress_percent INTEGER NOT NULL DEFAULT 0,
          scanned_files INTEGER NOT NULL DEFAULT 0,
          scanned_bytes INTEGER NOT NULL DEFAULT 0,
          errors_count INTEGER NOT NULL DEFAULT 0,
          error_details TEXT,
          started_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL
        );

        -- 14. Application Settings
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- 15. Audit Events
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          actor TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          ip_address TEXT,
          details TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
      `);

      // Seed default settings if not present
      const now = new Date().toISOString();
      const defaultSettings: Record<string, string> = {
        guest_uploads_enabled: 'true',
        max_upload_file_size_bytes: String(config.maxUploadFileSizeBytes),
        default_guest_quota_bytes: String(config.defaultGuestQuotaBytes),
        total_guest_upload_quota_bytes: String(50 * 1024 * 1024 * 1024), // 50 GB total guest cap
        max_concurrent_guest_uploads: String(config.maxConcurrentGuestUploads),
        track_downloads: 'true',
        indexer_interval_minutes: String(config.indexerIntervalMinutes),
        last_successful_scan_at: '',
        last_scan_errors: '[]',
      };

      const insertSetting = db.prepare(
        'INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)'
      );
      for (const [k, v] of Object.entries(defaultSettings)) {
        insertSetting.run(k, v, now);
      }

      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, now);
    });

    migrateV1();
  }
}

export function getSetting(db: DbInstance, key: string, fallback = ''): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : fallback;
}

export function setSetting(db: DbInstance, key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, now);
}

export function logAuditEvent(
  db: DbInstance,
  params: {
    eventType: string;
    actor: string;
    targetType?: string;
    targetId?: string;
    ipAddress?: string;
    details?: Record<string, unknown> | string;
  }
): void {
  const id = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const detailsStr =
    typeof params.details === 'string'
      ? params.details
      : params.details
      ? JSON.stringify(params.details)
      : null;

  db.prepare(
    `INSERT INTO audit_events (id, event_type, actor, target_type, target_id, ip_address, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.eventType,
    params.actor,
    params.targetType || null,
    params.targetId || null,
    params.ipAddress || null,
    detailsStr,
    new Date().toISOString()
  );
}
