import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  HardDrive,
  Lock,
  Download,
  UploadCloud,
  FileText,
  Folder,
  CheckCircle2,
  AlertCircle,
  Clock,
  ShieldCheck,
  Eye,
  X,
} from 'lucide-react';
import { apiRequest, uploadFilesWithProgress } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import { PreviewModal, PreviewableFile } from '../components/PreviewModal';

export const PublicSharePage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [share, setShare] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  // Password state
  const [password, setPassword] = useState('');
  const [verifyingPassword, setVerifyingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Guest upload state
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ loaded: 0, total: 0, percent: 0 });
  const [uploadAbort, setUploadAbort] = useState<(() => void) | null>(null);
  const [uploadSuccessList, setUploadSuccessList] = useState<{ name: string; sizeBytes: number; uploadedAt: string }[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Preview modal for download-authorized files
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadShareInfo = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest(`/api/v1/public/shares/${token}`);
      setShare(res);
    } catch (err: any) {
      setError({ message: err.message || 'This link is unavailable', code: err.code });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadShareInfo();
  }, [loadShareInfo]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !password) return;
    setVerifyingPassword(true);
    setPasswordError(null);
    try {
      await apiRequest(`/api/v1/public/shares/${token}/verify-password`, {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      await loadShareInfo();
    } catch (err: any) {
      setPasswordError(err.message || 'Incorrect password');
    } finally {
      setVerifyingPassword(false);
    }
  };

  const handleAddFiles = (files: File[]) => {
    setUploadError(null);
    setSelectedFiles((prev) => [...prev, ...files]);
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleStartGuestUpload = async () => {
    if (!token || selectedFiles.length === 0) return;
    setUploading(true);
    setUploadError(null);

    const task = uploadFilesWithProgress({
      url: `/api/v1/public/shares/${token}/upload`,
      files: selectedFiles,
      onProgress: (loaded, total, percent) => {
        setUploadProgress({ loaded, total, percent });
      },
    });

    setUploadAbort(() => task.abort);

    try {
      const res = await task.promise;
      setUploadSuccessList((prev) => [...(res.uploaded || []), ...prev]);
      setSelectedFiles([]);
      await loadShareInfo();
    } catch (err: any) {
      setUploadError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
      setUploadAbort(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Clean Header */}
      <header className="h-16 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 sm:px-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-2xs">
            <HardDrive className="w-5 h-5" />
          </div>
          <div>
            <span className="font-bold text-base tracking-tight">AN Cloud</span>
            <span className="hidden sm:inline-block text-xs text-slate-400 ml-2">
              • Secure Self-Hosted File Sharing
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <ShieldCheck className="w-4 h-4 text-emerald-500" />
          <span>No account required</span>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
        {loading ? (
          <div className="w-full max-w-lg h-64 rounded-2xl bg-slate-200 dark:bg-slate-800 animate-pulse" />
        ) : error ? (
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-8 text-center space-y-4 shadow-lg">
            <div className="w-12 h-12 rounded-2xl bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 flex items-center justify-center mx-auto">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h1 className="text-lg font-bold text-slate-900 dark:text-white">
              Link Unavailable
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {error.message}
            </p>
            {error.code && (
              <div className="text-[11px] font-mono text-slate-400">
                Status code: {error.code}
              </div>
            )}
          </div>
        ) : share?.requiresPassword ? (
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 sm:p-8 space-y-5 shadow-lg">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 flex items-center justify-center shrink-0">
                <Lock className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-900 dark:text-white">
                  {share.title || 'Protected Share Link'}
                </h1>
                <p className="text-xs text-slate-500">
                  Enter the link password provided by the owner to continue
                </p>
              </div>
            </div>

            {passwordError && (
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-300">
                {passwordError}
              </div>
            )}

            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <input
                type="password"
                required
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter link password..."
                className="w-full px-3.5 py-2.5 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:border-blue-500 focus:outline-hidden"
              />
              <button
                type="submit"
                disabled={verifyingPassword}
                className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow-xs"
              >
                {verifyingPassword ? 'Verifying...' : 'Unlock Share Link'}
              </button>
            </form>
          </div>
        ) : share ? (
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 sm:p-8 space-y-6 shadow-lg">
            {/* Title, Owner Message & Expiry Meta */}
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-5 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-start gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                  {share.allowUpload && !share.allowDownload ? (
                    <UploadCloud className="w-6 h-6" />
                  ) : share.targetType === 'folder' ? (
                    <Folder className="w-6 h-6" />
                  ) : (
                    <FileText className="w-6 h-6" />
                  )}
                </div>
                <div className="space-y-1">
                  <h1 className="text-xl font-bold text-slate-900 dark:text-white">
                    {share.title}
                  </h1>
                  {share.message && (
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                      {share.message}
                    </p>
                  )}
                  <div className="flex items-center flex-wrap gap-3 text-xs text-slate-400 pt-1">
                    <span>
                      Target: <strong className="text-slate-600 dark:text-slate-300">{share.targetName}</strong>
                    </span>
                    {share.expiresAt && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        Expires {formatDateTime(share.expiresAt)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* SECTION A: Download Authorized Content */}
            {share.allowDownload && (
              <div className="space-y-4">
                {share.targetType === 'file' && share.fileMeta ? (
                  <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                        {share.fileMeta.name}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {formatBytes(share.fileMeta.sizeBytes)} • {share.fileMeta.mimeType}
                        {share.quotas.remainingDownloads !== null &&
                          ` • ${share.quotas.remainingDownloads} download(s) remaining`}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {share.fileMeta.canPreviewInline && (
                        <button
                          onClick={() =>
                            setPreviewFile({
                              id: 'shared',
                              name: share.fileMeta.name,
                              mimeType: share.fileMeta.mimeType,
                              category: share.fileMeta.mimeType.startsWith('image/')
                                ? 'image'
                                : share.fileMeta.mimeType.startsWith('video/')
                                ? 'video'
                                : share.fileMeta.mimeType.startsWith('audio/')
                                ? 'audio'
                                : share.fileMeta.mimeType === 'application/pdf'
                                ? 'pdf'
                                : 'other',
                              sizeBytes: share.fileMeta.sizeBytes,
                              canPreviewInline: true,
                              contentUrl: `/api/v1/public/shares/${token}/download?inline=1`,
                              downloadUrl: `/api/v1/public/shares/${token}/download`,
                            })
                          }
                          className="px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-semibold flex items-center gap-1.5"
                        >
                          <Eye className="w-4 h-4" />
                          Preview
                        </button>
                      )}

                      <a
                        href={`/api/v1/public/shares/${token}/download`}
                        download={share.fileMeta.name}
                        className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-2 shadow-xs"
                      >
                        <Download className="w-4 h-4" />
                        Download File
                      </a>
                    </div>
                  </div>
                ) : (
                  /* Shared Folder Download & File Listing */
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                        Shared Folder Contents ({share.folderFiles?.length || 0} files)
                      </span>
                      <a
                        href={`/api/v1/public/shares/${token}/download`}
                        className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-xs"
                      >
                        <Download className="w-4 h-4" />
                        Download Folder (.ZIP)
                      </a>
                    </div>

                    {share.folderFiles && share.folderFiles.length > 0 ? (
                      <div className="divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden max-h-72 overflow-y-auto">
                        {share.folderFiles.map((f: any) => (
                          <div
                            key={f.id}
                            className="px-4 py-2.5 flex items-center justify-between gap-3 bg-white dark:bg-slate-900 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="font-medium text-slate-900 dark:text-white truncate">
                                {f.name}
                              </div>
                              <div className="text-[11px] text-slate-400">
                                {formatBytes(f.sizeBytes)}
                              </div>
                            </div>
                            <a
                              href={`/api/v1/public/shares/${token}/download?fileId=${f.id}`}
                              download={f.name}
                              className="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-200 font-medium flex items-center gap-1 shrink-0"
                            >
                              <Download className="w-3.5 h-3.5" />
                              Download
                            </a>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="p-6 rounded-xl bg-slate-50 dark:bg-slate-800/40 text-center text-xs text-slate-400">
                        This shared folder currently has no files.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* SECTION B: Guest Upload Dropzone */}
            {share.guestUploadsGloballyDisabled && (
              <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
                Guest uploads are temporarily paused by the server administrator.
              </div>
            )}

            {share.allowUpload && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs bg-slate-50 dark:bg-slate-800/60 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800">
                  <div>
                    <span className="text-slate-500">Remaining Quota: </span>
                    <strong className="text-slate-900 dark:text-white">
                      {share.quotas.remainingUploadBytes !== null
                        ? formatBytes(share.quotas.remainingUploadBytes)
                        : 'Unlimited'}
                    </strong>
                  </div>
                  {share.quotas.maxSingleFileBytes && (
                    <div>
                      <span className="text-slate-500">Max File Size: </span>
                      <strong className="text-slate-900 dark:text-white">
                        {formatBytes(share.quotas.maxSingleFileBytes)}
                      </strong>
                    </div>
                  )}
                  {share.quotas.remainingUploads !== null && (
                    <div>
                      <span className="text-slate-500">Files Allowed: </span>
                      <strong className="text-slate-900 dark:text-white">
                        {share.quotas.remainingUploads} more
                      </strong>
                    </div>
                  )}
                </div>

                {/* Drag and Drop Area */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={(e) => {
                    if (e.target.files) {
                      handleAddFiles(Array.from(e.target.files));
                    }
                    e.target.value = '';
                  }}
                  className="hidden"
                />

                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setIsDragging(false);
                    if (e.dataTransfer.files) {
                      handleAddFiles(Array.from(e.dataTransfer.files));
                    }
                  }}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
                    isDragging
                      ? 'border-blue-600 bg-blue-50/60 dark:bg-blue-950/40'
                      : 'border-slate-300 dark:border-slate-700 hover:border-blue-500 hover:bg-slate-50/70 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <UploadCloud className="w-10 h-10 text-blue-600 mx-auto mb-2.5" />
                  <div className="text-sm font-semibold text-slate-900 dark:text-white">
                    Drag & drop files here, or click to browse
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Files are streamed directly to the owner&apos;s folder without overwriting existing files
                  </p>
                </div>

                {/* Selected Files Queue */}
                {selectedFiles.length > 0 && (
                  <div className="space-y-3">
                    <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      Ready to Upload ({selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''})
                    </div>
                    <div className="divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 max-h-48 overflow-y-auto">
                      {selectedFiles.map((f, idx) => (
                        <div
                          key={`${f.name}-${idx}`}
                          className="px-3.5 py-2 flex items-center justify-between text-xs"
                        >
                          <span className="truncate font-medium">{f.name}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-mono text-slate-500">{formatBytes(f.size)}</span>
                            {!uploading && (
                              <button
                                onClick={() => handleRemoveFile(idx)}
                                className="p-1 text-slate-400 hover:text-red-500"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    {uploading ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-xs font-medium">
                          <span>Uploading... {uploadProgress.percent}%</span>
                          {uploadAbort && (
                            <button
                              onClick={uploadAbort}
                              className="text-red-600 hover:underline"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                        <div className="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                          <div
                            className="h-full bg-blue-600 transition-all"
                            style={{ width: `${uploadProgress.percent}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={handleStartGuestUpload}
                        className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow-xs"
                      >
                        Upload {selectedFiles.length} File{selectedFiles.length > 1 ? 's' : ''} Now
                      </button>
                    )}
                  </div>
                )}

                {uploadError && (
                  <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{uploadError}</span>
                  </div>
                )}

                {uploadSuccessList.length > 0 && (
                  <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/70 space-y-2">
                    <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      Successfully Uploaded ({uploadSuccessList.length})
                    </div>
                    <ul className="text-xs text-emerald-700 dark:text-emerald-300 space-y-1">
                      {uploadSuccessList.map((u, idx) => (
                        <li key={idx} className="flex items-center justify-between">
                          <span className="truncate">{u.name}</span>
                          <span className="font-mono">{formatBytes(u.sizeBytes)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : null}
      </main>

      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
};
