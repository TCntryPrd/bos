/**
 * FileIngest — Filesystem Scan Progress & Cleanup Proposals
 *
 * Shows:
 * - Scan paths with file counts and sizes
 * - Active scan progress
 * - Cleanup proposals from the BOS API
 * - Approve/reject individual cleanup actions
 * - Review folder contents (files pending permanent deletion)
 */

import React, { useState, useEffect, useCallback } from 'react';

type ScanState = 'idle' | 'scanning' | 'complete' | 'error';

/** Format bytes into human-readable string */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/** Format a date string to relative time */
function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function FileIngest() {
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanResults, setScanResults] = useState<ScanResult[]>([]);
  const [scanError, setScanError] = useState('');
  const [scanPaths, setScanPaths] = useState<Array<{ path: string; label: string }>>([]);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [currentScanIndex, setCurrentScanIndex] = useState(0);
  const [totalScanPaths, setTotalScanPaths] = useState(0);

  // Load scan paths and review items on mount
  useEffect(() => {
    async function load() {
      try {
        const paths = await window.boss.fs.getDefaultScanPaths();
        setScanPaths(paths);

        const items = await window.boss.cleanup.getReviewItems();
        setReviewItems(items);
      } catch (err) {
        console.error('Failed to load scan paths:', err);
      }
    }
    load();
  }, []);

  // Run full scan
  const runScan = useCallback(async () => {
    setScanState('scanning');
    setScanError('');
    setScanResults([]);
    setCurrentScanIndex(0);

    try {
      const paths = await window.boss.fs.getScanPaths();
      setTotalScanPaths(paths.length);

      const results: ScanResult[] = [];
      for (let i = 0; i < paths.length; i++) {
        setCurrentScanIndex(i + 1);
        const result = await window.boss.fs.scanDirectory(paths[i]);
        results.push(result);
        setScanResults([...results]);
      }

      setScanState('complete');
    } catch (err: any) {
      setScanState('error');
      setScanError(err.message || 'Scan failed');
    }
  }, []);

  // Add custom scan path
  const addScanPath = useCallback(async () => {
    const dir = await window.boss.config.pickDirectory();
    if (dir) {
      await window.boss.config.addScanPath(dir);
      const paths = await window.boss.fs.getDefaultScanPaths();
      setScanPaths(paths);
    }
  }, []);

  // Open file in explorer
  const showInExplorer = useCallback(async (filePath: string) => {
    await window.boss.fs.showInExplorer(filePath);
  }, []);

  // Purge old review items
  const purgeReview = useCallback(async () => {
    const count = await window.boss.cleanup.purgeReviewFolder(7);
    if (count > 0) {
      const items = await window.boss.cleanup.getReviewItems();
      setReviewItems(items);
    }
  }, []);

  return (
    <div className="p-4 space-y-6">
      {/* Scan Controls */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-slate-200">Scan Paths</h3>
          <button
            onClick={addScanPath}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            + Add folder
          </button>
        </div>

        <div className="space-y-2 mb-4">
          {scanPaths.map((sp) => (
            <div
              key={sp.path}
              className="flex items-center justify-between px-3 py-2 bg-slate-700/50 rounded-lg text-sm"
            >
              <div className="flex items-center gap-2 min-w-0">
                <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span className="text-slate-300 truncate">{sp.label}</span>
              </div>
              <button
                onClick={() => showInExplorer(sp.path)}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0 ml-2"
                title="Open in Explorer"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </button>
            </div>
          ))}

          {scanPaths.length === 0 && (
            <p className="text-xs text-slate-500 text-center py-4">
              No scan paths configured. Click "+ Add folder" above.
            </p>
          )}
        </div>

        <button
          onClick={runScan}
          disabled={scanState === 'scanning' || scanPaths.length === 0}
          className="w-full px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
        >
          {scanState === 'scanning'
            ? `Scanning... (${currentScanIndex}/${totalScanPaths})`
            : 'Run Full Scan'}
        </button>
      </div>

      {/* Scan Progress */}
      {scanState === 'scanning' && (
        <div>
          <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
            <span>Scanning directories...</span>
            <span>{currentScanIndex}/{totalScanPaths}</span>
          </div>
          <div className="w-full h-1.5 bg-slate-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${totalScanPaths > 0 ? (currentScanIndex / totalScanPaths) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Scan Error */}
      {scanState === 'error' && (
        <div className="p-3 bg-red-900/30 border border-red-800 rounded-lg text-red-400 text-sm">
          {scanError}
        </div>
      )}

      {/* Scan Results */}
      {scanResults.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-200 mb-3">
            Scan Results
            {scanState === 'complete' && (
              <span className="text-xs text-slate-500 font-normal ml-2">
                {scanResults.reduce((s, r) => s + r.fileCount, 0).toLocaleString()} files
              </span>
            )}
          </h3>

          <div className="space-y-2">
            {scanResults.map((result) => (
              <div
                key={result.rootPath}
                className="px-3 py-3 bg-slate-700/50 rounded-lg"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-slate-200">{result.label}</span>
                  <span className="text-xs text-slate-400">{formatBytes(result.totalSize)}</span>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span>{result.fileCount.toLocaleString()} files</span>
                  <span>{result.dirCount.toLocaleString()} folders</span>
                  {result.errors.length > 0 && (
                    <span className="text-amber-500">{result.errors.length} errors</span>
                  )}
                </div>

                {/* Top extensions breakdown */}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {getTopExtensions(result.files).map(([ext, count]) => (
                    <span
                      key={ext}
                      className="px-1.5 py-0.5 bg-slate-600/50 rounded text-xs text-slate-400"
                    >
                      {ext || 'no ext'} ({count})
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Review Folder */}
      {reviewItems.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-200">
              Review Folder
              <span className="text-xs text-slate-500 font-normal ml-2">
                {reviewItems.length} items
              </span>
            </h3>
            <button
              onClick={purgeReview}
              className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
            >
              Purge 7d+
            </button>
          </div>

          <div className="space-y-1.5">
            {reviewItems.slice(0, 10).map((item) => (
              <div
                key={item.path}
                className="flex items-center justify-between px-3 py-2 bg-slate-700/30 rounded-lg text-xs"
              >
                <span className="text-slate-400 truncate mr-2">{item.name}</span>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-slate-500">{formatBytes(item.size)}</span>
                  <span className="text-slate-600">{timeAgo(item.movedAt)}</span>
                </div>
              </div>
            ))}

            {reviewItems.length > 10 && (
              <p className="text-xs text-slate-600 text-center py-1">
                +{reviewItems.length - 10} more items
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Get the top 5 file extensions by count */
function getTopExtensions(files: FileMetadata[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (file.isDirectory) continue;
    const ext = file.extension || '(none)';
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}
