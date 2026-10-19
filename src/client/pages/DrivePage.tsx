import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Folder,
  FolderPlus,
  Upload,
  FileText,
  Image as ImageIcon,
  Video,
  Music,
  Archive,
  Code,
  File as FileIcon,
  Star,
  Share2,
  Download,
  Trash2,
  RotateCcw,
  Edit3,
  Copy,
  FolderInput,
  Grid,
  List,
  ChevronRight,
  Home,
  Search,
  CheckSquare,
  Square,
  X,
  Eye,
  UploadCloud,
  AlertCircle,
} from 'lucide-react';
import { apiRequest, uploadFilesWithProgress } from '../lib/api';
import { formatBytes, formatShortDate } from '../lib/format';
import { useAppState } from '../context/AppContext';
import { ShareModal, ShareTarget } from '../components/ShareModal';
import { PreviewModal, PreviewableFile } from '../components/PreviewModal';

export type DriveViewMode = 'folder' | 'recent' | 'starred' | 'trash' | 'categories';

interface DrivePageProps {
  viewMode: DriveViewMode;
}

const CATEGORIES = [
  { id: 'all', label: 'All Types' },
  { id: 'image', label: 'Images' },
  { id: 'pdf', label: 'PDFs' },
  { id: 'document', label: 'Documents' },
  { id: 'video', label: 'Videos' },
  { id: 'audio', label: 'Audio' },
  { id: 'archive', label: 'Archives' },
  { id: 'code', label: 'Code' },
  { id: 'other', label: 'Other' },
];

function renderCategoryIcon(category: string) {
  switch (category) {
    case 'image':
      return <ImageIcon className="w-5 h-5 text-blue-500" />;
    case 'video':
      return <Video className="w-5 h-5 text-purple-500" />;
    case 'audio':
      return <Music className="w-5 h-5 text-emerald-500" />;
    case 'pdf':
      return <FileText className="w-5 h-5 text-red-500" />;
    case 'document':
      return <FileText className="w-5 h-5 text-amber-500" />;
    case 'archive':
      return <Archive className="w-5 h-5 text-pink-500" />;
    case 'code':
      return <Code className="w-5 h-5 text-cyan-500" />;
    default:
      return <FileIcon className="w-5 h-5 text-slate-500" />;
  }
}

