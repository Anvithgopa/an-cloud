import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldAlert,
  Lock,
  User,
  Database,
  HardDrive,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  LogOut,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import { useAppState } from '../context/AppContext';

export const SettingsPage: React.FC = () => {
  const { user, refreshAuth, refreshStorageSummary } = useAppState();
  const [settings, setSettings] = useState<any | null>(null);
  const [paths, setPaths] = useState<any | null>(null);
  const [backups, setBackups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Form states for System & Guest Security
  const [guestUploadsEnabled, setGuestUploadsEnabled] = useState(true);
  const [maxFileSizeMB, setMaxFileSizeMB] = useState('2048');
  const [defaultGuestQuotaMB, setDefaultGuestQuotaMB] = useState('1024');
  const [totalGuestQuotaGB, setTotalGuestQuotaGB] = useState('50');
  const [maxConcurrentGuestUploads, setMaxConcurrentGuestUploads] = useState('3');
  const [trackDownloads, setTrackDownloads] = useState(true);
  const [indexerIntervalMinutes, setIndexerIntervalMinutes] = useState('30');

  // Profile & Password states
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [email, setEmail] = useState(user?.email || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [backingUp, setBackingUp] = useState(false);

  const loadSettingsData = useCallback(async () => {
    setLoading(true);
    try {
      const [sysRes, backRes] = await Promise.all([
        apiRequest('/api/v1/system/settings'),
        apiRequest('/api/v1/system/backups'),
      ]);

      const s = sysRes.settings;
      setSettings(s);
      setPaths(sysRes.paths);
      setBackups(backRes.backups || []);

      setGuestUploadsEnabled(Boolean(s.guestUploadsEnabled));
      setMaxFileSizeMB(String(Math.round(s.maxUploadFileSizeBytes / (1024 * 1024))));
      setDefaultGuestQuotaMB(String(Math.round(s.defaultGuestQuotaBytes / (1024 * 1024))));
      setTotalGuestQuotaGB(String(Math.round(s.totalGuestUploadQuotaBytes / (1024 * 1024 * 1024))));
      setMaxConcurrentGuestUploads(String(s.maxConcurrentGuestUploads));
      setTrackDownloads(Boolean(s.trackDownloads));
      setIndexerIntervalMinutes(String(s.indexerIntervalMinutes));
    } catch (err: any) {
      setBanner({ type: 'error', text: err.message || 'Failed to load settings' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettingsData();
  }, [loadSettingsData]);

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName);
      setEmail(user.email || '');
    }
  }, [user]);

  const handleSaveSystemSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    try {
      await apiRequest('/api/v1/system/settings', {
        method: 'PUT',
        body: JSON.stringify({
          guestUploadsEnabled,
          maxUploadFileSizeBytes: Math.round(Number(maxFileSizeMB) * 1024 * 1024),
          defaultGuestQuotaBytes: Math.round(Number(defaultGuestQuotaMB) * 1024 * 1024),
          totalGuestUploadQuotaBytes: Math.round(Number(totalGuestQuotaGB) * 1024 * 1024 * 1024),
          maxConcurrentGuestUploads: parseInt(maxConcurrentGuestUploads, 10),
          trackDownloads,
          indexerIntervalMinutes: parseInt(indexerIntervalMinutes, 10),
        }),
      });
      setBanner({ type: 'success', text: 'System & Guest Upload security settings saved to HDD.' });
      await loadSettingsData();
      await refreshStorageSummary();
    } catch (err: any) {
      setBanner({ type: 'error', text: err.message });
    }
  };

  const handleToggleGuestKillSwitch = async (enabled: boolean) => {
    setGuestUploadsEnabled(enabled);
    try {
      await apiRequest('/api/v1/system/settings', {
        method: 'PUT',
        body: JSON.stringify({ guestUploadsEnabled: enabled }),
      });
      setBanner({
        type: 'success',
        text: enabled
          ? 'Guest uploads re-enabled across active upload links.'
          : 'EMERGENCY KILL SWITCH ACTIVATED: All guest uploads are immediately blocked.',
      });
    } catch (err: any) {
      setBanner({ type: 'error', text: err.message });
    }
  };

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    try {
      await apiRequest('/api/v1/auth/profile', {
        method: 'PUT',
        body: JSON.stringify({ displayName: displayName.trim(), email: email.trim() }),
      });
      await refreshAuth();
      setBanner({ type: 'success', text: 'Administrator profile updated.' });
    } catch (err: any) {
      setBanner({ type: 'error', text: err.message });
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBanner(null);
    try {
      await apiRequest('/api/v1/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setBanner({
        type: 'success',
        text: 'Administrator password updated with Argon2id and other sessions invalidated.',
      });
    } catch (err: any) {
      setBanner({ type: 'error', text: err.message });
    }
  };

  const handleRevokeOtherSessions = async () => {
    setBanner(null);
    try {
      const res = await apiRequest('/api/v1/auth/sessions/revoke-all', { method: 'POST' });
      setBanner({
        type: 'success',
        text: `Revoked ${res.revokedCount} other active session(s).`,
      });
    } catch (err: any) {
      setBanner({ type: 'error', text: err.message });
    }
  };

  const handleCreateBackup = async () => {
    setBackingUp(true);
    setBanner(null);
    try {
      const res = await apiRequest('/api/v1/system/backup', { method: 'POST' });
      setBanner({
        type: 'success',
        text: `Consistent SQLite backup created on HDD: ${res.backup.filename}`,
      });
      await loadSettingsData();
    } catch (err: any) {
      setBanner({ type: 'error', text: err.message });
    } finally {
      setBackingUp(false);
    }
  };

  if (loading) {
    return <div className="h-64 bg-slate-200 dark:bg-slate-800 rounded-2xl animate-pulse" />;
  }

  return (
    <div className="space-y-8 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          System & Security Settings
        </h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Configure guest upload safeguards, quotas, administrator authentication, and HDD backups
        </p>
      </div>

      {banner && (
        <div
          className={`p-4 rounded-2xl border text-xs font-medium flex items-center gap-2.5 ${
            banner.type === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
              : 'bg-red-50 dark:bg-red-950/50 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
          }`}
        >
          {banner.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
          )}
          <span>{banner.text}</span>
        </div>
      )}

      {/* Immediate Guest Upload Master Switch */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
              guestUploadsEnabled
                ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600'
                : 'bg-red-50 dark:bg-red-950/60 text-red-600'
            }`}
          >
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Global Guest Uploads Master Control
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Immediately enable or disable all public guest upload links across the server without deleting individual links.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => handleToggleGuestKillSwitch(!guestUploadsEnabled)}
          className={`px-4 py-2.5 rounded-xl text-xs font-semibold shrink-0 transition-colors ${
            guestUploadsEnabled
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-emerald-600 hover:bg-emerald-700 text-white'
          }`}
        >
          {guestUploadsEnabled ? 'Disable All Guest Uploads Immediately' : 'Re-Enable Guest Uploads'}
        </button>
      </div>

      {/* Quotas, Limits & Indexer Schedule */}
      <form
        onSubmit={handleSaveSystemSettings}
        className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-2xs space-y-5"
      >
        <h2 className="text-sm font-bold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-800 pb-3">
          Quotas, Rate Limits & Background Indexing
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Max Single File Upload Size (MB)
            </label>
            <input
              type="number"
              min="1"
              required
              value={maxFileSizeMB}
              onChange={(e) => setMaxFileSizeMB(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Default Per-Link Guest Quota (MB)
            </label>
            <input
              type="number"
              min="1"
              required
              value={defaultGuestQuotaMB}
              onChange={(e) => setDefaultGuestQuotaMB(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Total Server Guest Upload Quota (GB)
            </label>
            <input
              type="number"
              min="1"
              required
              value={totalGuestQuotaGB}
              onChange={(e) => setTotalGuestQuotaGB(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
            {settings && (
              <span className="text-[11px] text-slate-400">
                Currently used by guests: {formatBytes(settings.currentTotalGuestUploadedBytes)}
              </span>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Max Concurrent Guest Uploads
            </label>
            <input
              type="number"
              min="1"
              max="20"
              required
              value={maxConcurrentGuestUploads}
              onChange={(e) => setMaxConcurrentGuestUploads(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
              Scheduled HDD Indexer Interval (Minutes)
            </label>
            <input
              type="number"
              min="0"
              max="1440"
              required
              value={indexerIntervalMinutes}
              onChange={(e) => setIndexerIntervalMinutes(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
          </div>

          <div className="flex items-center pt-5">
            <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={trackDownloads}
                onChange={(e) => setTrackDownloads(e.target.checked)}
                className="w-4 h-4 rounded-sm text-blue-600"
              />
              Track Download Counts & Analytics
            </label>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-xs"
          >
            Save Security & Quota Settings
          </button>
        </div>
      </form>

      {/* Administrator Profile & Password */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleUpdateProfile}
          className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-2xs space-y-4"
        >
          <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
            <User className="w-4 h-4 text-blue-600" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Administrator Profile
            </h2>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              Display Name
            </label>
            <input
              type="text"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              Email Address
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={handleRevokeOtherSessions}
              className="text-xs text-red-600 hover:underline flex items-center gap-1"
            >
              <LogOut className="w-3.5 h-3.5" />
              Revoke other sessions
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
            >
              Update Profile
            </button>
          </div>
        </form>

        <form
          onSubmit={handleChangePassword}
          className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-2xs space-y-4"
        >
          <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
            <Lock className="w-4 h-4 text-purple-600" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Change Password (Argon2id)
            </h2>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              Current Password
            </label>
            <input
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">
              New Password (Min 8 characters)
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
            >
              Update Password
            </button>
          </div>
        </form>
      </div>

      {/* HDD Directory Architecture & Database Backups */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-2xs space-y-3">
          <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
            <HardDrive className="w-4 h-4 text-blue-600" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Active HDD Storage Paths
            </h2>
          </div>
          {paths && (
            <div className="space-y-2 text-xs font-mono">
              {Object.entries(paths).map(([key, val]) => (
                <div key={key} className="flex items-center justify-between gap-2 py-1 border-b border-slate-100 dark:border-slate-800/60">
                  <span className="text-slate-400 uppercase">{key}:</span>
                  <span className="text-slate-800 dark:text-slate-200 truncate">{String(val)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 shadow-2xs space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-600" />
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">
                Consistent SQLite Backups on HDD
              </h2>
            </div>
            <button
              onClick={handleCreateBackup}
              disabled={backingUp}
              className="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${backingUp ? 'animate-spin' : ''}`} />
              {backingUp ? 'Backing up...' : 'Create Backup Now'}
            </button>
          </div>

          {backups.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">
              No database snapshots created yet.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-48 overflow-y-auto text-xs">
              {backups.map((b) => (
                <div key={b.filename} className="py-2 flex items-center justify-between gap-2">
                  <span className="font-mono text-slate-800 dark:text-slate-200 truncate">
                    {b.filename}
                  </span>
                  <span className="text-slate-400 shrink-0">
                    {formatBytes(b.sizeBytes)} • {formatDateTime(b.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
