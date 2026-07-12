/**
 * Paperclip — embedded Paperclip.ing agent orchestration platform.
 * Full iframe embed of the locally-running Paperclip instance.
 */

export default function Paperclip() {
  return (
    <div className="aios-page aios-page-pad h-full min-h-0 w-full flex flex-col gap-3">
      <header className="aios-command-hero flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-text-muted">Agent Orchestration</div>
          <h1 className="mt-1 text-lg font-semibold text-text-primary">Paperclip</h1>
        </div>
        <a
          href="https://last-castle.daggertooth-larch.ts.net:10443"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary text-xs"
        >
          Open Full Screen
        </a>
      </header>
      <div className="aios-iframe-shell flex-1">
        <iframe
          src="https://last-castle.daggertooth-larch.ts.net:10443"
          className="h-full w-full border-0"
          title="Paperclip"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </div>
  );
}
