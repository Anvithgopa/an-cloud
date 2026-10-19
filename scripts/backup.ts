import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/server/config.js';

async function runBackup() {
  const config = loadConfig();
  if (!fs.existsSync(config.paths.dbFile)) {
    console.error(`[Backup] Database file not found at ${config.paths.dbFile}`);
    process.exit(1);
  }

  if (!fs.existsSync(config.paths.backups)) {
    fs.mkdirSync(config.paths.backups, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(config.paths.backups, `cloud-db-backup-${timestamp}.sqlite`);

  console.log(`[Backup] Starting hot SQLite backup from ${config.paths.dbFile}...`);
  const db = new Database(config.paths.dbFile, { readonly: true });
  try {
    await db.backup(backupFile);
    const stat = fs.statSync(backupFile);
    console.log(`[Backup] Completed successfully: ${backupFile} (${stat.size} bytes)`);
  } finally {
    db.close();
  }
}

runBackup().catch((err) => {
  console.error('[Backup] Fatal error:', err);
  process.exit(1);
});
