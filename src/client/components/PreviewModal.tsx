import React from 'react';
import { X, Download, FileText, Music, Video, Image as ImageIcon, ShieldAlert } from 'lucide-react';
import { formatBytes, formatDateTime } from '../lib/format';

export interface PreviewableFile {
  id: string;
  name: string;
  mimeType: string;
  category: string;
  sizeBytes: number;
  canPreviewInline: boolean;
  createdAt?: string;
  contentUrl: string;
  downloadUrl: string;
}

interface PreviewModalProps {
  file: PreviewableFile | null;
  onClose: () => void;
}

export const PreviewModal: React.FC<PreviewModalProps> = ({ file, onClose }) => {
  if (!file) return null;

  const isImage = file.category === 'image' && file.canPreviewInline;
  const isVideo = file.category === 'video' && file.canPreviewInline;
  const isAudio = file.category === 'audio' && file.canPreviewInline;
  const isPdf = file.category === 'pdf' && file.canPreviewInline;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-slate-950/90 backdrop-blur-xs text-white"
      role="dialog"
      aria-modal="true"
    >
      {/* Top Header */}
      <div className="h-16 px-4 lg:px-8 flex items-center justify-between border-b border-slate-800 bg-slate-900/80">
        <div className="flex items-center gap-3 min-w-0">
          {isImage ? (
            <ImageIcon className="w-5 h-5 text-blue-400 shrink-0" />
          ) : isVideo ? (
            <Video className="w-5 h-5 text-purple-400 shrink-0" />
          ) : isAudio ? (
            <Music className="w-5 h-5 text-emerald-400 shrink-0" />
          ) : (
            <FileText className="w-5 h-5 text-amber-400 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{file.name}</div>
            <div className="text-xs text-slate-400">
              {formatBytes(file.sizeBytes)} • {file.mimeType}
              {file.createdAt ? ` • ${formatDateTime(file.createdAt)}` : ''}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <a
            href={file.downloadUrl}
            download={file.name}
            className="px-3.5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-xs font-medium flex items-center gap-1.5"
          >
            <Download className="w-4 h-4" />
            Download
          </a>
          <button
            onClick={onClose}
            aria-label="Close preview"
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Preview Body */}
      <div className="flex-1 flex items-center justify-center p-4 lg:p-8 overflow-auto">
        {isImage && (
          <img
            src={file.contentUrl}
            alt={file.name}
            className="max-w-full max-h-[80vh] object-contain rounded-lg shadow-2xl"
          />
        )}

        {isVideo && (
          <video
            src={file.contentUrl}
            controls
            autoPlay
            className="max-w-4xl w-full max-h-[80vh] rounded-xl bg-black shadow-2xl"
          />
        )}

        {isAudio && (
          <div className="w-full max-w-md p-8 rounded-2xl bg-slate-900 border border-slate-800 flex flex-col items-center gap-5 shadow-xl">
            <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 text-emerald-400 flex items-center justify-center">
              <Music className="w-8 h-8" />
            </div>
            <div className="text-center">
              <div className="font-semibold text-base">{file.name}</div>
              <div className="text-xs text-slate-400 mt-1">{formatBytes(file.sizeBytes)}</div>
            </div>
            <audio src={file.contentUrl} controls autoPlay className="w-full" />
          </div>
        )}

        {isPdf && (
          <iframe
            src={file.contentUrl}
            title={file.name}
            className="w-full max-w-5xl h-[82vh] rounded-xl bg-white border border-slate-800"
          />
        )}

        {!isImage && !isVideo && !isAudio && !isPdf && (
          <div className="max-w-md w-full p-8 rounded-2xl bg-slate-900 border border-slate-800 text-center space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-slate-800 text-slate-300 flex items-center justify-center mx-auto">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <div className="text-base font-semibold">Inline Preview Disabled or Unsupported</div>
            <p className="text-xs text-slate-400 leading-relaxed">
              For security or format reasons ({file.mimeType}), this file is not rendered inline in the browser. You can download it directly to your device.
            </p>
            <a
              href={file.downloadUrl}
              download={file.name}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-xs font-semibold"
            >
              <Download className="w-4 h-4" />
              Download File ({formatBytes(file.sizeBytes)})
            </a>
          </div>
        )}
      </div>
    </div>
  );
};
