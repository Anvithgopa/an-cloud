import fs from 'node:fs';
import path from 'node:path';
import { AppConfig } from '../config.js';

export interface DiskSpaceStats {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
  isMounted: boolean;
  isWritable: boolean;
  identityVerified: boolean;
  deviceId: number;
  parentDeviceId: number;
  mountError: string | null;
  lastCheckedAt: string;
}

export class StorageGuardError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code = 'STORAGE_UNAVAILABLE', statusCode = 503) {
    super(message);
    this.name = 'StorageGuardError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function initializeStorageDirectories(config: AppConfig): void {
  const { paths, requireMountCheck, hddIdentityToken } = config;

  // 1. Check if root exists
  if (!fs.existsSync(paths.root)) {
    if (requireMountCheck) {
      throw new StorageGuardError(
        `CRITICAL: Storage root ${paths.root} does not exist. Refusing to fall back to microSD card!`,
        'HDD_NOT_MOUNTED'
      );
    }
    fs.mkdirSync(paths.root, { recursive: true });
  }

  // 2. If requireMountCheck is enabled, verify that paths.root is on a separate filesystem from its parent (e.g., /mnt)
  if (requireMountCheck) {
    const rootStat = fs.statSync(paths.root);
    const parentDir = path.dirname(paths.root);
    const parentStat = fs.statSync(parentDir);

    if (rootStat.dev === parentStat.dev) {
      throw new StorageGuardError(
        `CRITICAL: ${paths.root} is on the same filesystem device (dev=${rootStat.dev}) as ${parentDir}. The external WD Scorpio Blue HDD is not mounted! Refusing to start to protect the microSD card.`,
        'HDD_NOT_MOUNTED'
      );
    }

    if (!fs.existsSync(paths.identityFile)) {
      throw new StorageGuardError(
        `CRITICAL: HDD identity file ${paths.identityFile} is missing. Ensure the external HDD is properly mounted and initialized.`,
        'HDD_IDENTITY_MISSING'
      );
    }

    const identityContent = fs.readFileSync(paths.identityFile, 'utf8').trim();
    if (hddIdentityToken && !identityContent.includes(hddIdentityToken)) {
      throw new StorageGuardError(
        `CRITICAL: HDD identity token mismatch in ${paths.identityFile}. Expected token containing "${hddIdentityToken}".`,
        'HDD_IDENTITY_MISMATCH'
      );
    }
  }

  // 3. Create required directory structure on the HDD
  const requiredDirs = [
    paths.app,
    paths.config,
    paths.files,
    paths.database,
    paths.index,
    paths.jobs,
    paths.logs,
    paths.temp,
    paths.backups,
    paths.trash,
  ];

  for (const dir of requiredDirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Create identity file in dev/test mode if not present
  if (!requireMountCheck && !fs.existsSync(paths.identityFile)) {
    fs.writeFileSync(
      paths.identityFile,
      `${hddIdentityToken}\nInitialized: ${new Date().toISOString()}\n`,
      'utf8'
    );
  }

  // 4. Verify write access (ensures drive is not mounted read-only)
  const probeFile = path.join(paths.temp, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probeFile, 'ok', 'utf8');
    fs.unlinkSync(probeFile);
  } catch (err: any) {
    throw new StorageGuardError(
      `CRITICAL: Storage directory ${paths.temp} is not writable (${err.message}). The HDD may be mounted read-only or disconnected.`,
      'HDD_READ_ONLY'
    );
  }

  // 5. Clean up any abandoned temporary upload files from previous crashes
  cleanupAbandonedTempFiles(paths.temp);
}

export function cleanupAbandonedTempFiles(tempDir: string, maxAgeMs = 60 * 60 * 1000): number {
  let cleaned = 0;
  try {
    if (!fs.existsSync(tempDir)) return 0;
    const entries = fs.readdirSync(tempDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.startsWith('upload-') || entry.name.startsWith('archive-') || entry.name.startsWith('.write-probe-'))) {
        const fullPath = path.join(tempDir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs >= maxAgeMs || entry.name.startsWith('.write-probe-')) {
            fs.unlinkSync(fullPath);
            cleaned++;
          }
        } catch {
          // Ignore race condition
        }
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
  return cleaned;
}

