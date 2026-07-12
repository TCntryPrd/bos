/**
 * BrowserWorkspace — embedded browser frame in the center panel.
 * Shows any URL BOS pushes from the chat. Like a built-in browser.
 */

import React, { useState } from 'react';
import { Globe, ArrowLeft, ArrowRight, RefreshCw, ExternalLink, X } from 'lucide-react';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/utils';

export function BrowserWorkspace() {
  const { browserUrl, openBrowser, closeWorkspace } = useWorkspace();
  const [inputUrl, setInputUrl] = useState(browserUrl ?? '');
  const [iframeKey, setIframeKey] = useState(0);
  const [history, setHistory] = useState<string[]>(browserUrl ? [browserUrl] : []);
  const [historyIdx, setHistoryIdx] = useState(0);

  const currentUrl = history[historyIdx] ?? browserUrl ?? '';

  function navigate(url: string) {
    let resolved = url;
    if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) {
      resolved = `https://${resolved}`;
    }
    const newHistory = [...history.slice(0, historyIdx + 1), resolved];
    setHistory(newHistory);
    setHistoryIdx(newHistory.length - 1);
    setInputUrl(resolved);
    openBrowser(resolved);
  }

  function goBack() {
    if (historyIdx > 0) {
      setHistoryIdx(historyIdx - 1);
      setInputUrl(history[historyIdx - 1]);
    }
  }

  function goForward() {
    if (historyIdx < history.length - 1) {
      setHistoryIdx(historyIdx + 1);
      setInputUrl(history[historyIdx + 1]);
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* URL bar */}
      <div className="flex items-center gap-2 p-2 border-b border-border bg-surface-2 flex-shrink-0">
        <button onClick={goBack} disabled={historyIdx <= 0}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 disabled:opacity-30 transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button onClick={goForward} disabled={historyIdx >= history.length - 1}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 disabled:opacity-30 transition-colors">
          <ArrowRight className="w-4 h-4" />
        </button>
        <button onClick={() => setIframeKey(k => k + 1)}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>

        <div className="flex-1 flex items-center gap-2 bg-surface-3 rounded-lg px-3 py-1.5 border border-border">
          <Globe className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && inputUrl.trim()) navigate(inputUrl.trim()); }}
            placeholder="Enter URL..."
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none font-mono"
            spellCheck={false}
          />
        </div>

        <a href={currentUrl} target="_blank" rel="noopener noreferrer"
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          title="Open in new tab">
          <ExternalLink className="w-4 h-4" />
        </a>
        <button onClick={closeWorkspace}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          title="Close browser">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* iframe */}
      {currentUrl ? (
        <iframe
          key={iframeKey}
          src={currentUrl}
          className="flex-1 w-full border-0 bg-white"
          title="BOS Browser"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          allow="clipboard-read; clipboard-write"
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-text-muted">
          <div className="text-center">
            <Globe className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Enter a URL or ask BOS to show you something</p>
          </div>
        </div>
      )}
    </div>
  );
}
