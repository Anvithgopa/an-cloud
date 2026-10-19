import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/server/config.js';

async function runRestore() {
  const config = loadConfig();
  const requestedBackup = process.argv[2];

  if (!fs.existsSync(config.paths.backups)) {
    console.error(`[Restore] Backups directory ${config.paths.backups} does not exist.`);
    process.exit(1);
  }

  let sourceBackupPath: string;
  if (requestedBackup) {
    sourceBackupPath = path.isAbsolute(requestedBackup)
      ? requestedBackup
      : path.join(config.paths.backups, requestedBackup);
  } else {
    const entries = fs
      .readdirSync(config.paths.backups)
      .filter((f) => f.endsWith('.sqlite'))
      .map((f) => ({
        name: f,
        fullPath: path.join(config.paths.backups, f),
        mtime: fs.statSync(path.join(config.paths.backups, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (entries.length === 0) {
      console.error(`[Restore] No .sqlite backup files found in ${config.paths.backups}`);
      process.exit(1);
    }
    sourceBackupPath = entries[0].fullPath;
  }

  if (!fs.existsSync(sourceBackupPath)) {
    console.error(`[Restore] Backup file not found: ${sourceBackupPath}`);
    process.exit(1);
  }

  // Verify integrity of the backup before restoring
  const verifyDb = new Database(sourceBackupPath, { readonly: true });
  const integrity = verifyDb.pragma('integrity_check', { simple: true });
  verifyDb.close();

  if (integrity !== 'ok') {
    console.error(`[Restore] Integrity check failed on ${sourceBackupPath}: ${integrity}`);
    process.exit(1);
  }

  // Remove stale WAL/SHM files and copy verified backup atomically
  const walFile = `${config.paths.dbFile}-wal`;
  const shmFile = `${config.paths.dbFile}-shm`;
  if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
  if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);

  const tempTarget = `${config.paths.dbFile}.restoring`;
  fs.copyFileSync(sourceBackupPath, tempTarget);
  fs.renameSync(tempTarget, config.paths.dbFile);

  console.log(`[Restore] Successfully restored ${sourceBackupPath} -> ${config.paths.dbFile}`);
}

runRestore().catch((err) => {
  console.error('[Restore] Fatal error:', err);
  process.exit(1);
});
