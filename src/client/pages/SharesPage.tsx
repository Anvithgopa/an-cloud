import React, { useState, useEffect, useCallback } from 'react';
import {
  Share2,
  UploadCloud,
  Download,
  Lock,
  Ban,
  Copy,
  Check,
  RefreshCw,
  Folder,
  FileText,
  ChevronDown,
  ChevronUp,
  Plus,
  Edit3,
  Power,
  X,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import { ShareModal } from '../components/ShareModal';

interface SharesPageProps {
  uploadOnlyFilter?: boolean;
}

export const SharesPage: React.FC<SharesPageProps> = ({ uploadOnlyFilter = false }) => {
  const [links, setLinks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedLinkId, setExpandedLinkId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [regeneratedUrls, setRegeneratedUrls] = useState<Record<string, string>>({});
  const [createModalOpen, setCreateModalOpen] = useState(false);

  // Edit modal state
  const [editingLink, setEditingLink] = useState<any | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editMessage, setEditMessage] = useState('');
  const [editMaxDownloads, setEditMaxDownloads] = useState('');
  const [editMaxUploads, setEditMaxUploads] = useState('');
  const [editMaxTotalUploadMB, setEditMaxTotalUploadMB] = useState('');

  const loadShares = useCallback(async () => {
    setLoading(true);
    try {
      const filter = uploadOnlyFilter ? 'upload' : 'all';
      const res = await apiRequest(`/api/v1/shares?filter=${filter}`);
      setLinks(res.links || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [uploadOnlyFilter]);

  useEffect(() => {
    loadShares();
  }, [loadShares]);

  const handleToggleEnabled = async (link: any) => {
    try {
      await apiRequest(`/api/v1/shares/${link.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: !link.isEnabled }),
      });
      await loadShares();
    } catch (err) {
      console.error(err);
    }
  };

  const handleRevoke = async (linkId: string) => {
    try {
      await apiRequest(`/api/v1/shares/${linkId}/revoke`, { method: 'POST' });
      await loadShares();
    } catch (err) {
      console.error(err);
    }
  };

  const handleRegenerateAndCopy = async (linkId: string) => {
    try {
      // If we already have the raw URL in memory, copy it directly; otherwise issue a fresh high-entropy token
      let url = regeneratedUrls[linkId];
      if (!url) {
        const res = await apiRequest(`/api/v1/shares/${linkId}/regenerate-token`, {
          method: 'POST',
        });
        url = `${window.location.origin}${res.shareUrlPath}`;
        setRegeneratedUrls((prev) => ({ ...prev, [linkId]: url }));
      }
      await navigator.clipboard.writeText(url);
      setCopiedId(linkId);
      setTimeout(() => setCopiedId(null), 2500);
      await loadShares();
    } catch (err) {
      console.error(err);
    }
  };

  const openEditModal = (link: any) => {
    setEditingLink(link);
    setEditTitle(link.title);
    setEditMessage(link.message || '');
    setEditMaxDownloads(link.quotas.maxDownloads ? String(link.quotas.maxDownloads) : '');
    setEditMaxUploads(link.quotas.maxUploads ? String(link.quotas.maxUploads) : '');
    setEditMaxTotalUploadMB(
      link.quotas.maxTotalUploadBytes
        ? String(Math.round(link.quotas.maxTotalUploadBytes / (1024 * 1024)))
        : ''
    );
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingLink) return;
    try {
      await apiRequest(`/api/v1/shares/${editingLink.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: editTitle.trim(),
          message: editMessage.trim() || null,
          maxDownloads: editMaxDownloads ? parseInt(editMaxDownloads, 10) : null,
          maxUploads: editMaxUploads ? parseInt(editMaxUploads, 10) : null,
          maxTotalUploadBytes: editMaxTotalUploadMB
            ? Math.round(Number(editMaxTotalUploadMB) * 1024 * 1024)
            : null,
        }),
      });
      setEditingLink(null);
      await loadShares();
    } catch (err) {
      console.error(err);
    }
  };

  const renderStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/60">
            Active
          </span>
        );
      case 'disabled':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/60">
            Paused
          </span>
        );
      case 'expired':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
            Expired
          </span>
        );
      case 'quota_exhausted':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-orange-50 dark:bg-orange-950/60 text-orange-700 dark:text-orange-300">
            Quota Exhausted
          </span>
        );
      default:
        return (
          <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300">
            Revoked
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {uploadOnlyFilter ? 'Shared with Upload Permission' : 'Shared by Me'}
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {uploadOnlyFilter
              ? 'Manage guest upload dropzones, storage quotas, and inspect files uploaded by external guests'
              : 'Manage all public download and guest upload share links. Only SHA-256 token hashes are stored on disk.'}
          </p>
        </div>

        <button
          onClick={() => setCreateModalOpen(true)}
          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-xs self-start"
        >
          <Plus className="w-4 h-4" />
          {uploadOnlyFilter ? 'New Guest Upload Link' : 'New Public Share Link'}
        </button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 bg-slate-200 dark:bg-slate-800 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : links.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 flex items-center justify-center mx-auto">
            {uploadOnlyFilter ? <UploadCloud className="w-6 h-6" /> : <Share2 className="w-6 h-6" />}
          </div>
          <div className="text-sm font-semibold text-slate-900 dark:text-white">
            No {uploadOnlyFilter ? 'guest upload' : 'shared'} links created yet
          </div>
          <p className="text-xs text-slate-500 max-w-md mx-auto">
            Create a secure public link to let people download files or upload files into a designated folder without needing an account.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {links.map((link) => {
            const isExpanded = expandedLinkId === link.id;
            return (
              <div
                key={link.id}
                className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 sm:p-5 shadow-2xs space-y-3"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                      {link.targetType === 'folder' ? (
                        <Folder className="w-5 h-5" />
                      ) : (
                        <FileText className="w-5 h-5" />
                      )}
                    </div>

                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center flex-wrap gap-2">
                        <span className="font-semibold text-sm text-slate-900 dark:text-white">
                          {link.title}
                        </span>
                        {renderStatusBadge(link.status)}
                        <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                          {link.permission === 'upload_only'
                            ? 'Upload Only (Dropzone)'
                            : link.permission === 'upload_and_download'
                            ? 'Upload & Download'
                            : 'Download Only'}
                        </span>
                        {link.hasPassword && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300">
                            <Lock className="w-3 h-3" /> Password
                          </span>
                        )}
                      </div>

                      <div className="text-xs text-slate-500 flex items-center flex-wrap gap-x-4 gap-y-1">
                        <span>
                          Target: <strong className="text-slate-700 dark:text-slate-300">{link.targetName}</strong> ({link.targetType})
                        </span>
                        <span>Created: {formatDateTime(link.createdAt)}</span>
                        <span>
                          Expires: {link.expiresAt ? formatDateTime(link.expiresAt) : 'Never'}
                        </span>
                        <span className="font-mono text-[11px]">
                          Token hash prefix: {link.tokenPrefix}…
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Metrics & Action Controls */}
                  <div className="flex items-center flex-wrap gap-2 shrink-0">
                    {link.allowDownload && (
                      <div className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800/70 text-xs">
                        <span className="text-slate-400 mr-1">Downloads:</span>
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {link.quotas.currentDownloads}
                          {link.quotas.maxDownloads ? ` / ${link.quotas.maxDownloads}` : ''}
                        </span>
                      </div>
                    )}

                    {link.allowUpload && (
                      <div className="px-3 py-1.5 rounded-xl bg-slate-50 dark:bg-slate-800/70 text-xs">
                        <span className="text-slate-400 mr-1">Uploaded:</span>
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {link.quotas.currentUploads} files (
                          {formatBytes(link.quotas.currentUploadedBytes)}
                          {link.quotas.maxTotalUploadBytes
                            ? ` / ${formatBytes(link.quotas.maxTotalUploadBytes)}`
                            : ''}
                          )
                        </span>
                      </div>
                    )}

                    {!link.isRevoked && (
                      <>
                        <button
                          onClick={() => handleRegenerateAndCopy(link.id)}
                          title="Copy or rotate public share URL"
                          className="px-3 py-1.5 rounded-xl bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 text-blue-700 dark:text-blue-300 text-xs font-medium flex items-center gap-1.5"
                        >
                          {copiedId === link.id ? (
                            <>
                              <Check className="w-3.5 h-3.5" />
                              Copied URL
                            </>
                          ) : regeneratedUrls[link.id] ? (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              Copy Link
                            </>
                          ) : (
                            <>
                              <RefreshCw className="w-3.5 h-3.5" />
                              Get / Copy Link
                            </>
                          )}
                        </button>

                        <button
                          onClick={() => openEditModal(link)}
                          title="Edit quotas and settings"
                          className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-600 dark:text-slate-300"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => handleToggleEnabled(link)}
                          title={link.isEnabled ? 'Disable link temporarily' : 'Enable link'}
                          className={`p-2 rounded-xl ${
                            link.isEnabled
                              ? 'bg-amber-50 dark:bg-amber-950/50 text-amber-600'
                              : 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600'
                          }`}
                        >
                          <Power className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => handleRevoke(link.id)}
                          title="Revoke link permanently"
                          className="px-3 py-1.5 rounded-xl bg-red-50 dark:bg-red-950/60 hover:bg-red-100 text-red-600 dark:text-red-400 text-xs font-medium flex items-center gap-1"
                        >
                          <Ban className="w-3.5 h-3.5" />
                          Revoke
                        </button>
                      </>
                    )}

                    {link.allowUpload && (
                      <button
                        onClick={() =>
                          setExpandedLinkId(isExpanded ? null : link.id)
                        }
                        className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                        title="View guest uploaded files"
                      >
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded Guest Upload Records & Quota Bar */}
                {link.allowUpload && isExpanded && (
                  <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-3">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-700 dark:text-slate-300">
                        Remaining Link Quota:{' '}
                        {link.quotas.remainingUploadBytes !== null
                          ? formatBytes(link.quotas.remainingUploadBytes)
                          : 'Unlimited'}
                      </span>
                      <span className="text-slate-500">
                        Max Single File:{' '}
                        {link.quotas.maxSingleFileBytes
                          ? formatBytes(link.quotas.maxSingleFileBytes)
                          : 'Default'}
                      </span>
                    </div>

                    <div>
                      <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
                        Files Uploaded by Guests ({link.guestUploads?.length || 0})
                      </div>
                      {!link.guestUploads || link.guestUploads.length === 0 ? (
                        <div className="text-xs text-slate-400 py-3">
                          No files have been uploaded through this link yet.
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-100 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                          {link.guestUploads.map((gu: any) => (
                            <div
                              key={gu.id}
                              className="px-3.5 py-2 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between text-xs"
                            >
                              <div className="min-w-0">
                                <span className="font-medium text-slate-900 dark:text-white">
                                  {gu.originalFilename}
                                </span>
                                <span className="text-slate-400 ml-2">
                                  ({gu.mimeType}) • IP: {gu.uploaderIp || 'unknown'}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 shrink-0">
                                <span className="font-mono text-slate-600 dark:text-slate-300">
                                  {formatBytes(gu.sizeBytes)}
                                </span>
                                <span className="text-slate-400">
                                  {formatDateTime(gu.uploadedAt)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Edit Share Link Modal */}
      {editingLink && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <form
            onSubmit={handleSaveEdit}
            className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-4 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900 dark:text-white">
                Edit Share Link Settings
              </h3>
              <button
                type="button"
                onClick={() => setEditingLink(null)}
                className="p-1 text-slate-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                Link Title
              </label>
              <input
                type="text"
                required
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                Recipient Message
              </label>
              <input
                type="text"
                value={editMessage}
                onChange={(e) => setEditMessage(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
              />
            </div>

            {editingLink.allowDownload && (
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                  Max Downloads Limit
                </label>
                <input
                  type="number"
                  min="1"
                  value={editMaxDownloads}
                  onChange={(e) => setEditMaxDownloads(e.target.value)}
                  placeholder="Unlimited"
                  className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                />
              </div>
            )}

            {editingLink.allowUpload && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Total Upload Quota (MB)
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={editMaxTotalUploadMB}
                    onChange={(e) => setEditMaxTotalUploadMB(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
                    Max Uploaded Files
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={editMaxUploads}
                    onChange={(e) => setEditMaxUploads(e.target.value)}
                    placeholder="Unlimited"
                    className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                  />
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingLink(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
              >
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}

      <ShareModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        defaultMode={uploadOnlyFilter ? 'upload_only' : 'download_only'}
        onCreated={loadShares}
      />
    </div>
  );
};
