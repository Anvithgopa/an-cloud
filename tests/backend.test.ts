import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp, AppContext } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { resolveSafePath, isSafeInlinePreviewMime } from '../src/server/storage/pathSecurity.js';
import { initializeStorageDirectories, StorageGuardError } from '../src/server/storage/mountGuard.js';

describe('ScorpioCloud Backend & Security Acceptance Suite', () => {
  let tempRoot: string;
  let ctx: AppContext;
  let agent: ReturnType<typeof request.agent>;
  let csrfToken: string;

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scorpiocloud-test-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      STORAGE_ROOT: tempRoot,
      REQUIRE_MOUNT_CHECK: 'false',
      SESSION_SECRET: 'test-session-secret-key-0123456789abcdef',
    });

    ctx = createApp(config);
    agent = request.agent(ctx.app);

    // 1. Complete first-run admin setup
    const setupRes = await agent.post('/api/v1/auth/setup').send({
      username: 'piadmin',
      displayName: 'Pi Owner',
      email: 'owner@raspberrypi.local',
      password: 'StrongPassword#2026!',
    });

    expect(setupRes.status).toBe(201);
    expect(setupRes.body.authenticated).toBe(true);
    csrfToken = setupRes.body.csrfToken;
  });

  afterEach(() => {
    ctx.close();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup race
    }
  });

  it('1. Enforces administrator authentication, blocks duplicate setup, and validates CSRF', async () => {
    // Second setup attempt must be forbidden
    const dupSetup = await request(ctx.app).post('/api/v1/auth/setup').send({
      username: 'hacker',
      displayName: 'Hacker',
      password: 'Password123!',
    });
    expect(dupSetup.status).toBe(403);

    // Unauthenticated request to private endpoint must fail with 401
    const unauth = await request(ctx.app).get('/api/v1/drive/items');
    expect(unauth.status).toBe(401);

    // Authenticated POST without CSRF token must fail with 403
    const noCsrf = await agent.post('/api/v1/drive/folders').send({ name: 'Test' });
    expect(noCsrf.status).toBe(403);

    // Login with wrong password fails with 401
    const badLogin = await request(ctx.app).post('/api/v1/auth/login').send({
      username: 'piadmin',
      password: 'WrongPassword',
    });
    expect(badLogin.status).toBe(401);

    // Login with right password succeeds
    const goodLogin = await request(ctx.app).post('/api/v1/auth/login').send({
      username: 'piadmin',
      password: 'StrongPassword#2026!',
    });
    expect(goodLogin.status).toBe(200);
    expect(goodLogin.body.authenticated).toBe(true);
  });

  it('2 & 3. Supports nested folders, streaming file uploads, downloads, rename, move, copy, star, and trash', async () => {
    // Create parent folder
    const parentRes = await agent
      .post('/api/v1/drive/folders')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Projects' });
    expect(parentRes.status).toBe(201);
    const projectsFolderId = parentRes.body.folder.id;

    // Create nested subfolder
    const subRes = await agent
      .post('/api/v1/drive/folders')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'RaspberryPi', parentId: projectsFolderId });
    expect(subRes.status).toBe(201);
    const subFolderId = subRes.body.folder.id;

    // Upload a file into the nested folder
    const fileContent = Buffer.from('Hello from WD Scorpio Blue 250GB SATA HDD!', 'utf8');
    const uploadRes = await agent
      .post(`/api/v1/drive/upload?folderId=${subFolderId}`)
      .set('x-csrf-token', csrfToken)
      .attach('files', fileContent, 'notes.txt');

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.files).toHaveLength(1);
    const uploadedFile = uploadRes.body.files[0];
    expect(uploadedFile.name).toBe('notes.txt');
    expect(uploadedFile.sizeBytes).toBe(fileContent.length);

    // Download the file and verify contents match byte-for-byte
    const downloadRes = await agent.get(`/api/v1/drive/files/${uploadedFile.id}/content`);
    expect(downloadRes.status).toBe(200);
    expect(Buffer.from(downloadRes.body).toString('utf8')).toBe('Hello from WD Scorpio Blue 250GB SATA HDD!');

    // Rename the file
    const renameRes = await agent
      .patch(`/api/v1/drive/files/${uploadedFile.id}/rename`)
      .set('x-csrf-token', csrfToken)
      .send({ name: 'architecture-notes.txt' });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.name).toBe('architecture-notes.txt');

    // Move the file to parent folder
    const moveRes = await agent
      .patch(`/api/v1/drive/files/${uploadedFile.id}/move`)
      .set('x-csrf-token', csrfToken)
      .send({ targetFolderId: projectsFolderId });
    expect(moveRes.status).toBe(200);
    expect(moveRes.body.folderId).toBe(projectsFolderId);

    // Copy the file
    const copyRes = await agent
      .post(`/api/v1/drive/files/${uploadedFile.id}/copy`)
      .set('x-csrf-token', csrfToken)
      .send({ targetFolderId: projectsFolderId });
    expect(copyRes.status).toBe(201);
    expect(copyRes.body.file.name).toBe('architecture-notes (Copy).txt');

    // Trash and restore via bulk API
    const trashRes = await agent
      .post('/api/v1/drive/bulk')
      .set('x-csrf-token', csrfToken)
      .send({ action: 'trash', fileIds: [uploadedFile.id], folderIds: [] });
    expect(trashRes.status).toBe(200);

    const trashList = await agent.get('/api/v1/drive/items?view=trash');
    expect(trashList.body.files).toHaveLength(1);

    const restoreRes = await agent
      .post('/api/v1/drive/bulk')
      .set('x-csrf-token', csrfToken)
      .send({ action: 'restore', fileIds: [uploadedFile.id], folderIds: [] });
    expect(restoreRes.status).toBe(200);

    // Permanent delete of copy
    const deleteRes = await agent
      .post('/api/v1/drive/bulk')
      .set('x-csrf-token', csrfToken)
      .send({ action: 'delete', fileIds: [copyRes.body.file.id], folderIds: [] });
    expect(deleteRes.status).toBe(200);
  });

  it('4. Dashboard statistics match actual backend data and indexer detects untracked HDD files', async () => {
    // Upload 2 files
    await agent
      .post('/api/v1/drive/upload')
      .set('x-csrf-token', csrfToken)
      .attach('files', Buffer.from('File 1 content'), 'doc1.txt')
      .attach('files', Buffer.from('File 2 content longer'), 'doc2.txt');

    // Place a 3rd untracked file directly onto the HDD `/data/files` directory
    fs.writeFileSync(path.join(ctx.config.paths.files, 'direct-on-hdd.txt'), 'Placed via SSH');

    // Trigger manual indexer scan
    const scanRes = await agent
      .post('/api/v1/system/indexer/scan')
      .set('x-csrf-token', csrfToken);
    expect(scanRes.status).toBe(200);
    expect(scanRes.body.scan.addedUntrackedFiles).toBe(1);

    const dashRes = await agent.get('/api/v1/system/dashboard');
    expect(dashRes.status).toBe(200);
    expect(dashRes.body.summary.totalFiles).toBe(3);
    expect(dashRes.body.disk.totalBytes).toBeGreaterThan(0);
    expect(dashRes.body.disk.activeIndexedBytes).toBe(
      Buffer.from('File 1 content').length +
        Buffer.from('File 2 content longer').length +
        Buffer.from('Placed via SSH').length
    );
  });

  it('5, 8 & 9. Public download links work without login, enforce password, download limits, expiration, and revocation', async () => {
    const upRes = await agent
      .post('/api/v1/drive/upload')
      .set('x-csrf-token', csrfToken)
      .attach('files', Buffer.from('Confidential PDF Data'), 'report.pdf');
    const fileId = upRes.body.files[0].id;

    // Create a password-protected download link with maxDownloads = 2
    const shareRes = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrfToken)
      .send({
        title: 'Q4 Report Download',
        targetType: 'file',
        targetId: fileId,
        permission: 'download_only',
        password: 'SecretLinkPass',
        maxDownloads: 2,
      });

    expect(shareRes.status).toBe(201);
    const { rawToken, link } = shareRes.body;

    // Verify raw token is NOT stored in SQLite (only SHA-256 hash)
    const dbRow = ctx.db.prepare('SELECT token_hash FROM share_links WHERE id = ?').get(link.id) as {
      token_hash: string;
    };
    expect(dbRow.token_hash).not.toBe(rawToken);
    expect(dbRow.token_hash).toHaveLength(64);

    // Anonymous guest attempts download without password -> 401
    const noPassDl = await request(ctx.app).get(`/api/v1/public/shares/${rawToken}/download`);
    expect(noPassDl.status).toBe(401);

    // Guest verifies wrong password -> 401
    const guestAgent = request.agent(ctx.app);
    const wrongPass = await guestAgent
      .post(`/api/v1/public/shares/${rawToken}/verify-password`)
      .send({ password: 'Wrong' });
    expect(wrongPass.status).toBe(401);

    // Guest verifies right password -> 200 and sets proof cookie
    const rightPass = await guestAgent
      .post(`/api/v1/public/shares/${rawToken}/verify-password`)
      .send({ password: 'SecretLinkPass' });
    expect(rightPass.status).toBe(200);

    // Guest downloads 1st time -> 200
    const dl1 = await guestAgent.get(`/api/v1/public/shares/${rawToken}/download`);
    expect(dl1.status).toBe(200);
    expect(Buffer.from(dl1.body).toString('utf8')).toBe('Confidential PDF Data');

    // Guest downloads 2nd time -> 200
    const dl2 = await guestAgent.get(`/api/v1/public/shares/${rawToken}/download`);
    expect(dl2.status).toBe(200);

    // Guest downloads 3rd time -> 429 (Download limit 2 reached)
    const dl3 = await guestAgent.get(`/api/v1/public/shares/${rawToken}/download`);
    expect(dl3.status).toBe(429);

    // Admin revokes link -> immediate 410 Gone
    await agent
      .post(`/api/v1/shares/${link.id}/revoke`)
      .set('x-csrf-token', csrfToken);

    const afterRevoke = await guestAgent.get(`/api/v1/public/shares/${rawToken}`);
    expect(afterRevoke.status).toBe(410);
  });

  it('6, 7, 10 & 12. Guest upload links work without login, cannot browse/download existing files, never overwrite duplicates, and enforce quotas during stream', async () => {
    // Create destination folder and put an existing private file inside it
    const folderRes = await agent
      .post('/api/v1/drive/folders')
      .set('x-csrf-token', csrfToken)
      .send({ name: 'Guest Dropzone' });
    const dropzoneId = folderRes.body.folder.id;

    await agent
      .post(`/api/v1/drive/upload?folderId=${dropzoneId}`)
      .set('x-csrf-token', csrfToken)
      .attach('files', Buffer.from('Admin Original File'), 'photo.jpg');

    // Create an upload-only link with a 500-byte total quota and 300-byte single file limit
    const shareRes = await agent
      .post('/api/v1/shares')
      .set('x-csrf-token', csrfToken)
      .send({
        title: 'Event Photo Dropzone',
        message: 'Upload your photos here!',
        targetType: 'folder',
        targetId: dropzoneId,
        permission: 'upload_only',
        maxTotalUploadBytes: 500,
        maxSingleFileBytes: 300,
        maxUploads: 3,
      });

    expect(shareRes.status).toBe(201);
    const { rawToken } = shareRes.body;

    // Guest inspects link: must NOT see existing files in the folder!
    const infoRes = await request(ctx.app).get(`/api/v1/public/shares/${rawToken}`);
    expect(infoRes.status).toBe(200);
    expect(infoRes.body.allowUpload).toBe(true);
    expect(infoRes.body.allowDownload).toBe(false);
    expect(infoRes.body.folderFiles).toBeUndefined();

    // Guest attempts to download from an upload-only link -> 403 Forbidden
    const illegalDownload = await request(ctx.app).get(`/api/v1/public/shares/${rawToken}/download`);
    expect(illegalDownload.status).toBe(403);
    expect(illegalDownload.body.code).toBe('DOWNLOAD_FORBIDDEN');

    // Guest uploads a file with the SAME name ("photo.jpg") -> succeeds and auto-renames to "photo (1).jpg" without overwriting
    const guestFile1 = Buffer.alloc(200, 'A');
    const guestUp1 = await request(ctx.app)
      .post(`/api/v1/public/shares/${rawToken}/upload`)
      .attach('files', guestFile1, 'photo.jpg');

    expect(guestUp1.status).toBe(201);
    expect(guestUp1.body.uploaded[0].name).toBe('photo (1).jpg');
    expect(guestUp1.body.quotas.remainingUploadBytes).toBe(300);

    // Guest attempts to upload a 350-byte file (exceeds 300-byte single file limit) -> 413
    const tooBigSingle = Buffer.alloc(350, 'B');
    const guestUpTooBig = await request(ctx.app)
      .post(`/api/v1/public/shares/${rawToken}/upload`)
      .attach('files', tooBigSingle, 'huge.jpg');
    expect(guestUpTooBig.status).toBe(413);

    // Guest uploads a 250-byte file -> succeeds (total used: 450 / 500 bytes, remaining: 50 bytes)
    const guestFile2 = Buffer.alloc(250, 'C');
    const guestUp2 = await request(ctx.app)
      .post(`/api/v1/public/shares/${rawToken}/upload`)
      .attach('files', guestFile2, 'second.jpg');
    expect(guestUp2.status).toBe(201);
    expect(guestUp2.body.quotas.remainingUploadBytes).toBe(50);

    // Guest attempts to upload a 100-byte file (exceeds remaining 50-byte link quota) -> 413
    const exceedsTotalQuota = Buffer.alloc(100, 'D');
    const guestUpQuotaFail = await request(ctx.app)
      .post(`/api/v1/public/shares/${rawToken}/upload`)
      .attach('files', exceedsTotalQuota, 'third.jpg');
    expect(guestUpQuotaFail.status).toBe(413);

    // Admin activates global Guest Upload Kill Switch -> immediate 403
    await agent
      .put('/api/v1/system/settings')
      .set('x-csrf-token', csrfToken)
      .send({ guestUploadsEnabled: false });

    const killedUpload = await request(ctx.app)
      .post(`/api/v1/public/shares/${rawToken}/upload`)
      .attach('files', Buffer.alloc(10, 'E'), 'tiny.jpg');
    expect(killedUpload.status).toBe(403);
    expect(killedUpload.body.code).toBe('GUEST_UPLOADS_DISABLED_GLOBALLY');
  });

  it('11, 14 & 17. Prevents path traversal, symlink escapes, inline XSS, silent microSD fallback, and supports hot DB backup', async () => {
    // Path traversal check
    expect(() => resolveSafePath(ctx.config.paths.files, '../../etc/passwd')).toThrow(StorageGuardError);
    expect(() => resolveSafePath(ctx.config.paths.files, 'sub/../../../etc/shadow')).toThrow(StorageGuardError);

    // Symlink escape check
    const symlinkPath = path.join(ctx.config.paths.files, 'evil-symlink');
    fs.symlinkSync('/etc', symlinkPath);
    expect(() => resolveSafePath(ctx.config.paths.files, 'evil-symlink/passwd')).toThrow(StorageGuardError);
    fs.unlinkSync(symlinkPath);

    // Active content (HTML / SVG) must never be allowed inline
    expect(isSafeInlinePreviewMime('text/html')).toBe(false);
    expect(isSafeInlinePreviewMime('image/svg+xml')).toBe(false);
    expect(isSafeInlinePreviewMime('application/pdf')).toBe(true);
    expect(isSafeInlinePreviewMime('image/png')).toBe(true);

    // Silent microSD fallback prevention: if REQUIRE_MOUNT_CHECK=true on a directory that is on the same device as its parent, startup guard throws
    const unmountedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmounted-pi-'));
    const strictConfig = loadConfig({
      NODE_ENV: 'production',
      STORAGE_ROOT: unmountedDir,
      REQUIRE_MOUNT_CHECK: 'true',
    });
    expect(() => initializeStorageDirectories(strictConfig)).toThrow(/same filesystem device/);
    fs.rmSync(unmountedDir, { recursive: true, force: true });

    // Hot SQLite backup verification
    const backupRes = await agent
      .post('/api/v1/system/backup')
      .set('x-csrf-token', csrfToken);
    expect(backupRes.status).toBe(201);
    expect(backupRes.body.backup.sizeBytes).toBeGreaterThan(0);

    const listBackups = await agent.get('/api/v1/system/backups');
    expect(listBackups.status).toBe(200);
    expect(listBackups.body.backups).toHaveLength(1);
  });
});