export const DrivePage: React.FC<DrivePageProps> = ({ viewMode }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { refreshStorageSummary } = useAppState();

  const currentFolderId = viewMode === 'folder' ? searchParams.get('folderId') : null;
  const urlSearch = searchParams.get('search') || '';
  const urlAction = searchParams.get('action');

  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string; name: string }[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [files, setFiles] = useState<any[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 100, totalFiles: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [layout, setLayout] = useState<'grid' | 'list'>('list');
  const [searchQuery, setSearchQuery] = useState(urlSearch);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'date' | 'type'>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);

  // Selection state for bulk operations
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(new Set());

  // Modals & Interactive States
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ type: 'file' | 'folder'; id: string; name: string } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{
    fileIds: string[];
    folderIds: string[];
  } | null>(null);
  const [allFoldersTree, setAllFoldersTree] = useState<{ id: string; name: string }[]>([]);
  const [destinationFolderId, setDestinationFolderId] = useState<string>('root');

  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);

  // Drag & Drop and Upload Progress
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [activeUpload, setActiveUpload] = useState<{
    fileCount: number;
    loadedBytes: number;
    totalBytes: number;
    percent: number;
    abort: () => void;
    failedFiles?: File[];
    errorMsg?: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setSearchQuery(urlSearch);
  }, [urlSearch]);

  useEffect(() => {
    if (urlAction === 'new-folder') {
      setNewFolderOpen(true);
      searchParams.delete('action');
      setSearchParams(searchParams, { replace: true });
    } else if (urlAction === 'upload') {
      fileInputRef.current?.click();
      searchParams.delete('action');
      setSearchParams(searchParams, { replace: true });
    }
  }, [urlAction, searchParams, setSearchParams]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (viewMode === 'categories') {
        params.set('view', 'category');
        if (selectedCategory !== 'all') params.set('category', selectedCategory);
      } else {
        params.set('view', viewMode);
        if (selectedCategory !== 'all') params.set('category', selectedCategory);
      }

      if (currentFolderId) params.set('folderId', currentFolderId);
      if (searchQuery.trim()) params.set('search', searchQuery.trim());
      params.set('sortBy', sortBy);
      params.set('sortDir', sortDir);
      params.set('page', String(page));
      params.set('limit', '100');

      const res = await apiRequest(`/api/v1/drive/items?${params.toString()}`);
      setBreadcrumbs(res.breadcrumbs || []);
      setFolders(res.folders || []);
      setFiles(res.files || []);
      setPagination(res.pagination || { page: 1, limit: 100, totalFiles: 0, totalPages: 1 });
      setSelectedFileIds(new Set());
      setSelectedFolderIds(new Set());
    } catch (err: any) {
      setError(err.message || 'Failed to load files');
    } finally {
      setLoading(false);
    }
  }, [viewMode, currentFolderId, searchQuery, selectedCategory, sortBy, sortDir, page]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const navigateToFolder = (folderId: string | null) => {
    setPage(1);
    if (folderId) {
      setSearchParams({ folderId });
    } else {
      setSearchParams({});
    }
  };

  const handleUploadBatch = async (fileList: File[], relPaths?: string[]) => {
    if (fileList.length === 0) return;
    setError(null);

    const task = uploadFilesWithProgress({
      url: `/api/v1/drive/upload${currentFolderId ? `?folderId=${currentFolderId}` : ''}`,
      files: fileList,
      folderId: currentFolderId,
      relativePaths: relPaths,
      onProgress: (loadedBytes, totalBytes, percent) => {
        setActiveUpload((prev) =>
          prev ? { ...prev, loadedBytes, totalBytes, percent } : null
        );
      },
    });

    setActiveUpload({
      fileCount: fileList.length,
      loadedBytes: 0,
      totalBytes: fileList.reduce((acc, f) => acc + f.size, 0),
      percent: 0,
      abort: task.abort,
    });

    try {
      await task.promise;
      setActiveUpload(null);
      await loadItems();
      await refreshStorageSummary();
    } catch (err: any) {
      if (err.code === 'UPLOAD_CANCELLED') {
        setActiveUpload(null);
      } else {
        setActiveUpload((prev) =>
          prev
            ? {
                ...prev,
                failedFiles: fileList,
                errorMsg: err.message || 'Upload failed',
              }
            : null
        );
      }
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    if (selected.length > 0) {
      const relPaths = selected.map((f: any) => f.webkitRelativePath || f.name);
      handleUploadBatch(selected, relPaths);
    }
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingOver(false);
    if (viewMode === 'trash') return;
    const droppedFiles = Array.from(e.dataTransfer.files || []);
    if (droppedFiles.length > 0) {
      handleUploadBatch(droppedFiles);
    }
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    try {
      await apiRequest('/api/v1/drive/folders', {
        method: 'POST',
        body: JSON.stringify({
          name: newFolderName.trim(),
          parentId: currentFolderId,
        }),
      });
      setNewFolderName('');
      setNewFolderOpen(false);
      await loadItems();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameTarget || !renameTarget.name.trim()) return;
    try {
      const endpoint =
        renameTarget.type === 'file'
          ? `/api/v1/drive/files/${renameTarget.id}/rename`
          : `/api/v1/drive/folders/${renameTarget.id}/rename`;
      await apiRequest(endpoint, {
        method: 'PATCH',
        body: JSON.stringify({ name: renameTarget.name.trim() }),
      });
      setRenameTarget(null);
      await loadItems();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const openMoveDialog = async (fileIds: string[], folderIds: string[]) => {
    try {
      const res = await apiRequest('/api/v1/drive/folders/tree');
      setAllFoldersTree(res.folders || []);
      setDestinationFolderId('root');
      setMoveTarget({ fileIds, folderIds });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleMoveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!moveTarget) return;
    try {
      await apiRequest('/api/v1/drive/bulk', {
        method: 'POST',
        body: JSON.stringify({
          action: 'move',
          fileIds: moveTarget.fileIds,
          folderIds: moveTarget.folderIds,
          targetFolderId: destinationFolderId === 'root' ? null : destinationFolderId,
        }),
      });
      setMoveTarget(null);
      await loadItems();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleCopyFile = async (fileId: string) => {
    try {
      await apiRequest(`/api/v1/drive/files/${fileId}/copy`, {
        method: 'POST',
        body: JSON.stringify({ targetFolderId: currentFolderId }),
      });
      await loadItems();
      await refreshStorageSummary();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleStar = async (itemType: 'file' | 'folder', itemId: string, currentStarred: boolean) => {
    try {
      await apiRequest('/api/v1/drive/star', {
        method: 'POST',
        body: JSON.stringify({ itemType, itemId, starred: !currentStarred }),
      });
      await loadItems();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleBulkAction = async (
    action: 'trash' | 'restore' | 'delete' | 'star' | 'unstar',
    overrideFiles?: string[],
    overrideFolders?: string[]
  ) => {
    const fIds = overrideFiles ?? Array.from(selectedFileIds);
    const dIds = overrideFolders ?? Array.from(selectedFolderIds);
    if (fIds.length === 0 && dIds.length === 0) return;

    try {
      await apiRequest('/api/v1/drive/bulk', {
        method: 'POST',
        body: JSON.stringify({
          action,
          fileIds: fIds,
          folderIds: dIds,
        }),
      });
      await loadItems();
      await refreshStorageSummary();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleEmptyTrash = async () => {
    try {
      await apiRequest('/api/v1/drive/trash/empty', { method: 'DELETE' });
      await loadItems();
      await refreshStorageSummary();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleFileSelect = (id: string) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFolderSelect = (id: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (
      selectedFileIds.size === files.length &&
      selectedFolderIds.size === folders.length &&
      (files.length > 0 || folders.length > 0)
    ) {
      setSelectedFileIds(new Set());
      setSelectedFolderIds(new Set());
    } else {
      setSelectedFileIds(new Set(files.map((f) => f.id)));
      setSelectedFolderIds(new Set(folders.map((d) => d.id)));
    }
  };

  const totalSelected = selectedFileIds.size + selectedFolderIds.size;

  const pageTitles: Record<DriveViewMode, string> = {
    folder: 'My Drive',
    recent: 'Recent Files',
    starred: 'Starred Items',
    trash: 'Trash Bin',
    categories: 'File Categories',
  };

  return (
    <div
      className="space-y-6 relative min-h-[75vh]"
      onDragOver={(e) => {
        e.preventDefault();
        if (viewMode !== 'trash') setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={handleDrop}
    >
      {/* Hidden File & Folder Upload Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileInputChange}
        className="hidden"
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is standard in modern browsers for directory upload
        webkitdirectory=""
        directory=""
        multiple
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Drag & Drop Overlay */}
      {isDraggingOver && (
        <div className="fixed inset-0 z-40 bg-blue-600/15 backdrop-blur-xs border-4 border-dashed border-blue-500 rounded-2xl m-4 flex flex-col items-center justify-center pointer-events-none">
          <div className="p-6 rounded-2xl bg-white dark:bg-slate-900 shadow-2xl flex flex-col items-center gap-2">
            <UploadCloud className="w-12 h-12 text-blue-600 animate-bounce" />
            <div className="text-base font-bold text-slate-900 dark:text-white">
              Drop files to stream directly to HDD
            </div>
            <div className="text-xs text-slate-500">
              Destination: {breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].name : 'Root Drive'}
            </div>
          </div>
        </div>
      )}

      {/* Top Header & Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            {pageTitles[viewMode]}
          </h1>
          {/* Breadcrumb Navigation */}
          {viewMode === 'folder' && (
            <nav aria-label="Breadcrumb" className="flex items-center flex-wrap gap-1 text-xs mt-1.5">
              <button
                onClick={() => navigateToFolder(null)}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg font-medium ${
                  !currentFolderId
                    ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                    : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Home className="w-3.5 h-3.5" />
                My Drive
              </button>
              {breadcrumbs.map((crumb, idx) => (
                <React.Fragment key={crumb.id}>
                  <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                  <button
                    onClick={() => navigateToFolder(crumb.id)}
                    className={`px-2 py-1 rounded-lg font-medium ${
                      idx === breadcrumbs.length - 1
                        ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                        : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
            </nav>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center flex-wrap gap-2">
          {viewMode === 'trash' ? (
            (files.length > 0 || folders.length > 0) && (
              <button
                onClick={handleEmptyTrash}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-xs"
              >
                <Trash2 className="w-4 h-4" />
                Empty Trash Permanently
              </button>
            )
          ) : (
            <>
              <button
                onClick={() => setNewFolderOpen(true)}
                className="px-3.5 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-semibold flex items-center gap-1.5 shadow-2xs"
              >
                <FolderPlus className="w-4 h-4 text-blue-600" />
                New Folder
              </button>

              <button
                onClick={() => folderInputRef.current?.click()}
                className="px-3.5 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-semibold flex items-center gap-1.5 shadow-2xs"
              >
                <Folder className="w-4 h-4 text-indigo-600" />
                Upload Folder
              </button>

              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 shadow-xs"
              >
                <Upload className="w-4 h-4" />
                Upload Files
              </button>
            </>
          )}
        </div>
      </div>

      {/* Upload Progress Banner with Cancellation & Retry */}
      {activeUpload && (
        <div className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-blue-200 dark:border-blue-800 shadow-md space-y-2.5">
          <div className="flex items-center justify-between gap-4">
            <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <UploadCloud className="w-4 h-4 text-blue-600" />
              {activeUpload.errorMsg
                ? `Upload Failed: ${activeUpload.errorMsg}`
                : `Streaming ${activeUpload.fileCount} file(s) to HDD... ${activeUpload.percent}%`}
            </div>
            <div className="flex items-center gap-2">
              {activeUpload.errorMsg && activeUpload.failedFiles ? (
                <>
                  <button
                    onClick={() => handleUploadBatch(activeUpload.failedFiles!)}
                    className="px-3 py-1 rounded-lg bg-blue-600 text-white text-xs font-medium"
                  >
                    Retry Upload
                  </button>
                  <button
                    onClick={() => setActiveUpload(null)}
                    className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs"
                  >
                    Dismiss
                  </button>
                </>
              ) : (
                <button
                  onClick={activeUpload.abort}
                  className="px-3 py-1 rounded-lg bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 text-xs font-medium"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {!activeUpload.errorMsg && (
            <>
              <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-blue-600 transition-all duration-150"
                  style={{ width: `${activeUpload.percent}%` }}
                />
              </div>
              <div className="text-[11px] text-slate-500">
                {formatBytes(activeUpload.loadedBytes)} of {formatBytes(activeUpload.totalBytes)} written
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-300 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </span>
          <button onClick={() => setError(null)} className="p-1">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Category Filter Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.id}
            onClick={() => {
              setSelectedCategory(cat.id);
              setPage(1);
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-medium shrink-0 transition-colors ${
              selectedCategory === cat.id
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Filter, Search, Sort & Bulk Toolbar */}
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-3 flex flex-wrap items-center justify-between gap-3 shadow-2xs">
        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            onClick={selectAll}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            {totalSelected > 0 ? (
              <CheckSquare className="w-4 h-4 text-blue-600" />
            ) : (
              <Square className="w-4 h-4 text-slate-400" />
            )}
            <span>{totalSelected > 0 ? `${totalSelected} selected` : 'Select All'}</span>
          </button>

          {totalSelected > 0 && (
            <div className="flex items-center gap-1.5 pl-2 border-l border-slate-200 dark:border-slate-800">
              {viewMode === 'trash' ? (
                <>
                  <button
                    onClick={() => handleBulkAction('restore')}
                    className="px-2.5 py-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-xs font-medium flex items-center gap-1"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Restore
                  </button>
                  <button
                    onClick={() => handleBulkAction('delete')}
                    className="px-2.5 py-1.5 rounded-lg bg-red-50 dark:bg-red-950/60 text-red-700 dark:text-red-300 text-xs font-medium flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete Permanently
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() =>
                      openMoveDialog(Array.from(selectedFileIds), Array.from(selectedFolderIds))
                    }
                    className="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-xs font-medium flex items-center gap-1"
                  >
                    <FolderInput className="w-3.5 h-3.5" />
                    Move
                  </button>
                  <button
                    onClick={() => handleBulkAction('star')}
                    className="px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-xs font-medium flex items-center gap-1"
                  >
                    <Star className="w-3.5 h-3.5 text-amber-500" />
                    Star
                  </button>
                  <button
                    onClick={() => handleBulkAction('trash')}
                    className="px-2.5 py-1.5 rounded-lg bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 text-xs font-medium flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Trash
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Filter by filename..."
              className="pl-8 pr-3 py-1.5 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-hidden focus:border-blue-500"
            />
          </div>

          <select
            value={`${sortBy}:${sortDir}`}
            onChange={(e) => {
              const [sb, sd] = e.target.value.split(':') as [any, any];
              setSortBy(sb);
              setSortDir(sd);
            }}
            className="px-2.5 py-1.5 text-xs rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
          >
            <option value="name:asc">Name (A → Z)</option>
            <option value="name:desc">Name (Z → A)</option>
            <option value="date:desc">Modified (Newest)</option>
            <option value="date:asc">Modified (Oldest)</option>
            <option value="size:desc">Size (Largest)</option>
            <option value="size:asc">Size (Smallest)</option>
            <option value="type:asc">Type</option>
          </select>

          <div className="flex items-center rounded-xl bg-slate-100 dark:bg-slate-800 p-0.5">
            <button
              onClick={() => setLayout('list')}
              aria-label="List view"
              className={`p-1.5 rounded-lg ${
                layout === 'list' ? 'bg-white dark:bg-slate-900 shadow-2xs text-blue-600' : 'text-slate-500'
              }`}
            >
              <List className="w-4 h-4" />
            </button>
            <button
              onClick={() => setLayout('grid')}
              aria-label="Grid view"
              className={`p-1.5 rounded-lg ${
                layout === 'grid' ? 'bg-white dark:bg-slate-900 shadow-2xs text-blue-600' : 'text-slate-500'
              }`}
            >
              <Grid className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Listing */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 bg-slate-200 dark:bg-slate-800 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : folders.length === 0 && files.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-12 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-400 flex items-center justify-center mx-auto">
            <Folder className="w-6 h-6" />
          </div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            {viewMode === 'trash'
              ? 'Trash bin is empty'
              : searchQuery
              ? 'No matching files or folders found'
              : 'This folder is empty'}
          </div>
          <p className="text-xs text-slate-500 max-w-sm mx-auto">
            {viewMode === 'trash'
              ? 'Items moved to the trash can be restored or permanently deleted from your HDD.'
              : 'Drag and drop files anywhere here, or use the Upload button above to store files on your physical HDD.'}
          </p>
        </div>
      ) : layout === 'grid' ? (
        <div className="space-y-6">
          {/* Folders Grid */}
          {folders.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
                Folders ({folders.length})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5">
                {folders.map((folder) => {
                  const isSel = selectedFolderIds.has(folder.id);
                  return (
                    <div
                      key={folder.id}
                      className={`group rounded-2xl border p-3.5 transition-all bg-white dark:bg-slate-900 flex flex-col justify-between ${
                        isSel
                          ? 'border-blue-500 ring-2 ring-blue-500/20'
                          : 'border-slate-200 dark:border-slate-800 hover:border-blue-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div
                          onClick={() => viewMode !== 'trash' && navigateToFolder(folder.id)}
                          className="flex items-center gap-2.5 min-w-0 cursor-pointer flex-1"
                        >
                          <Folder className="w-6 h-6 text-blue-600 fill-blue-600/15 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                              {folder.name}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {folder.itemCount} files • {formatBytes(folder.sizeBytes)}
                            </div>
                          </div>
                        </div>

                        <button
                          onClick={() => toggleFolderSelect(folder.id)}
                          className="p-1 text-slate-400 hover:text-blue-600"
                        >
                          {isSel ? (
                            <CheckSquare className="w-4 h-4 text-blue-600" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </div>

                      <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between">
                        <span className="text-[11px] text-slate-400">
                          {formatShortDate(folder.updatedAt)}
                        </span>
                        <div className="flex items-center gap-1">
                          {viewMode !== 'trash' ? (
                            <>
                              <button
                                onClick={() =>
                                  handleToggleStar('folder', folder.id, folder.isStarred)
                                }
                                title="Star folder"
                                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                <Star
                                  className={`w-3.5 h-3.5 ${
                                    folder.isStarred
                                      ? 'text-amber-500 fill-amber-500'
                                      : 'text-slate-400'
                                  }`}
                                />
                              </button>
                              <button
                                onClick={() =>
                                  setShareTarget({
                                    type: 'folder',
                                    id: folder.id,
                                    name: folder.name,
                                    defaultPermission: 'download_only',
                                  })
                                }
                                title="Share or create guest upload dropzone"
                                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Share2 className="w-3.5 h-3.5" />
                              </button>
                              <a
                                href={`/api/v1/drive/folders/${folder.id}/download`}
                                title="Download folder as ZIP"
                                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </a>
                              <button
                                onClick={() =>
                                  setRenameTarget({
                                    type: 'folder',
                                    id: folder.id,
                                    name: folder.name,
                                  })
                                }
                                title="Rename folder"
                                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleBulkAction('trash', [], [folder.id])}
                                title="Move to Trash"
                                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-red-500"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => handleBulkAction('restore', [], [folder.id])}
                                className="p-1 text-emerald-600"
                                title="Restore"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleBulkAction('delete', [], [folder.id])}
                                className="p-1 text-red-600"
                                title="Delete permanently"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Files Grid */}
          {files.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
                Files ({files.length})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3.5">
                {files.map((file) => {
                  const isSel = selectedFileIds.has(file.id);
                  return (
                    <div
                      key={file.id}
                      className={`rounded-2xl border p-3.5 transition-all bg-white dark:bg-slate-900 flex flex-col justify-between ${
                        isSel
                          ? 'border-blue-500 ring-2 ring-blue-500/20'
                          : 'border-slate-200 dark:border-slate-800 hover:border-blue-300 dark:hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div
                          onClick={() =>
                            setPreviewFile({
                              id: file.id,
                              name: file.name,
                              mimeType: file.mimeType,
                              category: file.category,
                              sizeBytes: file.sizeBytes,
                              canPreviewInline: file.canPreviewInline,
                              createdAt: file.createdAt,
                              contentUrl: `/api/v1/drive/files/${file.id}/content?inline=1`,
                              downloadUrl: `/api/v1/drive/files/${file.id}/content`,
                            })
                          }
                          className="flex items-center gap-2.5 min-w-0 cursor-pointer flex-1"
                        >
                          {renderCategoryIcon(file.category)}
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                              {file.name}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {formatBytes(file.sizeBytes)} • {file.category}
                            </div>
                          </div>
                        </div>

                        <button
                          onClick={() => toggleFileSelect(file.id)}
                          className="p-1 text-slate-400 hover:text-blue-600"
                        >
                          {isSel ? (
                            <CheckSquare className="w-4 h-4 text-blue-600" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </div>

                      <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between">
                        <span className="text-[11px] text-slate-400">
                          {formatShortDate(file.updatedAt)}
                        </span>
                        <div className="flex items-center gap-1">
                          {viewMode !== 'trash' ? (
                            <>
                              <button
                                onClick={() => handleToggleStar('file', file.id, file.isStarred)}
                                title="Star file"
                                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                <Star
                                  className={`w-3.5 h-3.5 ${
                                    file.isStarred
                                      ? 'text-amber-500 fill-amber-500'
                                      : 'text-slate-400'
                                  }`}
                                />
                              </button>
                              <button
                                onClick={() =>
                                  setShareTarget({
                                    type: 'file',
                                    id: file.id,
                                    name: file.name,
                                    defaultPermission: 'download_only',
                                  })
                                }
                                title="Share file"
                                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Share2 className="w-3.5 h-3.5" />
                              </button>
                              <a
                                href={`/api/v1/drive/files/${file.id}/content`}
                                download={file.name}
                                title="Download file"
                                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </a>
                              <button
                                onClick={() =>
                                  setRenameTarget({
                                    type: 'file',
                                    id: file.id,
                                    name: file.name,
                                  })
                                }
                                title="Rename"
                                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleBulkAction('trash', [file.id], [])}
                                title="Move to Trash"
                                className="p-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 text-red-500"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => handleBulkAction('restore', [file.id], [])}
                                className="p-1 text-emerald-600"
                                title="Restore"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleBulkAction('delete', [file.id], [])}
                                className="p-1 text-red-600"
                                title="Delete permanently"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Table / List View */
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="py-3 pl-4 pr-2 w-8"></th>
                  <th className="py-3 px-3">Name</th>
                  <th className="py-3 px-3 hidden sm:table-cell">Size</th>
                  <th className="py-3 px-3 hidden md:table-cell">Type</th>
                  <th className="py-3 px-3 hidden lg:table-cell">Modified</th>
                  <th className="py-3 pl-3 pr-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-sm">
                {/* Folders Rows */}
                {folders.map((folder) => {
                  const isSel = selectedFolderIds.has(folder.id);
                  return (
                    <tr
                      key={folder.id}
                      className={`hover:bg-slate-50/90 dark:hover:bg-slate-800/50 transition-colors ${
                        isSel ? 'bg-blue-50/50 dark:bg-blue-950/30' : ''
                      }`}
                    >
                      <td className="py-3 pl-4 pr-2">
                        <button
                          onClick={() => toggleFolderSelect(folder.id)}
                          className="text-slate-400 hover:text-blue-600"
                        >
                          {isSel ? (
                            <CheckSquare className="w-4 h-4 text-blue-600" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-3">
                          <Folder className="w-5 h-5 text-blue-600 fill-blue-600/15 shrink-0" />
                          <button
                            onClick={() => viewMode !== 'trash' && navigateToFolder(folder.id)}
                            className="font-semibold text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 text-left truncate max-w-xs sm:max-w-md"
                          >
                            {folder.name}
                          </button>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-500 hidden sm:table-cell">
                        {folder.itemCount} items ({formatBytes(folder.sizeBytes)})
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-500 hidden md:table-cell">
                        Folder
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-500 hidden lg:table-cell">
                        {formatShortDate(folder.updatedAt)}
                      </td>
                      <td className="py-3 pl-3 pr-4 text-right">
                        <div className="inline-flex items-center gap-1">
                          {viewMode !== 'trash' ? (
                            <>
                              <button
                                onClick={() =>
                                  handleToggleStar('folder', folder.id, folder.isStarred)
                                }
                                title="Star folder"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                <Star
                                  className={`w-4 h-4 ${
                                    folder.isStarred
                                      ? 'text-amber-500 fill-amber-500'
                                      : 'text-slate-400'
                                  }`}
                                />
                              </button>
                              <button
                                onClick={() =>
                                  setShareTarget({
                                    type: 'folder',
                                    id: folder.id,
                                    name: folder.name,
                                    defaultPermission: 'download_only',
                                  })
                                }
                                title="Share folder or create upload dropzone"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Share2 className="w-4 h-4" />
                              </button>
                              <a
                                href={`/api/v1/drive/folders/${folder.id}/download`}
                                title="Download folder ZIP"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Download className="w-4 h-4" />
                              </a>
                              <button
                                onClick={() =>
                                  setRenameTarget({
                                    type: 'folder',
                                    id: folder.id,
                                    name: folder.name,
                                  })
                                }
                                title="Rename folder"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => openMoveDialog([], [folder.id])}
                                title="Move folder"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <FolderInput className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleBulkAction('trash', [], [folder.id])}
                                title="Trash folder"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-red-500"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => handleBulkAction('restore', [], [folder.id])}
                                className="px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-xs font-medium"
                              >
                                Restore
                              </button>
                              <button
                                onClick={() => handleBulkAction('delete', [], [folder.id])}
                                className="px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 text-xs font-medium"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {/* Files Rows */}
                {files.map((file) => {
                  const isSel = selectedFileIds.has(file.id);
                  return (
                    <tr
                      key={file.id}
                      className={`hover:bg-slate-50/90 dark:hover:bg-slate-800/50 transition-colors ${
                        isSel ? 'bg-blue-50/50 dark:bg-blue-950/30' : ''
                      }`}
                    >
                      <td className="py-3 pl-4 pr-2">
                        <button
                          onClick={() => toggleFileSelect(file.id)}
                          className="text-slate-400 hover:text-blue-600"
                        >
                          {isSel ? (
                            <CheckSquare className="w-4 h-4 text-blue-600" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-3">
                          {renderCategoryIcon(file.category)}
                          <div className="min-w-0">
                            <button
                              onClick={() =>
                                setPreviewFile({
                                  id: file.id,
                                  name: file.name,
                                  mimeType: file.mimeType,
                                  category: file.category,
                                  sizeBytes: file.sizeBytes,
                                  canPreviewInline: file.canPreviewInline,
                                  createdAt: file.createdAt,
                                  contentUrl: `/api/v1/drive/files/${file.id}/content?inline=1`,
                                  downloadUrl: `/api/v1/drive/files/${file.id}/content`,
                                })
                              }
                              className="font-medium text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 text-left truncate block max-w-xs sm:max-w-md"
                            >
                              {file.name}
                            </button>
                            {file.folderName && (
                              <span className="text-[11px] text-slate-400">
                                In {file.folderName}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-xs font-mono text-slate-500 hidden sm:table-cell">
                        {formatBytes(file.sizeBytes)}
                      </td>
                      <td className="py-3 px-3 text-xs capitalize text-slate-500 hidden md:table-cell">
                        {file.category}
                      </td>
                      <td className="py-3 px-3 text-xs text-slate-500 hidden lg:table-cell">
                        {formatShortDate(file.updatedAt)}
                      </td>
                      <td className="py-3 pl-3 pr-4 text-right">
                        <div className="inline-flex items-center gap-1">
                          {viewMode !== 'trash' ? (
                            <>
                              <button
                                onClick={() =>
                                  setPreviewFile({
                                    id: file.id,
                                    name: file.name,
                                    mimeType: file.mimeType,
                                    category: file.category,
                                    sizeBytes: file.sizeBytes,
                                    canPreviewInline: file.canPreviewInline,
                                    createdAt: file.createdAt,
                                    contentUrl: `/api/v1/drive/files/${file.id}/content?inline=1`,
                                    downloadUrl: `/api/v1/drive/files/${file.id}/content`,
                                  })
                                }
                                title="Preview file"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Eye className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleToggleStar('file', file.id, file.isStarred)}
                                title="Star file"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                              >
                                <Star
                                  className={`w-4 h-4 ${
                                    file.isStarred
                                      ? 'text-amber-500 fill-amber-500'
                                      : 'text-slate-400'
                                  }`}
                                />
                              </button>
                              <button
                                onClick={() =>
                                  setShareTarget({
                                    type: 'file',
                                    id: file.id,
                                    name: file.name,
                                    defaultPermission: 'download_only',
                                  })
                                }
                                title="Create public download link"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Share2 className="w-4 h-4" />
                              </button>
                              <a
                                href={`/api/v1/drive/files/${file.id}/content`}
                                download={file.name}
                                title="Download"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Download className="w-4 h-4" />
                              </a>
                              <button
                                onClick={() =>
                                  setRenameTarget({
                                    type: 'file',
                                    id: file.id,
                                    name: file.name,
                                  })
                                }
                                title="Rename"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleCopyFile(file.id)}
                                title="Make a copy"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <Copy className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => openMoveDialog([file.id], [])}
                                title="Move file"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500"
                              >
                                <FolderInput className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => handleBulkAction('trash', [file.id], [])}
                                title="Move to Trash"
                                className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-red-500"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => handleBulkAction('restore', [file.id], [])}
                                className="px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 text-xs font-medium"
                              >
                                Restore
                              </button>
                              <button
                                onClick={() => handleBulkAction('delete', [file.id], [])}
                                className="px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 text-xs font-medium"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination Footer */}
          {pagination.totalPages > 1 && (
            <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
              <span>
                Page {pagination.page} of {pagination.totalPages} ({pagination.totalFiles} files)
              </span>
              <div className="flex items-center gap-2">
                <button
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="px-3 py-1 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  disabled={page >= pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="px-3 py-1 rounded-lg border border-slate-200 dark:border-slate-700 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Folder Modal */}
      {newFolderOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <form
            onSubmit={handleCreateFolder}
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-4 shadow-xl"
          >
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">
              Create New Folder
            </h3>
            <input
              type="text"
              required
              autoFocus
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="Folder name"
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNewFolderOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
              >
                Create Folder
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rename Modal */}
      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <form
            onSubmit={handleRenameSubmit}
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-4 shadow-xl"
          >
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">
              Rename {renameTarget.type === 'folder' ? 'Folder' : 'File'}
            </h3>
            <input
              type="text"
              required
              autoFocus
              value={renameTarget.name}
              onChange={(e) => setRenameTarget({ ...renameTarget, name: e.target.value })}
              className="w-full px-3.5 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
              >
                Save Name
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Move Modal */}
      {moveTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <form
            onSubmit={handleMoveSubmit}
            className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 space-y-4 shadow-xl"
          >
            <h3 className="text-base font-semibold text-slate-900 dark:text-white">
              Move Selected Item(s)
            </h3>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">
                Destination Folder
              </label>
              <select
                value={destinationFolderId}
                onChange={(e) => setDestinationFolderId(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
              >
                <option value="root">My Drive (Root)</option>
                {allFoldersTree
                  .filter((d) => !moveTarget.folderIds.includes(d.id))
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMoveTarget(null)}
                className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 dark:text-slate-300"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold"
              >
                Move Here
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Share Link Modal */}
      <ShareModal
        isOpen={shareTarget !== null}
        onClose={() => setShareTarget(null)}
        initialTarget={shareTarget}
      />

      {/* File Preview Modal */}
      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
};
