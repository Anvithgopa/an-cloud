import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Busboy from 'busboy';
import archiver from 'archiver';
import mime from 'mime-types';
import { fileTypeFromFile } from 'file-type';
import { Request, Response } from 'express';
import { DbInstance } from '../db/database.js';
import { AppConfig } from '../config.js';
import { assertStorageHealthy, StorageGuardError } from '../storage/mountGuard.js';
import {
  sanitizeDisplayName,
  generateSafeStorageFilename,
  resolveDuplicateDisplayName,
  classifyFileCategory,
  resolveSafePath,
} from '../storage/pathSecurity.js';

export interface UploadedFileRecord {
  id: string;
  folderId: string | null;
  name: string;
  storageName: string;
  mimeType: string;
  category: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface StreamingUploadOptions {
  req: Request;
  db: DbInstance;
  config: AppConfig;
  defaultFolderId: string | null;
  allowRelativePaths?: boolean; // True for admin folder uploads, false for guest uploads
  maxSingleFileBytes: number;
  maxTotalUploadBytes?: number; // Remaining quota for this upload batch
  maxFileCount?: number;
  uploadedViaLinkId?: string | null;
  onQuotaCheck?: (additionalBytes: number) => void;
}

/**
 * Ensures nested relative folder path exists under baseFolderId (used when uploading an entire directory).
 */
function ensureRelativeFolderHierarchy(
  db: DbInstance,
  baseFolderId: string | null,
  relativeFilePath: string
): { targetFolderId: string | null; cleanFileName: string } {
  const normalized = relativeFilePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return {
      targetFolderId: baseFolderId,
      cleanFileName: sanitizeDisplayName(parts[0] || 'unnamed_file'),
    };
  }

  const fileName = sanitizeDisplayName(parts.pop()!);
  let currentParentId = baseFolderId;

