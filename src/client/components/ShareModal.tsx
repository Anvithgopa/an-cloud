import React, { useState, useEffect } from 'react';
import {
  X,
  Share2,
  Copy,
  Check,
  Lock,
  Calendar,
  Download,
  Upload,
  Folder,
  FileText,
  ShieldAlert,
  ExternalLink,
} from 'lucide-react';
import { apiRequest } from '../lib/api';

export interface ShareTarget {
  type: 'file' | 'folder';
  id: string;
  name: string;
  defaultPermission?: 'download_only' | 'upload_only' | 'upload_and_download';
}

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTarget?: ShareTarget | null;
  defaultMode?: 'download_only' | 'upload_only';
  onCreated?: () => void;
}

export const ShareModal: React.FC<ShareModalProps> = ({
  isOpen,
  onClose,
  initialTarget,
  defaultMode = 'download_only',
  onCreated,
}) => {
  const [folders, setFolders] = useState<{ id: string; name: string }[]>([]);
  const [targetType, setTargetType] = useState<'file' | 'folder'>(initialTarget?.type || 'folder');
  const [targetId, setTargetId] = useState<string>(initialTarget?.id || '');
  const [title, setTitle] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [permission, setPermission] = useState<'download_only' | 'upload_only' | 'upload_and_download'>(
    initialTarget?.defaultPermission || (initialTarget?.type === 'file' ? 'download_only' : defaultMode)
  );
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<string>('');
  const [maxDownloads, setMaxDownloads] = useState<string>('');
  const [maxUploads, setMaxUploads] = useState<string>('');
  const [maxTotalUploadMB, setMaxTotalUploadMB] = useState<string>('1024');
  const [maxSingleFileMB, setMaxSingleFileMB] = useState<string>('512');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdShareUrl, setCreatedShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setCreatedShareUrl(null);
    setError(null);
    setPassword('');
    setCopied(false);

    if (initialTarget) {
      setTargetType(initialTarget.type);
      setTargetId(initialTarget.id);
      setTitle(
        initialTarget.defaultPermission === 'upload_only'
          ? `${initialTarget.name} — Guest Upload Dropzone`
          : `Shared: ${initialTarget.name}`
      );
      setPermission(
        initialTarget.defaultPermission ||
          (initialTarget.type === 'file' ? 'download_only' : defaultMode)
      );
    } else {
      setTargetType('folder');
      setPermission(defaultMode);
      setTitle(defaultMode === 'upload_only' ? 'Guest File Dropzone' : 'Shared Folder');
    }

    // Load folders if user needs to pick a destination folder
    apiRequest('/api/v1/drive/folders/tree')
      .then((res) => {
        const list = res.folders || [];
        setFolders(list);
        if (!initialTarget && list.length > 0) {
          setTargetId(list[0].id);
        }
      })
      .catch(() => {});
  }, [isOpen, initialTarget, defaultMode]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!targetId) {
      setError('Please select a target file or folder first.');
      return;
    }

    setSubmitting(true);
    try {
      let expiresAt: string | null = null;
      if (expiresInDays && Number(expiresInDays) > 0) {
        const exp = new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000);
        expiresAt = exp.toISOString();
      }

      const payload: Record<string, any> = {
        title: title.trim() || 'Shared Link',
        message: message.trim() || null,
        targetType,
        targetId,
        permission: targetType === 'file' ? 'download_only' : permission,
        password: password.trim() || null,
        expiresAt,
      };

      if (maxDownloads && Number(maxDownloads) > 0) {
        payload.maxDownloads = parseInt(maxDownloads, 10);
      }
      if (maxUploads && Number(maxUploads) > 0) {
        payload.maxUploads = parseInt(maxUploads, 10);
      }
      if (permission !== 'download_only') {
        if (maxTotalUploadMB && Number(maxTotalUploadMB) > 0) {
          payload.maxTotalUploadBytes = Math.round(Number(maxTotalUploadMB) * 1024 * 1024);
        }
        if (maxSingleFileMB && Number(maxSingleFileMB) > 0) {
          payload.maxSingleFileBytes = Math.round(Number(maxSingleFileMB) * 1024 * 1024);
        }
      }

      const res = await apiRequest('/api/v1/shares', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const fullUrl = `${window.location.origin}${res.shareUrlPath}`;
      setCreatedShareUrl(fullUrl);
      if (onCreated) onCreated();
    } catch (err: any) {
      setError(err.message || 'Failed to create share link');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async () => {
    if (!createdShareUrl) return;
    try {
      await navigator.clipboard.writeText(createdShareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-950/80 text-blue-600 dark:text-blue-400 flex items-center justify-center">
              <Share2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">
                {createdShareUrl ? 'Public Share Link Ready' : 'Create Public Share Link'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Recipients can access without creating an account or logging in
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {createdShareUrl ? (
          <div className="p-6 space-y-5">
            <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-xs text-emerald-800 dark:text-emerald-300">
              Your high-entropy link has been generated. Only its cryptographic hash is stored in the database, so copy this URL now.
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                Shareable Public URL
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={createdShareUrl}
                  className="flex-1 px-3.5 py-2.5 text-xs font-mono rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium flex items-center gap-1.5 shrink-0"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? 'Copied' : 'Copy Link'}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800">
              <a
                href={createdShareUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open guest page in new tab
              </a>
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-medium"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            {error && (
              <div className="p-3 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Target Item Display or Folder Selector */}
            {initialTarget ? (
              <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/70 border border-slate-200 dark:border-slate-800 flex items-center gap-3">
                {initialTarget.type === 'folder' ? (
                  <Folder className="w-5 h-5 text-blue-600 shrink-0" />
                ) : (
                  <FileText className="w-5 h-5 text-blue-600 shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                    {initialTarget.name}
                  </div>
                  <div className="text-[11px] text-slate-500 capitalize">
                    Target {initialTarget.type}
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Destination Folder
                </label>
                {folders.length === 0 ? (
                  <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
                    No folders exist yet. Please create a folder in My Drive first to share or receive guest uploads.
                  </div>
                ) : (
                  <select
                    value={targetId}
                    onChange={(e) => setTargetId(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                  >
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {/* Link Title & Message */}
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Link Title
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Family Vacation Photos"
                  className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Optional Message for Recipients
                </label>
                <input
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Instructions or note shown on the public share page"
                  className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                />
              </div>
            </div>

            {/* Permission Selector (for folders) */}
            {targetType === 'folder' && (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  Explicit Access Permission
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setPermission('download_only')}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      permission === 'download_only'
                        ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <Download className="w-4 h-4 mb-1" />
                    <div className="text-xs font-semibold">Download Only</div>
                    <div className="text-[10px] text-slate-500">View & download</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPermission('upload_only')}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      permission === 'upload_only'
                        ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <Upload className="w-4 h-4 mb-1" />
                    <div className="text-xs font-semibold">Upload Only</div>
                    <div className="text-[10px] text-slate-500">Blind dropzone</div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPermission('upload_and_download')}
                    className={`p-2.5 rounded-xl border text-left transition-all ${
                      permission === 'upload_and_download'
                        ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                        : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                    }`}
                  >
                    <Share2 className="w-4 h-4 mb-1" />
                    <div className="text-xs font-semibold">Upload & Download</div>
                    <div className="text-[10px] text-slate-500">Full collaboration</div>
                  </button>
                </div>
              </div>
            )}

            {/* Security: Password & Expiration */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  <Lock className="w-3.5 h-3.5 text-slate-400" />
                  Optional Link Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave blank for no password"
                  className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                />
              </div>

              <div>
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  <Calendar className="w-3.5 h-3.5 text-slate-400" />
                  Expiration (Days)
                </label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                  placeholder="Never expires"
                  className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                />
              </div>
            </div>

            {/* Quotas based on permission */}
            {(permission === 'download_only' || permission === 'upload_and_download') && (
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Optional Maximum Download Limit
                </label>
                <input
                  type="number"
                  min="1"
                  value={maxDownloads}
                  onChange={(e) => setMaxDownloads(e.target.value)}
                  placeholder="Unlimited downloads"
                  className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                />
              </div>
            )}

            {(permission === 'upload_only' || permission === 'upload_and_download') && (
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-800 space-y-3">
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                  Guest Upload Quotas & Safeguards
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Total Quota (MB)</label>
                    <input
                      type="number"
                      min="1"
                      value={maxTotalUploadMB}
                      onChange={(e) => setMaxTotalUploadMB(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Max File Size (MB)</label>
                    <input
                      type="number"
                      min="1"
                      value={maxSingleFileMB}
                      onChange={(e) => setMaxSingleFileMB(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-500 mb-1">Max File Count</label>
                    <input
                      type="number"
                      min="1"
                      value={maxUploads}
                      onChange={(e) => setMaxUploads(e.target.value)}
                      placeholder="Unlimited"
                      className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || (!initialTarget && folders.length === 0)}
                className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-semibold shadow-xs"
              >
                {submitting ? 'Generating...' : 'Generate Secure Link'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