export function getDiskHealthAndSpace(config: AppConfig): DiskSpaceStats {
  const { paths, requireMountCheck, hddIdentityToken } = config;
  const now = new Date().toISOString();

  try {
    if (!fs.existsSync(paths.root)) {
      return {
        totalBytes: 0,
        usedBytes: 0,
        availableBytes: 0,
        usagePercent: 0,
        isMounted: false,
        isWritable: false,
        identityVerified: false,
        deviceId: -1,
        parentDeviceId: -1,
        mountError: `Storage root ${paths.root} does not exist`,
        lastCheckedAt: now,
      };
    }

    const rootStat = fs.statSync(paths.root);
    const parentStat = fs.statSync(path.dirname(paths.root));
    const distinctDevice = rootStat.dev !== parentStat.dev;
    const isMounted = requireMountCheck ? distinctDevice : true;

    let identityVerified = false;
    if (fs.existsSync(paths.identityFile)) {
      const content = fs.readFileSync(paths.identityFile, 'utf8');
      identityVerified = !hddIdentityToken || content.includes(hddIdentityToken);
    }

    // Write probe
    let isWritable = false;
    const probeFile = path.join(paths.temp, `.health-probe-${process.pid}-${Date.now()}`);
    try {
      fs.writeFileSync(probeFile, '1');
      fs.unlinkSync(probeFile);
      isWritable = true;
    } catch {
      isWritable = false;
    }

    const statfs = fs.statfsSync(paths.root);
    const totalBytes = statfs.blocks * statfs.bsize;
    const availableBytes = statfs.bavail * statfs.bsize;
    const freeBytes = statfs.bfree * statfs.bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usagePercent = totalBytes > 0 ? Math.min(100, Math.round((usedBytes / totalBytes) * 10000) / 100) : 0;

    let mountError: string | null = null;
    if (!isMounted) {
      mountError = `HDD mount point ${paths.root} is on the same device as its parent directory (microSD fallback prevented).`;
    } else if (!identityVerified) {
      mountError = `HDD identity file ${paths.identityFile} missing or invalid.`;
    } else if (!isWritable) {
      mountError = `HDD storage at ${paths.root} is read-only or inaccessible.`;
    }

    return {
      totalBytes,
      usedBytes,
      availableBytes,
      usagePercent,
      isMounted,
      isWritable,
      identityVerified,
      deviceId: rootStat.dev,
      parentDeviceId: parentStat.dev,
      mountError,
      lastCheckedAt: now,
    };
  } catch (err: any) {
    return {
      totalBytes: 0,
      usedBytes: 0,
      availableBytes: 0,
      usagePercent: 0,
      isMounted: false,
      isWritable: false,
      identityVerified: false,
      deviceId: -1,
      parentDeviceId: -1,
      mountError: err.message || 'Failed to inspect HDD storage',
      lastCheckedAt: now,
    };
  }
}

export function assertStorageHealthy(config: AppConfig, requiredFreeBytes = 0): DiskSpaceStats {
  const health = getDiskHealthAndSpace(config);
  if (!health.isMounted || !health.identityVerified) {
    throw new StorageGuardError(
      health.mountError || 'External HDD is not mounted or identity check failed.',
      'HDD_NOT_MOUNTED',
      503
    );
  }
  if (!health.isWritable) {
    throw new StorageGuardError(
      health.mountError || 'External HDD is mounted read-only or experiencing I/O errors.',
      'HDD_READ_ONLY',
      503
    );
  }
  // Reserve at least 50MB buffer on disk or requiredFreeBytes
  const safetyBuffer = 50 * 1024 * 1024;
  if (requiredFreeBytes > 0 && health.availableBytes < requiredFreeBytes + safetyBuffer) {
    throw new StorageGuardError(
      `Insufficient disk space on HDD. Required: ${requiredFreeBytes} bytes, Available: ${health.availableBytes} bytes.`,
      'DISK_FULL',
      507
    );
  }
  return health;
}