  for (const rawSegment of parts) {
    if (rawSegment === '.' || rawSegment === '..') {
      continue;
    }
    const segmentName = sanitizeDisplayName(rawSegment);
    const existing = db
      .prepare(
        `SELECT id FROM folders
         WHERE (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))
           AND name = ? AND is_trashed = 0`
      )
      .get(currentParentId, currentParentId, segmentName) as { id: string } | undefined;

    if (existing) {
      currentParentId = existing.id;
    } else {
      const newFolderId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO folders (id, parent_id, name, is_trashed, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`
      ).run(newFolderId, currentParentId, segmentName, now, now);
      currentParentId = newFolderId;
    }
  }

  return { targetFolderId: currentParentId, cleanFileName: fileName };
}

/**
 * Streams multipart/form-data uploads directly to temporary files on the HDD (`/mnt/cloud/data/temp`),
 * enforces per-file and total quota byte-by-byte DURING the stream, computes SHA-256, detects MIME via magic bytes,
 * and atomically renames into `/mnt/cloud/data/files` with collision-safe storage filenames.
 */
export async function handleStreamingMultipartUpload(
  options: StreamingUploadOptions
): Promise<UploadedFileRecord[]> {
  const {
    req,
    db,
    config,
    defaultFolderId,
    allowRelativePaths = false,
    maxSingleFileBytes,
    maxTotalUploadBytes,
    maxFileCount = 200,
    uploadedViaLinkId = null,
    onQuotaCheck,
  } = options;

  // Verify HDD is mounted and writable before accepting stream
  const health = assertStorageHealthy(config, 10 * 1024 * 1024);

  return new Promise<UploadedFileRecord[]>((resolve, reject) => {
    const tempFilesToClean = new Set<string>();
    const finalizedStorageFiles = new Set<string>();
    const fileProcessingPromises: Promise<UploadedFileRecord>[] = [];
    let relativePathsField: string[] = [];
    let targetFolderOverride: string | null = defaultFolderId;
    let totalBytesReceivedInBatch = 0;
    let filesStartedCount = 0;
    let abortedError: Error | null = null;

    const cleanupAll = () => {
      for (const tmp of tempFilesToClean) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          // Ignore
        }
      }
      for (const finalPath of finalizedStorageFiles) {
        try {
          if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
        } catch {
          // Ignore
        }
      }
    };

    const abortWithError = (err: Error) => {
      if (abortedError) return;
      abortedError = err;
      cleanupAll();
      reject(err);
    };

    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        preservePath: true,
        limits: {
          fileSize: maxSingleFileBytes,
          files: maxFileCount,
        },
      });
    } catch (err: any) {
      return reject(new StorageGuardError(`Invalid multipart upload request: ${err.message}`, 'INVALID_UPLOAD', 400));
    }

    busboy.on('field', (name, val) => {
      if (name === 'folderId' && !uploadedViaLinkId) {
        targetFolderOverride = val && val !== 'null' && val !== 'root' && val !== '' ? val : null;
      } else if (name === 'relativePaths') {
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed)) {
            relativePathsField = parsed.map(String);
          }
        } catch {
          relativePathsField.push(val);
        }
      }
    });

    busboy.on('file', (_fieldName, fileStream, info) => {
      if (abortedError) {
        fileStream.resume();
        return;
      }

      const fileIndex = filesStartedCount++;
      if (filesStartedCount > maxFileCount) {
        fileStream.resume();
        abortWithError(
          new StorageGuardError(`Maximum number of files (${maxFileCount}) exceeded`, 'FILE_LIMIT_EXCEEDED', 413)
        );
        return;
      }

      const rawFilename = info.filename || `upload_${Date.now()}`;
      const providedRelPath = relativePathsField[fileIndex] || rawFilename;

      const tempFilename = `upload-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.part`;
      const tempFilePath = path.join(config.paths.temp, tempFilename);
      tempFilesToClean.add(tempFilePath);

      const processPromise = new Promise<UploadedFileRecord>((resolveFile, rejectFile) => {
        const writeStream = fs.createWriteStream(tempFilePath, { flags: 'wx', mode: 0o600 });
        const hash = crypto.createHash('sha256');
        let fileBytes = 0;
        let streamFailed = false;

        fileStream.on('data', (chunk: Buffer) => {
          if (abortedError || streamFailed) return;

          fileBytes += chunk.length;
          totalBytesReceivedInBatch += chunk.length;

          // Check single file limit during stream
          if (fileBytes > maxSingleFileBytes) {
            streamFailed = true;
            fileStream.unpipe(writeStream);
            fileStream.resume();
            writeStream.destroy();
            const err = new StorageGuardError(
              `File "${sanitizeDisplayName(path.basename(rawFilename))}" exceeds maximum allowed size (${maxSingleFileBytes} bytes)`,
              'FILE_TOO_LARGE',
              413
            );
            rejectFile(err);
            abortWithError(err);
            return;
          }

          // Check total quota limit during stream
          if (maxTotalUploadBytes !== undefined && totalBytesReceivedInBatch > maxTotalUploadBytes) {
            streamFailed = true;
            fileStream.unpipe(writeStream);
            fileStream.resume();
            writeStream.destroy();
            const err = new StorageGuardError(
              `Upload quota exceeded during transfer (limit: ${maxTotalUploadBytes} bytes)`,
              'QUOTA_EXCEEDED',
              413
            );
            rejectFile(err);
            abortWithError(err);
            return;
          }

          // Check physical disk space during stream
          if (totalBytesReceivedInBatch + 50 * 1024 * 1024 > health.availableBytes) {
            streamFailed = true;
            fileStream.unpipe(writeStream);
            fileStream.resume();
            writeStream.destroy();
            const err = new StorageGuardError(
              'Insufficient physical disk space remaining on HDD',
              'DISK_FULL',
              507
            );
            rejectFile(err);
            abortWithError(err);
            return;
          }

          if (onQuotaCheck) {
            try {
              onQuotaCheck(totalBytesReceivedInBatch);
            } catch (qErr: any) {
              streamFailed = true;
              fileStream.unpipe(writeStream);
              fileStream.resume();
              writeStream.destroy();
              rejectFile(qErr);
              abortWithError(qErr);
              return;
            }
          }

          hash.update(chunk);
        });

        fileStream.on('limit', () => {
          if (streamFailed) return;
          streamFailed = true;
          writeStream.destroy();
          const err = new StorageGuardError(
            `File "${sanitizeDisplayName(path.basename(rawFilename))}" exceeds maximum size limit (${maxSingleFileBytes} bytes)`,
            'FILE_TOO_LARGE',
            413
          );
          rejectFile(err);
          abortWithError(err);
        });

        fileStream.on('error', (err) => {
          if (streamFailed) return;
          streamFailed = true;
          writeStream.destroy();
          rejectFile(err);
          abortWithError(err);
        });

        writeStream.on('error', (err) => {
          if (streamFailed) return;
          streamFailed = true;
          rejectFile(err);
          abortWithError(err);
        });

        writeStream.on('finish', async () => {
          if (streamFailed || abortedError) return;

          try {
            const sha256 = hash.digest('hex');

            // Detect real MIME type using magic bytes from the temporary file on HDD
            let detectedMime = mime.lookup(rawFilename) || info.mimeType || 'application/octet-stream';
            try {
              const ft = await fileTypeFromFile(tempFilePath);
              if (ft?.mime) {
                detectedMime = ft.mime;
              }
            } catch {
              // Fallback to extension-based mime
            }

            // Determine folder and deduplicated display name
            let finalFolderId = targetFolderOverride;
            let desiredDisplayName = sanitizeDisplayName(path.basename(rawFilename));

            if (allowRelativePaths && (providedRelPath.includes('/') || providedRelPath.includes('\\'))) {
              const resolved = ensureRelativeFolderHierarchy(db, targetFolderOverride, providedRelPath);
              finalFolderId = resolved.targetFolderId;
              desiredDisplayName = resolved.cleanFileName;
            }

            // Check existing filenames in finalFolderId so we never overwrite existing files
            const existingRows = db
              .prepare(
                `SELECT name FROM files
                 WHERE (folder_id = ? OR (folder_id IS NULL AND ? IS NULL))
                   AND is_trashed = 0`
              )
              .all(finalFolderId, finalFolderId) as { name: string }[];

            const existingSet = new Set(existingRows.map((r) => r.name));
            const uniqueDisplayName = resolveDuplicateDisplayName(desiredDisplayName, existingSet);

            // Generate collision-safe storage filename on HDD
            const storageName = generateSafeStorageFilename(uniqueDisplayName);
            const finalDiskPath = resolveSafePath(config.paths.files, storageName);

            // Atomic rename on same HDD filesystem (/mnt/cloud/data/temp -> /mnt/cloud/data/files)
            fs.renameSync(tempFilePath, finalDiskPath);
            tempFilesToClean.delete(tempFilePath);
            finalizedStorageFiles.add(finalDiskPath);

            const lstat = fs.lstatSync(finalDiskPath);
            const fileId = crypto.randomUUID();
            const now = new Date().toISOString();
            const ext = path.extname(uniqueDisplayName).toLowerCase();
            const category = classifyFileCategory(detectedMime, uniqueDisplayName);

            const insertTx = db.transaction(() => {
              db.prepare(
                `INSERT INTO files (
                   id, folder_id, name, storage_name, relative_path, mime_type,
                   category, extension, size_bytes, sha256, is_trashed,
                   uploaded_via_link_id, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
              ).run(
                fileId,
                finalFolderId,
                uniqueDisplayName,
                storageName,
                storageName,
                detectedMime,
                category,
                ext,
                fileBytes,
                sha256,
                uploadedViaLinkId,
                now,
                now
              );

              db.prepare(
                `INSERT INTO file_metadata (file_id, original_filename, detected_mime, inode, mtime_ms, indexed_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
              ).run(
                fileId,
                sanitizeDisplayName(path.basename(rawFilename)),
                detectedMime,
                Number(lstat.ino),
                Math.round(lstat.mtimeMs),
                now
              );
            });

            insertTx();

            resolveFile({
              id: fileId,
              folderId: finalFolderId,
              name: uniqueDisplayName,
              storageName,
              mimeType: detectedMime,
              category,
              extension: ext,
              sizeBytes: fileBytes,
              sha256,
              createdAt: now,
            });
          } catch (err: any) {
            rejectFile(err);
            abortWithError(err);
          }
        });

        fileStream.pipe(writeStream);
      });

      // Prevent unhandled promise rejection if abortWithError rejects the main promise early
      processPromise.catch(() => {});
      fileProcessingPromises.push(processPromise);
    });

    busboy.on('filesLimit', () => {
      abortWithError(
        new StorageGuardError(`Maximum number of files (${maxFileCount}) exceeded`, 'FILE_LIMIT_EXCEEDED', 413)
      );
    });

    busboy.on('error', (err: any) => {
      abortWithError(new StorageGuardError(`Upload stream error: ${err.message}`, 'UPLOAD_STREAM_ERROR', 400));
    });

    busboy.on('finish', async () => {
      if (abortedError) return;
      try {
        const results = await Promise.all(fileProcessingPromises);
        resolve(results);
      } catch (err: any) {
        abortWithError(err);
      }
    });

    req.on('aborted', () => {
      abortWithError(new StorageGuardError('Upload cancelled or connection aborted by client', 'UPLOAD_ABORTED', 499));
    });

    req.pipe(busboy);
  });
}

/**
 * Streams a file from HDD to HTTP response with HTTP Range support (for video/audio seeking and resumable downloads)
 * and strict Content-Security-Policy / Content-Disposition headers so active content is never executed.
 */
export function streamFileResponse(params: {
  req: Request;
  res: Response;
  diskPath: string;
  displayName: string;
  mimeType: string;
  sizeBytes: number;
  inline: boolean;
}): void {
  const { req, res, diskPath, displayName, mimeType, inline } = params;

  if (!fs.existsSync(diskPath)) {
    res.status(404).json({ error: 'File not found on physical HDD', code: 'FILE_MISSING_ON_DISK' });
    return;
  }

  const stat = fs.statSync(diskPath);
  const totalSize = stat.size;

  // Hardened security headers for any file response
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; sandbox"
  );

  const encodedName = encodeURIComponent(displayName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  const asciiFallback = displayName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const dispositionType = inline ? 'inline' : 'attachment';
  res.setHeader(
    'Content-Disposition',
    `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`
  );
  res.setHeader('Accept-Ranges', 'bytes');

  const safeContentType = inline ? mimeType : 'application/octet-stream';
  res.setHeader('Content-Type', safeContentType);

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

    if (isNaN(start) || isNaN(end) || start >= totalSize || end >= totalSize || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
      return;
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    res.setHeader('Content-Length', chunkSize);

    const stream = fs.createReadStream(diskPath, { start, end, highWaterMark: 64 * 1024 });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
  } else {
    res.status(200);
    res.setHeader('Content-Length', totalSize);
    const stream = fs.createReadStream(diskPath, { highWaterMark: 64 * 1024 });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    stream.pipe(res);
  }
}

/**
 * Recursively collects all non-trashed files inside a folder hierarchy and streams them as a ZIP archive
 * without buffering the archive into RAM.
 */
export async function streamFolderZipArchive(params: {
  res: Response;
  db: DbInstance;
  config: AppConfig;
  rootFolderId: string;
  rootFolderName: string;
}): Promise<number> {
  const { res, db, config, rootFolderId, rootFolderName } = params;

  assertStorageHealthy(config, 20 * 1024 * 1024);

  // Collect all descendant folders and files
  interface ArchiveEntry {
    diskPath: string;
    archivePath: string;
    sizeBytes: number;
  }

  const entries: ArchiveEntry[] = [];

  function walkFolder(folderId: string, prefixPath: string) {
    const files = db
      .prepare('SELECT name, relative_path, size_bytes FROM files WHERE folder_id = ? AND is_trashed = 0')
      .all(folderId) as { name: string; relative_path: string; size_bytes: number }[];

    for (const f of files) {
      const diskPath = resolveSafePath(config.paths.files, f.relative_path);
      if (fs.existsSync(diskPath)) {
        entries.push({
          diskPath,
          archivePath: path.posix.join(prefixPath, f.name),
          sizeBytes: f.size_bytes,
        });
      }
    }

    const subfolders = db
      .prepare('SELECT id, name FROM folders WHERE parent_id = ? AND is_trashed = 0')
      .all(folderId) as { id: string; name: string }[];

    for (const sub of subfolders) {
      walkFolder(sub.id, path.posix.join(prefixPath, sub.name));
    }
  }

  const safeRootName = sanitizeDisplayName(rootFolderName);
  walkFolder(rootFolderId, safeRootName);

  const zipName = `${safeRootName}.zip`;
  const encodedName = encodeURIComponent(zipName).replace(/['()]/g, escape);
  const asciiFallback = zipName.replace(/[^\x20-\x7E]/g, '_');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');

  return new Promise<number>((resolve, reject) => {
    const archive = archiver('zip', {
      zlib: { level: 5 }, // Balanced CPU/speed for Raspberry Pi 4 Cortex-A72
    });

    let totalBytes = 0;

    archive.on('error', (err) => {
      reject(err);
    });

    res.on('close', () => {
      resolve(totalBytes);
    });

    archive.pipe(res);

    if (entries.length === 0) {
      archive.append('This shared folder is empty.\n', { name: `${safeRootName}/README.txt` });
    } else {
      for (const entry of entries) {
        totalBytes += entry.sizeBytes;
        archive.file(entry.diskPath, { name: entry.archivePath });
      }
    }

    archive.finalize().catch(reject);
  });
}
