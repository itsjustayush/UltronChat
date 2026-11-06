import React, { useState } from 'react';
import { BundleItem } from '../types';
import { formatBytes } from '../lib/crypto';

interface FilePreviewModalProps {
  file: BundleItem;
  onClose: () => void;
  onDownload: (file: BundleItem) => void;
}

export const FilePreviewModal: React.FC<FilePreviewModalProps> = ({
  file,
  onClose,
  onDownload,
}) => {
  const isImage =
    file.type.startsWith('image/') ||
    ['PNG', 'JPG', 'JPEG', 'WEBP', 'SVG'].some((ext) =>
      file.name.toUpperCase().endsWith(ext)
    );

  const isVideo =
    file.type.startsWith('video/') ||
    ['MP4', 'MOV', 'WEBM'].some((ext) => file.name.toUpperCase().endsWith(ext));

  const isTextOrSnippet =
    Boolean(file.textContent) ||
    file.type.startsWith('text/') ||
    file.fileTypeLabel === 'TXT_SNIPPET' ||
    ['TXT', 'MD', 'PY', 'JS', 'TS', 'JSX', 'TSX', 'HTML', 'CSS', 'JSON', 'C', 'CPP', 'JAVA', 'SH'].some((ext) =>
      file.name.toUpperCase().endsWith(ext)
    );

  const [copiedText, setCopiedText] = useState(false);

  const handleCopyText = () => {
    if (!file.textContent) return;
    navigator.clipboard.writeText(file.textContent).then(() => {
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 1500);
    });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8 animate-in fade-in duration-200">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-md cursor-pointer"
        onClick={onClose}
      ></div>

      {/* Modal Content Container */}
      <div className="relative w-full max-w-5xl h-full max-h-[90dvh] bg-black/60 backdrop-blur-2xl border border-white/10 rounded-2xl flex flex-col overflow-hidden z-10 shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 md:p-6 border-b border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-3 truncate pr-4">
            <span className="material-symbols-outlined text-blue-400">
              {isImage ? 'image' : isVideo ? 'video_library' : isTextOrSnippet ? 'code' : 'description'}
            </span>
            <h3 className="font-geist text-xl md:text-2xl font-bold tracking-tight text-white truncate">
              {file.name}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 text-white/70 hover:text-white transition-colors cursor-pointer rounded-xl border border-white/10"
            title="Close Preview"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* Modal Body (Two-Column Layout) */}
        <div className="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden">
          {/* Main Preview Area */}
          <div className="flex-[3] relative bg-black/40 flex items-center justify-center p-6 md:p-8 overflow-hidden group">
            <div className="absolute top-4 left-4 z-10">
              <span className="bg-black/60 backdrop-blur-md px-3 py-1 font-mono text-xs border border-white/20 rounded-full text-blue-400">
                PREVIEW_MODE: HIGH_RES
              </span>
            </div>

            {/* File Content Preview */}
            <div className="relative w-full h-full flex items-center justify-center overflow-auto">
              {isImage && file.blobUrl ? (
                <img
                  src={file.blobUrl}
                  alt={file.name}
                  className="max-w-full max-h-full object-contain rounded-2xl border border-white/10 shadow-2xl transition-transform duration-300 hover:scale-105"
                />
              ) : isVideo && file.blobUrl ? (
                <video
                  src={file.blobUrl}
                  controls
                  className="max-w-full max-h-full rounded-2xl border border-white/10 shadow-2xl"
                />
              ) : isTextOrSnippet ? (
                <div className="w-full h-full flex flex-col bg-black/80 rounded-2xl border border-white/10 overflow-hidden">
                  <div className="flex items-center justify-between p-3 bg-white/[0.03] border-b border-white/10">
                    <span className="font-mono text-xs text-blue-400 font-bold uppercase">
                      {file.fileTypeLabel || 'TEXT_SNIPPET'} // {file.name}
                    </span>
                    {file.textContent && (
                      <button
                        onClick={handleCopyText}
                        className="px-3 py-1 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 border border-blue-500/40 rounded-lg font-mono text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                      >
                        <span className="material-symbols-outlined text-sm">content_copy</span>
                        {copiedText ? 'COPIED' : 'COPY_TEXT'}
                      </button>
                    )}
                  </div>
                  <div className="p-4 flex-1 overflow-auto font-mono text-xs text-blue-300 leading-relaxed whitespace-pre-wrap selection:bg-blue-500 selection:text-white">
                    {file.textContent || `{
  "node_id": "${file.fileId}",
  "file_name": "${file.name}",
  "transport": "WEBRTC-DTLS",
  "sha256": "${file.sha256}",
  "size_bytes": ${file.size},
  "carbon_footprint_gCO2e": ${file.carbonFootprintGrams},
  "status": "VERIFIED_VALID"
}`}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center text-center p-8 border border-dashed border-white/20 rounded-2xl bg-white/[0.02]">
                  <span className="material-symbols-outlined text-6xl text-blue-400 mb-4">
                    file_present
                  </span>
                  <h4 className="font-mono text-lg text-white font-bold mb-1">{file.name}</h4>
                  <p className="font-mono text-xs text-white/50 mb-4 uppercase">
                    BRUTALIST_BLOB // {formatBytes(file.size)}
                  </p>
                  <span className="px-3 py-1 bg-blue-500/10 border border-blue-400/40 text-blue-400 font-mono text-xs rounded-full">
                    MEMORY_ONLY_PAYLOAD
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Technical Sidebar */}
          <aside className="flex-1 border-t md:border-t-0 md:border-l border-white/10 bg-black/50 backdrop-blur-xl p-6 flex flex-col gap-6 overflow-y-auto">
            {/* Metadata Block */}
            <div className="space-y-4">
              <div>
                <span className="font-mono text-[11px] font-bold text-white/50 block mb-1.5 uppercase">
                  FILE_ID
                </span>
                <div className="p-3 bg-white/[0.03] border border-white/10 rounded-xl">
                  <code className="font-mono text-xs text-blue-400 break-all font-bold">
                    {file.fileId}
                  </code>
                </div>
              </div>

              <div>
                <span className="font-mono text-[11px] font-bold text-white/50 block mb-1.5 uppercase">
                  DIMENSIONS / SPECS
                </span>
                <div className="p-3 bg-white/[0.03] border border-white/10 rounded-xl">
                  <code className="font-mono text-xs text-white">
                    {file.dimensions || 'RAW_STREAM_DATA'}
                  </code>
                </div>
              </div>

              <div>
                <span className="font-mono text-[11px] font-bold text-white/50 block mb-1.5 uppercase">
                  SHA-256_HASH
                </span>
                <div className="p-3 bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
                  <code className="font-mono text-[11px] text-blue-300 break-all leading-tight">
                    {file.sha256}
                  </code>
                </div>
              </div>

              <div>
                <span className="font-mono text-[11px] font-bold text-white/50 block mb-1.5 uppercase">
                  SIZE & CARBON IMPACT
                </span>
                <div className="p-3 bg-white/[0.03] border border-white/10 rounded-xl space-y-1">
                  <div className="font-mono text-xs text-white flex justify-between">
                    <span>SIZE:</span>
                    <span>{formatBytes(file.size)}</span>
                  </div>
                  <div className="font-mono text-xs text-emerald-400 flex justify-between">
                    <span>CARBON:</span>
                    <span>{file.carbonFootprintGrams} g CO2e</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Status Indicator */}
            <div className="mt-auto border-t border-white/10 pt-4">
              <div className="flex items-center gap-2 mb-1">
                <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse shadow-[0_0_8px_#3b82f6]"></div>
                <span className="font-mono text-xs font-bold text-white">INTEGRITY_VERIFIED</span>
              </div>
              <p className="font-sans text-xs text-white/50 italic">
                Peer seeds: {file.peerSeeds} active on grid.
              </p>
            </div>
          </aside>
        </div>

        {/* Modal Footer (Actions) */}
        <footer className="p-4 md:p-6 border-t border-white/10 bg-white/[0.02] flex flex-col sm:flex-row gap-3 items-center justify-between">
          <div className="flex gap-3 w-full sm:w-auto">
            <button
              onClick={() => onDownload(file)}
              className="frosted-button-primary px-6 py-3.5 rounded-xl font-mono text-xs font-bold transition-all flex items-center justify-center gap-2 flex-1 sm:flex-initial cursor-pointer"
            >
              <span className="material-symbols-outlined text-lg">download</span>
              DOWNLOAD
            </button>

          </div>

          <button
            onClick={onClose}
            className="text-white/50 font-mono text-xs font-bold underline hover:text-white transition-colors cursor-pointer"
          >
            DISMISS_PREVIEW
          </button>
        </footer>
      </div>
    </div>
  );
};
