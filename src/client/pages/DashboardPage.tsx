import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HardDrive,
  Folder,
  FileText,
  Upload,
  Download,
  Share2,
  UploadCloud,
  RefreshCw,
  FolderPlus,
  BarChart3,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Activity,
  Database,
} from 'lucide-react';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  AreaChart,
  Area,
} from 'recharts';
import { apiRequest } from '../lib/api';
import { formatBytes, formatDateTime, formatShortDate } from '../lib/format';
import { useAppState } from '../context/AppContext';
import { ShareModal } from '../components/ShareModal';

const CATEGORY_COLORS: Record<string, string> = {
  image: '#3b82f6',
  video: '#8b5cf6',
  audio: '#10b981',
  pdf: '#ef4444',
  document: '#f59e0b',
  archive: '#ec4899',
  code: '#06b6d4',
  other: '#64748b',
};

export const DashboardPage: React.FC<{ analyticsFocus?: boolean }> = ({ analyticsFocus = false }) => {
  const navigate = useNavigate();
  const { refreshStorageSummary } = useAppState();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [shareModalMode, setShareModalMode] = useState<'download_only' | 'upload_only' | null>(null);

  const loadDashboard = useCallback(async () => {
    try {
      const res = await apiRequest('/api/v1/system/dashboard');
      setData(res);
      await refreshStorageSummary();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [refreshStorageSummary]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const handleManualScan = async () => {
    setScanning(true);
    try {
      await apiRequest('/api/v1/system/indexer/scan', { method: 'POST' });
      await loadDashboard();
    } catch (err) {
      console.error(err);
    } finally {
      setScanning(false);
    }
  };

  if (loading || !data) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 w-64 bg-slate-200 dark:bg-slate-800 rounded-xl" />
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-28 bg-slate-200 dark:bg-slate-800 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const { disk, summary, categoryDistribution, storageGrowth, largestFiles, largestFolders, recentTransfers, recentOperations, indexing } = data;

  const summaryCards = [
    {
      label: 'Total HDD Capacity',
      value: formatBytes(disk.totalBytes),
      sub: `Mount: ${disk.mountPath}`,
      icon: HardDrive,
      color: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/60',
    },
    {
      label: 'Used Disk Space',
      value: formatBytes(disk.usedBytes),
      sub: `Indexed: ${formatBytes(disk.totalIndexedBytes)}`,
      icon: Database,
      color: 'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/60',
    },
    {
      label: 'Available Disk Space',
      value: formatBytes(disk.availableBytes),
      sub: disk.isWritable ? 'Read/Write Active' : 'Read-Only / Fault',
      icon: CheckCircle2,
      color: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/60',
    },
    {
      label: 'Storage Usage %',
      value: `${disk.usagePercent}%`,
      sub: `OS/FS overhead: ${formatBytes(disk.unindexedSystemBytes)}`,
      icon: BarChart3,
      color: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/60',
    },
    {
      label: 'Total Files',
      value: String(summary.totalFiles),
      sub: `${summary.trashedFiles} in Trash`,
      icon: FileText,
      color: 'text-sky-600 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/60',
    },
    {
      label: 'Total Folders',
      value: String(summary.totalFolders),
      sub: 'Nested hierarchies',
      icon: Folder,
      color: 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950/60',
    },
    {
      label: 'Recent Uploads (7d)',
      value: String(summary.recentUploads7d),
      sub: `${summary.totalUploads} all-time uploads`,
      icon: Upload,
      color: 'text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/60',
    },
    {
      label: 'Total Shared Links',
      value: String(summary.totalSharedLinks),
      sub: 'Public token links',
      icon: Share2,
      color: 'text-pink-600 dark:text-pink-400 bg-pink-50 dark:bg-pink-950/60',
    },
    {
      label: 'Active Upload Links',
      value: String(summary.activeUploadLinks),
      sub: summary.guestUploadsEnabled ? 'Guest dropzones enabled' : 'Kill switch active',
      icon: UploadCloud,
      color: 'text-cyan-600 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-950/60',
    },
    {
      label: 'Total Downloads',
      value: summary.trackDownloadsEnabled ? String(summary.totalDownloads) : 'Off',
      sub: summary.trackDownloadsEnabled ? 'Tracking enabled' : 'Tracking disabled',
      icon: Download,
      color: 'text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/60',
    },
  ];

  const storageBreakdownData = [
    { name: 'Active Indexed Files', bytes: disk.activeIndexedBytes, color: '#2563eb' },
    { name: 'Trash Bin Files', bytes: disk.trashBytes, color: '#f59e0b' },
    { name: 'Filesystem / DB / Logs Overhead', bytes: disk.unindexedSystemBytes, color: '#64748b' },
    { name: 'Available Free Space', bytes: disk.availableBytes, color: '#e2e8f0' },
  ];

  return (
    <div className="space-y-8">
      {/* Page Header & Indexer Status Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {analyticsFocus ? 'Storage Analytics & HDD Telemetry' : 'Personal Cloud Dashboard'}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Live physical telemetry from WD Scorpio Blue HDD ({disk.mountPath}) • Last indexed:{' '}
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {indexing.lastSuccessfulScanAt ? formatDateTime(indexing.lastSuccessfulScanAt) : 'Pending scan'}
            </span>
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={handleManualScan}
            disabled={scanning || indexing.isRunning}
            className="px-4 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-semibold flex items-center gap-2 shadow-2xs disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${scanning || indexing.isRunning ? 'animate-spin text-blue-600' : ''}`} />
            {scanning || indexing.isRunning ? 'Scanning HDD...' : 'Rescan Physical HDD'}
          </button>

          <button
            onClick={() => navigate('/drive')}
            className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-2 shadow-xs"
          >
            <HardDrive className="w-4 h-4" />
            Open My Drive
          </button>
        </div>
      </div>

      {/* Indexing Error Alert if any */}
      {indexing.lastScanErrors && indexing.lastScanErrors.length > 0 && (
        <div className="p-4 rounded-2xl bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800/80 text-xs text-amber-800 dark:text-amber-300 space-y-1">
          <div className="font-semibold flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
            Indexing Warnings Detected ({indexing.lastScanErrors.length})
          </div>
          <ul className="list-disc list-inside pl-1 space-y-0.5">
            {indexing.lastScanErrors.slice(0, 5).map((err: string, idx: number) => (
              <li key={idx}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Quick Actions Bar */}
      {!analyticsFocus && (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-2xs">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-3">
            Quick Actions
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            <button
              onClick={() => navigate('/drive?action=upload')}
              className="flex items-center gap-2.5 p-3 rounded-xl bg-blue-50/70 dark:bg-blue-950/40 hover:bg-blue-100/80 dark:hover:bg-blue-950/80 text-blue-700 dark:text-blue-300 text-xs font-semibold transition-colors"
            >
              <Upload className="w-4 h-4 shrink-0" />
              Upload Files
            </button>

            <button
              onClick={() => navigate('/drive?action=new-folder')}
              className="flex items-center gap-2.5 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/70 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold transition-colors"
            >
              <FolderPlus className="w-4 h-4 shrink-0 text-blue-600" />
              Create Folder
            </button>

            <button
              onClick={() => setShareModalMode('upload_only')}
              className="flex items-center gap-2.5 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/70 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold transition-colors"
            >
              <UploadCloud className="w-4 h-4 shrink-0 text-emerald-600" />
              Create Upload Link
            </button>

            <button
              onClick={() => setShareModalMode('download_only')}
              className="flex items-center gap-2.5 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/70 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold transition-colors"
            >
              <Share2 className="w-4 h-4 shrink-0 text-purple-600" />
              Create Share Link
            </button>

            <button
              onClick={() => navigate('/drive')}
              className="flex items-center gap-2.5 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/70 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold transition-colors"
            >
              <HardDrive className="w-4 h-4 shrink-0 text-indigo-600" />
              Open My Drive
            </button>

            <button
              onClick={() => navigate('/analytics')}
              className="flex items-center gap-2.5 p-3 rounded-xl bg-slate-50 dark:bg-slate-800/70 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold transition-colors"
            >
              <BarChart3 className="w-4 h-4 shrink-0 text-amber-600" />
              Storage Analytics
            </button>
          </div>
        </div>
      )}

      {/* 10 Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-4 shadow-2xs flex flex-col justify-between"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {card.label}
                </span>
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${card.color}`}>
                  <Icon className="w-4 h-4" />
                </div>
              </div>
              <div className="mt-3">
                <div className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">
                  {card.value}
                </div>
                <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 truncate">
                  {card.sub}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Physical Filesystem vs Indexed Files Comparison Bar */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-2xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Physical HDD Utilization vs. Indexed Cloud Files
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Distinguishes raw ext4 filesystem usage from indexed user files, trash, and SQLite/system metadata
            </p>
          </div>
          <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
            {formatBytes(disk.usedBytes)} used of {formatBytes(disk.totalBytes)} ({disk.usagePercent}%)
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          {storageBreakdownData.map((item) => (
            <div
              key={item.name}
              className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-800"
            >
              <div className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                <span className="truncate">{item.name}</span>
              </div>
              <div className="text-sm font-bold text-slate-900 dark:text-white mt-1">
                {formatBytes(item.bytes)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Charts Grid: Category Distribution (Count & Size) + Storage Growth */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* File-Type Distribution by Storage Size */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-2xs flex flex-col">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
            File-Type Distribution by Size
          </h3>
          <p className="text-xs text-slate-500 mb-4">Bytes occupied per file category</p>

          {categoryDistribution.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-400 py-12">
              No files uploaded yet
            </div>
          ) : (
            <>
              <div className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={categoryDistribution}
                      dataKey="totalBytes"
                      nameKey="category"
                      cx="50%"
                      cy="50%"
                      innerRadius={48}
                      outerRadius={78}
                      paddingAngle={3}
                    >
                      {categoryDistribution.map((entry: any) => (
                        <Cell
                          key={entry.category}
                          fill={CATEGORY_COLORS[entry.category] || '#64748b'}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(val: any) => formatBytes(Number(val))}
                      contentStyle={{
                        borderRadius: '12px',
                        fontSize: '12px',
                        border: '1px solid #334155',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {categoryDistribution.map((c: any) => (
                  <div key={c.category} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 capitalize text-slate-600 dark:text-slate-300">
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: CATEGORY_COLORS[c.category] || '#64748b' }}
                      />
                      {c.category}
                    </span>
                    <span className="font-medium text-slate-900 dark:text-white">
                      {formatBytes(c.totalBytes)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* File-Type Distribution by Count */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-2xs flex flex-col">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
            File-Type Distribution by Count
          </h3>
          <p className="text-xs text-slate-500 mb-4">Number of indexed files per category</p>

          {categoryDistribution.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-400 py-12">
              No files uploaded yet
            </div>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryDistribution}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.15} />
                  <XAxis dataKey="category" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      borderRadius: '12px',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="count" name="Files" radius={[6, 6, 0, 0]}>
                    {categoryDistribution.map((entry: any) => (
                      <Cell
                        key={entry.category}
                        fill={CATEGORY_COLORS[entry.category] || '#3b82f6'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Storage Growth Over Time */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-2xs flex flex-col">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
            Storage Growth Over Time
          </h3>
          <p className="text-xs text-slate-500 mb-4">Indexed file volume across scans</p>

          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={storageGrowth.map((pt: any) => ({
                  ...pt,
                  label: formatShortDate(pt.timestamp),
                }))}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.15} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                <YAxis
                  tickFormatter={(v) => formatBytes(v, 0)}
                  tick={{ fontSize: 10 }}
                  width={65}
                />
                <Tooltip
                  formatter={(v: any) => formatBytes(Number(v))}
                  contentStyle={{ borderRadius: '12px', fontSize: '12px' }}
                />
                <Area
                  type="monotone"
                  dataKey="indexedFilesBytes"
                  name="Indexed Files"
                  stroke="#2563eb"
                  fill="#3b82f6"
                  fillOpacity={0.2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Largest Files & Largest Folders */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Largest Files */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-2xs">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">
            Largest Files on HDD
          </h3>
          {largestFiles.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">No indexed files found</div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {largestFiles.map((f: any) => (
                <div key={f.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
                      {f.name}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      In {f.folderName} • {formatShortDate(f.createdAt)}
                    </div>
                  </div>
                  <span className="text-xs font-mono font-semibold text-slate-700 dark:text-slate-300 shrink-0">
                    {formatBytes(f.sizeBytes)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Largest Folders */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-2xs">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-3">
            Largest Folders by Indexed File Size
          </h3>
          {largestFolders.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">No folders created yet</div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {largestFolders.map((d: any) => (
                <div
                  key={d.id}
                  onClick={() => navigate(`/drive?folderId=${d.id}`)}
                  className="py-2.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 px-2 -mx-2 rounded-lg"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Folder className="w-4 h-4 text-blue-600 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
                        {d.name}
                      </div>
                      <div className="text-[11px] text-slate-400">{d.fileCount} files</div>
                    </div>
                  </div>
                  <span className="text-xs font-mono font-semibold text-slate-700 dark:text-slate-300 shrink-0">
                    {formatBytes(d.totalBytes)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent Upload/Download Activity & Audit Operations */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-2xs">
          <div className="flex items-center gap-2 mb-3">
            <Clock className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              Recent Upload & Download Activity
            </h3>
          </div>
          {recentTransfers.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">No recent transfers</div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
              {recentTransfers.map((t: any) => (
                <div key={t.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`px-2 py-0.5 rounded-md text-[10px] font-semibold uppercase ${
                        t.direction === 'upload'
                          ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                          : 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                      }`}
                    >
                      {t.direction}
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                        {t.itemName}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {t.actorType === 'guest' ? 'Public Share Guest' : 'Admin'} •{' '}
                        {formatDateTime(t.createdAt)}
                      </div>
                    </div>
                  </div>
                  <span className="font-mono text-slate-600 dark:text-slate-400 shrink-0">
                    {formatBytes(t.bytesTransferred)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-5 shadow-2xs">
          <div className="flex items-center gap-2 mb-3">
            <Activity className="w-4 h-4 text-purple-600" />
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
              Recent File & Security Operations
            </h3>
          </div>
          {recentOperations.length === 0 ? (
            <div className="text-xs text-slate-400 py-6 text-center">No recent operations</div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
              {recentOperations.map((op: any) => (
                <div key={op.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-mono text-[11px] font-semibold text-slate-800 dark:text-slate-200">
                      {op.eventType}
                    </div>
                    <div className="text-[11px] text-slate-400 truncate">
                      Actor: {op.actor} {op.ipAddress ? `(${op.ipAddress})` : ''}
                    </div>
                  </div>
                  <span className="text-[11px] text-slate-400 shrink-0">
                    {formatDateTime(op.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ShareModal
        isOpen={shareModalMode !== null}
        onClose={() => setShareModalMode(null)}
        defaultMode={shareModalMode || 'download_only'}
        onCreated={loadDashboard}
      />
    </div>
  );
};
