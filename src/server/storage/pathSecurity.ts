import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { StorageGuardError } from './mountGuard.js';

/**
 * Normalizes a Unicode display filename while stripping control chars and path separators.
 */
export function sanitizeDisplayName(rawName: string): string {
  const normalized = rawName.normalize('NFC').trim();
  // Remove path separators, null bytes, and control characters
  const cleaned = normalized
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/[\x00-\x1f\x80-\x9f]/g, '')
    .replace(/^\.+$/, '_');

  if (!cleaned || cleaned.length === 0) {
    return `unnamed_${Date.now()}`;
  }
  // Limit length to 200 characters while preserving extension
  if (cleaned.length > 200) {
    const ext = path.extname(cleaned).slice(0, 20);
    const base = path.basename(cleaned, ext).slice(0, 175);
    return `${base}${ext}`;
  }
  return cleaned;
}

/**
 * Generates a collision-safe disk filename so guest or user uploads never overwrite existing files on disk
 * and never allow user-controlled path segments on disk.
 */
export function generateSafeStorageFilename(originalName: string): string {
  const sanitized = sanitizeDisplayName(originalName);
  const ext = path.extname(sanitized).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const randomId = crypto.randomUUID();
  return `${randomId}${ext}`;
}

/**
 * Resolves a relative path within baseDir and strictly verifies:
 * 1. The resolved path stays inside baseDir (no `..` traversal).
 * 2. If the target or any existing ancestor is a symbolic link, it does not point outside baseDir (or symlinks are rejected outright).
 */
export function resolveSafePath(baseDir: string, relativeTarget: string): string {
  const resolvedBase = fs.existsSync(baseDir) ? fs.realpathSync(baseDir) : path.resolve(baseDir);

  // Reject null bytes immediately
  if (relativeTarget.includes('\0')) {
    throw new StorageGuardError('Invalid path containing null bytes', 'PATH_TRAVERSAL_BLOCKED', 400);
  }

  // Normalize and strip leading slashes so path.resolve treats it as relative
  const cleanedRelative = relativeTarget.replace(/^[/\\]+/, '');
  const candidate = path.resolve(resolvedBase, cleanedRelative);

  // Verify candidate is strictly within resolvedBase
  const rel = path.relative(resolvedBase, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new StorageGuardError(
      'Path traversal attempt blocked: target escapes storage root',
      'PATH_TRAVERSAL_BLOCKED',
      403
    );
  }

  // Walk existing path segments to ensure no symlink escapes
  let current = resolvedBase;
  const parts = rel.split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const lstat = fs.lstatSync(current);
      if (lstat.isSymbolicLink()) {
        throw new StorageGuardError(
          'Symbolic links are forbidden inside the cloud storage directory',
          'SYMLINK_BLOCKED',
          403
        );
      }
    }
  }

  return candidate;
}

/**
 * Deduplicates display names within a folder (e.g. "report.pdf" -> "report (1).pdf").
 */
export function resolveDuplicateDisplayName(desiredName: string, existingNames: Set<string>): string {
  if (!existingNames.has(desiredName)) {
    return desiredName;
  }
  const ext = path.extname(desiredName);
  const base = path.basename(desiredName, ext);
  let counter = 1;
  while (existingNames.has(`${base} (${counter})${ext}`)) {
    counter++;
  }
  return `${base} (${counter})${ext}`;
}

/**
 * Classifies MIME type and extension into high-level file categories.
 */
export type FileCategory = 'image' | 'video' | 'audio' | 'pdf' | 'document' | 'archive' | 'code' | 'other';

export function classifyFileCategory(mimeType: string, filename: string): FileCategory {
  const mime = (mimeType || '').toLowerCase();
  const ext = path.extname(filename).toLowerCase();

  if (mime.startsWith('image/') || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'].includes(ext)) {
    return 'image';
  }
  if (mime.startsWith('video/') || ['.mp4', '.webm', '.mkv', '.mov', '.avi', '.m4v'].includes(ext)) {
    return 'video';
  }
  if (mime.startsWith('audio/') || ['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'].includes(ext)) {
    return 'audio';
  }
  if (mime === 'application/pdf' || ext === '.pdf') {
    return 'pdf';
  }
  if (
    mime.includes('zip') ||
    mime.includes('tar') ||
    mime.includes('compressed') ||
    mime.includes('7z') ||
    mime.includes('rar') ||
    ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz'].includes(ext)
  ) {
    return 'archive';
  }
  if (
    mime.includes('word') ||
    mime.includes('excel') ||
    mime.includes('spreadsheet') ||
    mime.includes('presentation') ||
    mime.includes('officedocument') ||
    mime === 'text/plain' ||
    mime === 'text/markdown' ||
    mime === 'text/csv' ||
    ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf', '.odt'].includes(ext)
  ) {
    return 'document';
  }
  if (
    mime.includes('javascript') ||
    mime.includes('json') ||
    mime.includes('xml') ||
    mime.includes('html') ||
    ['.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.json', '.yaml', '.yml', '.sh', '.sql', '.html', '.css'].includes(ext)
  ) {
    return 'code';
  }
  return 'other';
}

/**
 * Determines whether a MIME type is safe to render inline during authenticated/public preview.
 * Active content (HTML, SVG, scripts, XML) is NEVER served inline to prevent Stored XSS.
 */
export function isSafeInlinePreviewMime(mimeType: string): boolean {
  const mime = (mimeType || '').toLowerCase();
  const unsafeMimes = [
    'text/html',
    'application/xhtml+xml',
    'image/svg+xml',
    'text/xml',
    'application/xml',
    'application/javascript',
    'text/javascript',
  ];
  if (unsafeMimes.includes(mime)) {
    return false;
  }
  return (
    mime.startsWith('image/') ||
    mime.startsWith('video/') ||
    mime.startsWith('audio/') ||
    mime === 'application/pdf' ||
    mime === 'text/plain'
  );
}
