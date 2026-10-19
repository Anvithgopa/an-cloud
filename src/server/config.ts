import path from 'node:path';
import fs from 'node:fs';

export interface StoragePaths {
  root: string;
  app: string;
  config: string;
  files: string;
  database: string;
  index: string;
  jobs: string;
  logs: string;
  temp: string;
  backups: string;
  trash: string;
  dbFile: string;
  identityFile: string;
}

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  storageRoot: string;
  requireMountCheck: boolean;
  hddIdentityToken: string;
  sessionSecret: string;
  secureCookies: boolean;
  maxUploadFileSizeBytes: number;
  defaultGuestQuotaBytes: number;
  maxConcurrentGuestUploads: number;
  indexerIntervalMinutes: number;
  paths: StoragePaths;
}

export function loadConfig(overrides?: Partial<Record<string, string>>): AppConfig {
  const env = { ...process.env, ...overrides };
  const nodeEnv = env.NODE_ENV || 'development';
  const defaultRoot = nodeEnv === 'production' ? '/mnt/cloud' : path.resolve(process.cwd(), '.local-cloud');
  const storageRoot = path.resolve(env.STORAGE_ROOT || defaultRoot);

  const requireMountCheck =
    env.REQUIRE_MOUNT_CHECK !== undefined
      ? env.REQUIRE_MOUNT_CHECK === 'true'
      : nodeEnv === 'production' && storageRoot === '/mnt/cloud';

  const paths: StoragePaths = {
    root: storageRoot,
    app: path.join(storageRoot, 'app'),
    config: path.join(storageRoot, 'config'),
    files: path.join(storageRoot, 'data', 'files'),
    database: path.join(storageRoot, 'data', 'database'),
    index: path.join(storageRoot, 'data', 'index'),
    jobs: path.join(storageRoot, 'data', 'jobs'),
    logs: path.join(storageRoot, 'data', 'logs'),
    temp: path.join(storageRoot, 'data', 'temp'),
    backups: path.join(storageRoot, 'data', 'backups'),
    trash: path.join(storageRoot, 'data', 'temp', 'trash'),
    dbFile: path.join(storageRoot, 'data', 'database', 'cloud.sqlite'),
    identityFile: path.join(storageRoot, 'config', '.hdd-identity'),
  };

  return {
    port: parseInt(env.PORT || '3000', 10),
    host: env.HOST || '0.0.0.0',
    nodeEnv,
    storageRoot,
    requireMountCheck,
    hddIdentityToken: env.HDD_IDENTITY_TOKEN || 'WD-SCORPIO-BLUE-250GB',
    sessionSecret: env.SESSION_SECRET || 'dev-ephemeral-secret-replace-in-prod-immediately',
    secureCookies: env.SECURE_COOKIES === 'true',
    maxUploadFileSizeBytes: parseInt(env.MAX_UPLOAD_FILE_SIZE_BYTES || String(10 * 1024 * 1024 * 1024), 10),
    defaultGuestQuotaBytes: parseInt(env.DEFAULT_GUEST_QUOTA_BYTES || String(5 * 1024 * 1024 * 1024), 10),
    maxConcurrentGuestUploads: parseInt(env.MAX_CONCURRENT_GUEST_UPLOADS || '3', 10),
    indexerIntervalMinutes: parseInt(env.INDEXER_INTERVAL_MINUTES || '30', 10),
    paths,
  };
}
