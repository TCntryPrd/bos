/**
 * WhatsApp tile — threads list + thread view + reply textbox.
 *
 * Backed by a self-hosted Baileys (@whiskeysockets/baileys) session — an
 * unofficial multi-device linked device. Pairing happens HERE on this page:
 *   1. Disclaimer modal (informational; close it and the QR is revealed).
 *   2. QR pairing panel (poll /whatsapp/qr + /whatsapp/status until ready).
 *   3. Normal inbox. Disclaimer + SOP tuck behind a header button afterward.
 *
 * Layout: two columns. Left = threads list (sorted by last_message_at,
 * unread badge on each row). Right = selected thread message history
 * with reply box at bottom. Polls every 5s for new messages on the
 * active thread + every 10s for the threads list.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, BookOpen, DownloadCloud, FileText, Loader2, QrCode, ShieldAlert, Smartphone, Unplug, X,
} from 'lucide-react';
import {
  ApiClientError,
  whatsappApi,
  type WhatsappThread,
  type WhatsappMessage,
  type WhatsappContact,
  type WhatsappImportStatus,
  type WhatsappQrReason,
  type WhatsappStatus,
} from '../lib/api';

const EMPTY_IMPORT_PROGRESS: WhatsappImportStatus['progress'] = {
  chatsDone: 0,
  chatsTotal: 0,
  messagesInserted: 0,
};

function importProgressLabel(progress: WhatsappImportStatus['progress']): string {
  const total = progress.chatsTotal ? `/${progress.chatsTotal}` : '';
  return `Importing… ${progress.chatsDone}${total} chats, ${progress.messagesInserted} messages`;
}

const FMT_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function relTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return FMT_DATE.format(d);
}

function threadTitle(t: WhatsappThread): string {
  return t.display_name || t.phone || t.chat_id;
}

function contactTitle(c: WhatsappContact): string {
  return c.display_name || c.push_name || c.phone || c.contact_id;
}

function contactDisplayName(c: WhatsappContact | undefined): string | null {
  return c?.display_name || c?.push_name || c?.verified_name || null;
}

function digitsOnly(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

function isPlaceholderName(value: string | null | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  return /^\+?\d[\d\s().-]*$/.test(trimmed) || /@(s\.whatsapp\.net|c\.us|g\.us|lid)$/i.test(trimmed);
}

interface MessageWithAttachedReactions {
  message: WhatsappMessage;
  reactions: WhatsappMessage[];
}

interface ReactionChip {
  emoji: string;
  count: number;
  senders: string[];
}

const LEGACY_REACTION_WINDOW_MS = 5 * 60_000;

function isReactionMessage(message: WhatsappMessage): boolean {
  return message.message_type === 'reaction';
}

/**
 * Keep reaction rows out of the message stream. New rows carry their exact
 * WhatsApp target id; the small time-bounded fallback only cleans up historic
 * rows that were imported before the bridge retained that id. It never writes
 * an inferred relationship back to the database.
 */
function attachReactions(messages: WhatsappMessage[]): MessageWithAttachedReactions[] {
  const items = messages
    .filter((message) => !isReactionMessage(message))
    .map((message) => ({ message, reactions: [] as WhatsappMessage[] }));
  const targetByWaId = new Map<string, MessageWithAttachedReactions>();

  for (const item of items) {
    if (item.message.wa_message_id) targetByWaId.set(item.message.wa_message_id, item);
  }

  for (const reaction of messages) {
    if (!isReactionMessage(reaction) || !reaction.body?.trim()) continue;

    if (reaction.reply_to_wa_message_id) {
      targetByWaId.get(reaction.reply_to_wa_message_id)?.reactions.push(reaction);
      continue;
    }

    const reactionAt = Date.parse(reaction.sent_at);
    if (!Number.isFinite(reactionAt)) continue;
    for (let index = items.length - 1; index >= 0; index--) {
      const candidate = items[index];
      const candidateAt = Date.parse(candidate.message.sent_at);
      const elapsed = reactionAt - candidateAt;
      if (elapsed >= 0 && elapsed <= LEGACY_REACTION_WINDOW_MS) {
        candidate.reactions.push(reaction);
        break;
      }
    }
  }

  return items;
}

function reactionChips(reactions: WhatsappMessage[]): ReactionChip[] {
  const chips = new Map<string, ReactionChip>();
  for (const reaction of reactions) {
    const emoji = reaction.body?.trim();
    if (!emoji) continue;
    const sender = reaction.sender_name || reaction.author || (reaction.from_me ? 'You' : 'Someone');
    const chip = chips.get(emoji) ?? { emoji, count: 0, senders: [] };
    chip.count += 1;
    if (!chip.senders.includes(sender)) chip.senders.push(sender);
    chips.set(emoji, chip);
  }
  return [...chips.values()];
}

// ─── Disclaimer copy (shown pre-pairing AND inside the Disclaimer & SOP modal) ─
const DISCLAIMER_PARAGRAPHS: string[] = [
  'This integration uses Baileys (@whiskeysockets/baileys), an unofficial WhatsApp automation library that connects as a multi-device "linked device" session. It is NOT the official WhatsApp Business API and is not endorsed by, affiliated with, or supported by WhatsApp or Meta.',
  'The session is tied to your own personal WhatsApp number. BOS operates as a linked device on your account — anything sent from here is sent as you, from your number.',
  'Misuse carries real risk of a WhatsApp ACCOUNT BAN. Bulk messaging, unsolicited/cold outreach, spam, or anything that generates user reports or block-rate spikes can get your number permanently banned by WhatsApp. Use this for conversations people expect to have with you.',
  'The session persists as a linked device on your account. Your phone does NOT need to stay online for BOS to send and receive. Removing the BOS linked device from your phone ends the session — you would then re-pair from this page.',
  'Messages, contacts, and thread metadata flowing through this session are stored in the BOS database so agents and the inbox can work with them.',
  'You are solely responsible for complying with the WhatsApp Terms of Service and all applicable laws (including consent, privacy, and anti-spam regulations) in every jurisdiction you message into.',
];

const SOP_SECTIONS: Array<{ title: string; items: string[] }> = [
  {
    title: 'How the session works',
    items: [
      'BOS runs a Baileys session that appears in WhatsApp as a linked device (Settings → Linked Devices on your phone).',
      'Inbound and outbound messages sync into the BOS inbox; agents read/write through the same session.',
      'The session identity is your personal WhatsApp number — every message sent from BOS comes from you.',
      'Thread history is built FORWARD from the moment you pair: messages that arrive (or that you send) after pairing always land in the inbox.',
      'History import pulls what WhatsApp sent during the pairing sync — the recent messages per chat, capped. Very old messages, and media that predates pairing, may not be recoverable. Re-run it from this panel any time; it never duplicates what is already imported.',
    ],
  },
  {
    title: 'Keeping it healthy',
    items: [
      'Your phone does not need to stay online — the session runs as an independent linked device, not a mirror of your phone.',
      'Do not manually remove the BOS linked device from your phone unless you intend to disconnect — that kills the session.',
      'If messages stop flowing, check the session status pill on this page first.',
    ],
  },
  {
    title: 'If the session drops',
    items: [
      'This page automatically falls back to the pairing screen when the session is lost.',
      'Re-pair right here: read and close the disclaimer, then scan the fresh QR with WhatsApp → Linked Devices → Link a Device.',
      'No settings changes are needed elsewhere — pairing lives on this page only.',
    ],
  },
  {
    title: 'Safe-use rules',
    items: [
      'No bulk or cold outreach. Message people who expect to hear from you.',
      'Respect opt-outs immediately and permanently.',
      'Keep volume human-scale — bursts of identical messages are the fastest route to a ban.',
      'When in doubt, do not send it from WhatsApp.',
    ],
  },
  {
    title: 'Disconnecting',
    items: [
      'Use the Disconnect button below. It logs the WhatsApp session out and unlinks the device.',
      'You can also remove the linked device from your phone (WhatsApp → Linked Devices).',
      'Re-connecting later just repeats the QR pairing flow on this page.',
    ],
  },
];

// ─── Shared modal shell ────────────────────────────────────────────────────────
function ModalShell({ onClose, label, children, dismissable = true }: {
  onClose: () => void;
  label: string;
  children: ReactNode;
  dismissable?: boolean;
}) {
  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, dismissable]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label={label}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={dismissable ? onClose : undefined} />
      <div className="relative w-full max-w-xl rounded-lg border border-white/14 bg-[#0d1114] shadow-xl flex flex-col max-h-[85vh]">
        {children}
      </div>
    </div>
  );
}

// ─── Inbound media (image / voice note / video / document) ────────────────────
// media_url is a self-contained data URI persisted by the webhook receiver at
// the moment the message arrived, so it keeps rendering after a bridge restart.
// Media that predates pairing does not exist — nothing to fall back to.
function MessageMedia({ message }: { message: WhatsappMessage }) {
  const src = message.media_url;
  if (!src) return null;

  const kind = message.message_type;
  const mime = src.slice(5, src.indexOf(';')); // "data:<mime>;base64,..."

  if (kind === 'image' || kind === 'sticker' || mime.startsWith('image/')) {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="mb-1.5 block">
        <img
          src={src}
          alt={kind === 'sticker' ? 'Sticker' : 'Photo'}
          className={`max-h-72 w-auto max-w-full rounded-md ${kind === 'sticker' ? 'bg-transparent' : 'bg-black/20'}`}
        />
      </a>
    );
  }

  // Voice notes (ptt) and audio files both get a player.
  if (kind === 'ptt' || kind === 'audio' || mime.startsWith('audio/')) {
    return (
      <audio controls preload="none" src={src} className="mb-1.5 w-60 max-w-full">
        Your browser cannot play this audio.
      </audio>
    );
  }

  if (kind === 'video' || mime.startsWith('video/')) {
    return (
      <video controls preload="metadata" src={src} className="mb-1.5 max-h-72 w-auto max-w-full rounded-md bg-black/20">
        Your browser cannot play this video.
      </video>
    );
  }

  // Documents and anything else: offer it rather than pretend to render it.
  return (
    <a
      href={src}
      download
      className={`mb-1.5 inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
        message.from_me
          ? 'border-white/25 text-white hover:bg-white/10'
          : 'border-border text-text-primary hover:bg-surface-2'
      }`}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="truncate">Download {kind === 'text' ? 'attachment' : kind}</span>
    </a>
  );
}

function DisclaimerBody() {
  return (
    <div className="space-y-3">
      {DISCLAIMER_PARAGRAPHS.map((p, i) => (
        <p key={i} className="text-[12.5px] leading-relaxed text-white/85">{p}</p>
      ))}
    </div>
  );
}

// ─── Pre-pairing disclaimer modal ─────────────────────────────────────────────
// Informational only: no checkbox, no authorization step. The reader closes it
// and the QR is revealed. Closing records an acknowledgement timestamp for the
// audit trail, but pairing is never blocked on that write succeeding.
function DisclaimerModal({ onAccepted, onClose }: { onAccepted: () => void; onClose: () => void }) {
  const dismiss = () => {
    void whatsappApi.ackDisclaimer().catch(() => undefined);
    onAccepted();
    onClose();
  };

  return (
    <ModalShell onClose={dismiss} label="WhatsApp automation disclaimer">
      <header className="flex items-start justify-between gap-3 border-b border-white/12 bg-[#0d1114] px-5 py-4 shrink-0">
        <div>
          <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-amber-300">Read before pairing</div>
          <h2 className="mt-1 flex items-center gap-2 text-base font-semibold text-white">
            <ShieldAlert className="h-4 w-4 text-amber-300" aria-hidden /> WhatsApp Automation Disclaimer
          </h2>
        </div>
        <button type="button" onClick={dismiss} aria-label="Close" className="text-white/55 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 max-h-[60vh] overflow-y-auto bg-[#0d1114] px-5 py-4">
        <DisclaimerBody />
      </div>
      <footer className="shrink-0 border-t border-white/12 bg-[#0d1114] px-5 py-4">
        <div className="flex items-center justify-end">
          <button type="button" onClick={dismiss} className="btn-primary !px-4 !py-1.5 text-xs">
            Close
          </button>
        </div>
      </footer>
    </ModalShell>
  );
}

// ─── Post-pairing "Disclaimer & SOP" modal (with Disconnect) ──────────────────
function DisclaimerSopModal({ onClose, onDisconnected, onReimport, importRunning, importProgress }: {
  onClose: () => void;
  onDisconnected: () => void;
  onReimport: () => void;
  importRunning: boolean;
  importProgress: WhatsappImportStatus['progress'];
}) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const disconnect = async () => {
    if (disconnecting) return;
    if (!window.confirm('Disconnect WhatsApp? This logs the WhatsApp session out and unlinks the device. You will need to re-pair by QR to use WhatsApp again.')) return;
    setDisconnecting(true);
    setErr(null);
    try {
      await whatsappApi.logout();
      onDisconnected();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <ModalShell onClose={onClose} label="WhatsApp disclaimer and SOP">
      <header className="flex items-start justify-between gap-3 border-b border-white/12 bg-[#0d1114] px-5 py-4 shrink-0">
        <div>
          <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-success">Reference</div>
          <h2 className="mt-1 flex items-center gap-2 text-base font-semibold text-white">
            <BookOpen className="h-4 w-4 text-success" aria-hidden /> Disclaimer &amp; SOP
          </h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="text-white/55 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 max-h-[60vh] overflow-y-auto bg-[#0d1114] px-5 py-4 space-y-5">
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-amber-300">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Disclaimer
          </h3>
          <DisclaimerBody />
        </section>
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/50">Standard Operating Procedure</h3>
          <div className="space-y-4">
            {SOP_SECTIONS.map((s) => (
              <div key={s.title}>
                <h4 className="text-[12.5px] font-semibold text-white">{s.title}</h4>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {s.items.map((item, i) => (
                    <li key={i} className="text-[12px] leading-relaxed text-white/80">{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      </div>
      <footer className="shrink-0 border-t border-white/12 bg-[#0d1114] px-5 py-4">
        {err && <p className="mb-2 text-xs text-danger">{err}</p>}
        {importRunning && (
          <p className="mb-2 text-xs text-white/60">{importProgressLabel(importProgress)}</p>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void disconnect()}
              disabled={disconnecting}
              className="btn-ghost !px-3 !py-1.5 text-xs text-danger disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {disconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Unplug className="h-3.5 w-3.5" aria-hidden />}
              {disconnecting ? 'Disconnecting…' : 'Disconnect WhatsApp'}
            </button>
            {/* Re-runnable by design: the import never duplicates rows it already wrote. */}
            <button
              type="button"
              onClick={onReimport}
              disabled={importRunning}
              className="btn-ghost !px-3 !py-1.5 text-xs disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {importRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <DownloadCloud className="h-3.5 w-3.5" aria-hidden />}
              {importRunning ? 'Importing…' : 'Re-import history'}
            </button>
          </div>
          <button type="button" onClick={onClose} className="btn-secondary !px-3 !py-1.5 text-xs">
            Close
          </button>
        </div>
      </footer>
    </ModalShell>
  );
}

// ─── History-import banner (above the threads list, offered once) ─────────────
// The bridge holds the history WhatsApp pushed at pairing time but never
// webhooks it (that would spam the inbox as "new"). This is the explicit,
// user-initiated pull of that backlog.
function ImportHistoryBanner({ running, progress, error, onImport }: {
  running: boolean;
  progress: WhatsappImportStatus['progress'];
  error: string | null;
  onImport: () => void;
}) {
  return (
    <div className="border-b border-border/70 bg-info-muted px-4 py-3">
      <div className="flex items-start gap-2.5">
        {running
          ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-info" aria-hidden />
          : <DownloadCloud className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-text-primary">Import your existing WhatsApp conversations</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
            {running
              ? importProgressLabel(progress)
              : 'Pull the threads and messages WhatsApp sent when you paired into this inbox.'}
          </p>
          {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
        </div>
        {!running && (
          <button
            type="button"
            onClick={onImport}
            className="btn-secondary !px-2 !py-1 text-xs shrink-0"
          >
            Import history
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Connection gate (shown instead of the inbox when not paired) ─────────────
function ConnectGate({ status, onStatusRefresh }: {
  status: WhatsappStatus;
  onStatusRefresh: () => void;
}) {
  // Server acceptance persists across sessions; a local flag covers the gap
  // between POST /disclaimer-ack and the next /status poll.
  const [ackedLocally, setAckedLocally] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [qrReason, setQrReason] = useState<WhatsappQrReason | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const accepted = ackedLocally || !!status.disclaimerAcceptedAt;
  const sessionStatus = status.session?.status ?? 'starting';
  const unreachable = sessionStatus === 'unreachable';

  // Poll the QR while pairing is unlocked. The QR rotates ~every 20s, so a
  // 4s refetch keeps the rendered code current. `qr: null` is NOT an error —
  // 'pending' is the normal startup window, 'already_paired' means the session
  // went ready and we should advance to the inbox.
  useEffect(() => {
    if (!accepted || !status.configured || unreachable) { setQr(null); setQrReason(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const res = await whatsappApi.getQr();
        if (!alive) return;
        setQr(res.qr ?? null);
        setQrReason(res.reason ?? null);
        setQrError(null);
        if (res.reason === 'already_paired') onStatusRefresh();
      } catch (e) {
        if (alive) { setQr(null); setQrReason(null); setQrError(e instanceof Error ? e.message : String(e)); }
      }
    };
    void load();
    const t = setInterval(load, 4_000);
    return () => { alive = false; clearInterval(t); };
  }, [accepted, status.configured, unreachable, sessionStatus, onStatusRefresh]);

  return (
    <div className="aios-page aios-page-pad flex h-full min-h-0 items-center justify-center overflow-y-auto text-text-primary">
      <div className="aios-workbench w-full max-w-lg p-6">
        <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-success">Client Comms</div>
        <h1 className="mt-1 text-lg font-semibold">Connect WhatsApp</h1>
        <p className="mt-1 text-xs text-text-muted">
          Powered by a self-hosted Baileys session — pairs to your own WhatsApp number as a linked device.
        </p>

        {!status.configured ? (
          <div className="mt-5 flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning-muted px-4 py-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <p className="text-xs text-text-secondary">
              The WhatsApp bridge is not configured on this box yet. Ask your administrator to set up the WhatsApp service, then come back to this page to pair.
            </p>
          </div>
        ) : unreachable ? (
          // Configured but the container didn't answer — a transient outage, not
          // a missing install and NOT a reason to re-run the disclaimer/QR flow.
          <div className="mt-5 space-y-3">
            <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning-muted px-4 py-3">
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-warning" aria-hidden />
              <p className="text-xs text-text-secondary">
                WhatsApp service unreachable — retrying. The WhatsApp service is installed but not answering right now (it may be restarting). Pairing state is preserved; this page reconnects on its own.
              </p>
            </div>
            <button type="button" onClick={onStatusRefresh} className="btn-secondary !px-3 !py-1.5 text-xs">
              Retry now
            </button>
          </div>
        ) : !accepted ? (
          <>
            <div className="mt-5 flex items-start gap-2.5 rounded-lg border border-border/70 bg-surface-2/60 px-4 py-3">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <p className="text-xs text-text-secondary">
                This is an unofficial WhatsApp automation. Before you pair by QR code, review the disclaimer — it covers the account-ban risk, what gets stored, and your compliance responsibilities.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="btn-primary mt-4 w-full !py-2 text-sm inline-flex items-center justify-center gap-2"
            >
              <ShieldAlert className="h-4 w-4" aria-hidden /> Review disclaimer to continue
            </button>
          </>
        ) : (
          <div className="mt-5">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <QrCode className="h-4 w-4 text-success" aria-hidden /> Scan to pair
              </h2>
              <span className={`vs-mono text-[10px] uppercase tracking-[0.14em] ${
                sessionStatus === 'error' ? 'text-danger' : sessionStatus === 'scan_qr' ? 'text-success' : 'text-text-muted'
              }`}>
                {sessionStatus === 'scan_qr' ? 'waiting for scan'
                  : sessionStatus === 'starting' ? 'session starting'
                  : sessionStatus === 'error' ? 'session error'
                  : sessionStatus}
              </span>
            </div>

            <div className="mt-3 flex items-center justify-center rounded-lg border border-border/70 bg-white p-4">
              {qr ? (
                <img src={qr} alt="WhatsApp pairing QR code" className="h-64 w-64 max-w-full" />
              ) : qrError || sessionStatus === 'error' ? (
                // Real failure only — a missing QR on its own is a waiting state.
                <div className="flex h-64 w-64 flex-col items-center justify-center gap-2 text-center">
                  <AlertTriangle className="h-6 w-6 text-danger" aria-hidden />
                  <p className="px-4 text-xs text-neutral-600">The WhatsApp session hit an error. It usually recovers on its own; if not, restart the WhatsApp service.</p>
                  {qrError && <p className="px-4 text-[11px] text-red-600">{qrError}</p>}
                  <button type="button" onClick={onStatusRefresh} className="btn-secondary !px-3 !py-1.5 text-xs">
                    Retry
                  </button>
                </div>
              ) : (
                <div className="flex h-64 w-64 flex-col items-center justify-center gap-2 text-center">
                  <Loader2 className="h-6 w-6 animate-spin text-neutral-400" aria-hidden />
                  <p className="px-4 text-xs text-neutral-600">
                    {qrReason === 'already_paired'
                      ? 'Session already paired — opening your inbox…'
                      : sessionStatus === 'starting'
                        ? 'Starting the WhatsApp session…'
                        : 'Waiting for the QR code — the session is still coming up. This usually takes a few seconds.'}
                  </p>
                </div>
              )}
            </div>

            <ol className="mt-4 list-decimal space-y-1 pl-5">
              <li className="text-xs text-text-secondary">Open <span className="font-medium text-text-primary">WhatsApp</span> on your phone.</li>
              <li className="text-xs text-text-secondary">Go to <span className="font-medium text-text-primary">Settings → Linked Devices → Link a Device</span>.</li>
              <li className="text-xs text-text-secondary">Point your phone at the QR code above. The code refreshes automatically — the inbox opens the moment pairing completes.</li>
            </ol>

            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-text-muted">
              <Smartphone className="h-3.5 w-3.5" aria-hidden /> Your phone does not need to stay online afterward — the session runs as its own linked device.
            </p>
          </div>
        )}

        {modalOpen && (
          <DisclaimerModal
            onAccepted={() => { setAckedLocally(true); setModalOpen(false); onStatusRefresh(); }}
            onClose={() => setModalOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

export default function WhatsApp() {
  const [status, setStatus] = useState<WhatsappStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [sopOpen, setSopOpen] = useState(false);
  const [threads, setThreads] = useState<WhatsappThread[]>([]);
  const [contacts, setContacts] = useState<WhatsappContact[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<WhatsappMessage[]>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [syncingContacts, setSyncingContacts] = useState(false);
  const [leftView, setLeftView] = useState<'threads' | 'contacts'>('threads');
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const [statusTick, setStatusTick] = useState(0);

  const [wasPaired, setWasPaired] = useState(false);

  const [importRunning, setImportRunning] = useState(false);
  const [importProgress, setImportProgress] = useState<WhatsappImportStatus['progress']>(EMPTY_IMPORT_PROGRESS);
  const [importError, setImportError] = useState<string | null>(null);
  // Hides the banner the moment a clean run finishes, without waiting for the
  // next /status poll to report historyImported.
  const [importDone, setImportDone] = useState(false);

  const sessionUnreachable = status?.session?.status === 'unreachable';
  // A transient wa-bridge outage reports paired:false. Don't tear a paired user's
  // inbox down for it — the inbox reads the DB (still fine) and the page shows
  // a retrying banner instead of the disclaimer/QR gate.
  const paired = !!status?.paired || (sessionUnreachable && wasPaired);
  const refreshStatus = useCallback(() => setStatusTick((n) => n + 1), []);

  useEffect(() => {
    if (status?.paired) setWasPaired(true);
    else if (status && !sessionUnreachable) setWasPaired(false);
  }, [status, sessionUnreachable]);

  // Session status poll — drives the pairing gate and auto-advances to the
  // inbox when the session flips to ready. 4s while unpaired (QR flow needs
  // it snappy), the same cadence is cheap enough to keep when paired so a
  // dropped session falls back to the gate quickly.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await whatsappApi.getStatus();
        if (alive) { setStatus(res); setStatusLoaded(true); }
      } catch (e) {
        if (alive) { setStatusLoaded(true); setError(e instanceof Error ? e.message : String(e)); }
      }
    };
    void load();
    const t = setInterval(load, 4_000);
    return () => { alive = false; clearInterval(t); };
  }, [statusTick]);

  // Initial + interval poll for threads list (only once paired)
  useEffect(() => {
    if (!paired) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await whatsappApi.listThreads();
        if (alive) setThreads(res.threads);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [paired]);

  // Initial + interval poll for contact list (only once paired)
  useEffect(() => {
    if (!paired) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await whatsappApi.listContacts();
        if (alive) setContacts(res.contacts);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [paired]);

  // Adopt an import that is already in flight (page reload, second tab).
  useEffect(() => {
    if (!paired) return;
    let alive = true;
    void whatsappApi.getImportStatus()
      .then((res) => {
        if (!alive || !res.running) return;
        setImportProgress(res.progress);
        setImportRunning(true);
      })
      .catch(() => { /* status is best-effort — the banner still offers the import */ });
    return () => { alive = false; };
  }, [paired]);

  const startImport = useCallback(() => {
    if (importRunning) return;
    setImportError(null);
    setImportProgress(EMPTY_IMPORT_PROGRESS);
    setImportRunning(true);
    void whatsappApi.importHistory().catch((e: unknown) => {
      // 409 = a run is already going (another tab). Follow it rather than fail.
      if (e instanceof ApiClientError && e.status === 409) return;
      setImportRunning(false);
      setImportError(e instanceof Error ? e.message : String(e));
    });
  }, [importRunning]);

  // Progress poll — runs only while an import is in flight.
  useEffect(() => {
    if (!importRunning) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await whatsappApi.getImportStatus();
        if (!alive || res.running) {
          if (alive) setImportProgress(res.progress);
          return;
        }
        setImportProgress(res.progress);
        setImportRunning(false);
        setImportError(res.lastError);
        if (!res.lastError) setImportDone(true);

        // Pull in what just landed, and refresh /status so historyImported flips.
        const [threadRes, contactRes] = await Promise.all([
          whatsappApi.listThreads(),
          whatsappApi.listContacts(),
        ]);
        if (!alive) return;
        setThreads(threadRes.threads);
        setContacts(contactRes.contacts);
        refreshStatus();
      } catch (e) {
        if (!alive) return;
        setImportRunning(false);
        setImportError(e instanceof Error ? e.message : String(e));
      }
    };
    const t = setInterval(() => { void tick(); }, 2_000);
    return () => { alive = false; clearInterval(t); };
  }, [importRunning, refreshStatus]);

  // Load messages on thread select + poll every 5s
  useEffect(() => {
    if (!selected || !paired) { setMessages([]); return; }
    let alive = true;
    const load = async () => {
      try {
        const res = await whatsappApi.getMessages(selected);
        if (alive) setMessages(res.messages);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    // Mark read on select
    void whatsappApi.markRead(selected).catch(() => { /* best effort */ });
    const t = setInterval(load, 5_000);
    return () => { alive = false; clearInterval(t); };
  }, [selected, paired]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.chat_id === selected) || null,
    [threads, selected],
  );

  const displayedMessages = useMemo(() => attachReactions(messages), [messages]);

  const contactsByThread = useMemo(() => {
    const map = new Map<string, WhatsappContact>();
    for (const contact of contacts) {
      map.set(contact.contact_id, contact);
      const phoneDigits = digitsOnly(contact.phone);
      if (phoneDigits) map.set(phoneDigits, contact);
    }
    return map;
  }, [contacts]);

  const threadContact = (thread: WhatsappThread): WhatsappContact | undefined => {
    const direct = contactsByThread.get(thread.chat_id);
    if (direct) return direct;
    const phoneDigits = digitsOnly(thread.phone);
    return phoneDigits ? contactsByThread.get(phoneDigits) : undefined;
  };

  const displayThreadTitle = (thread: WhatsappThread): string => {
    const title = threadTitle(thread);
    // A group contact's push name belongs to its latest sender, not the
    // group. Only the thread title (fed by group metadata) is safe to show.
    if (thread.is_group) return title;
    const contactName = contactDisplayName(threadContact(thread));
    return isPlaceholderName(title) && contactName ? contactName : title;
  };

  const senderLabel = (message: WhatsappMessage): string | null => {
    const explicit = message.sender_name || message.author;
    if (!explicit) return null;
    const authorDigits = digitsOnly(message.author);
    if (authorDigits) {
      const contactName = contactDisplayName(contactsByThread.get(authorDigits));
      if (contactName) return contactName;
    }
    return explicit;
  };

  const send = async () => {
    if (!selected || !reply.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await whatsappApi.send(selected, reply.trim());
      setReply('');
      // Refresh messages immediately
      const res = await whatsappApi.getMessages(selected);
      setMessages(res.messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const syncContacts = async () => {
    if (syncingContacts) return;
    setSyncingContacts(true);
    setError(null);
    try {
      await whatsappApi.syncContacts();
      const res = await whatsappApi.listContacts();
      setContacts(res.contacts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncingContacts(false);
    }
  };

  // ── Gate: not paired → pairing flow instead of the (empty) inbox ──
  if (!statusLoaded || !status) {
    return (
      <div className="aios-page aios-page-pad flex h-full min-h-0 items-center justify-center text-text-muted">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
        <span className="text-sm">Checking WhatsApp session…</span>
      </div>
    );
  }

  if (!paired) {
    return <ConnectGate status={status} onStatusRefresh={refreshStatus} />;
  }

  // Offered once: while an import runs, or until one has completed. Re-runs live
  // in the Disclaimer & SOP drawer.
  const showImportBanner = importRunning || (!status.historyImported && !importDone);

  return (
    <div className="whatsapp-inbox aios-page aios-page-pad flex h-full min-h-0 gap-3 overflow-hidden text-text-primary">
      {/* Threads list */}
      <aside className="whatsapp-sidebar aios-workbench w-[min(22rem,38vw)] min-w-[260px] flex-shrink-0 overflow-y-auto">
        <header className="whatsapp-sidebar-header sticky top-0 z-10 border-b border-border/70 bg-surface-1/80 px-4 py-3 backdrop-blur-xl">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="vs-mono text-[10px] uppercase tracking-[0.22em] text-success">Client Comms</div>
              <h2 className="mt-1 text-sm font-semibold text-text-primary">WhatsApp</h2>
              <p className="text-xs text-text-muted mt-0.5">
                {leftView === 'threads' ? `${threads.length} threads` : `${contacts.length} contacts`}
                {status.session?.phone ? ` · ${status.session.phone}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {leftView === 'contacts' && (
                <button
                  onClick={() => void syncContacts()}
                  disabled={syncingContacts}
                  className="btn-secondary !px-2 !py-1 text-xs disabled:opacity-50"
                >
                  {syncingContacts ? 'syncing' : 'sync'}
                </button>
              )}
              <button
                onClick={() => setSopOpen(true)}
                title="Disclaimer & SOP"
                className="btn-secondary !px-2 !py-1 text-xs inline-flex items-center gap-1"
              >
                <BookOpen className="h-3.5 w-3.5" aria-hidden /> Disclaimer &amp; SOP
              </button>
            </div>
          </div>
          <div className="aios-segment mt-3 grid grid-cols-2 text-xs">
            <button
              onClick={() => setLeftView('threads')}
              className={`px-2 py-1.5 ${leftView === 'threads' ? 'bg-success text-white' : 'text-text-secondary hover:text-text-primary'}`}
            >
              Threads
            </button>
            <button
              onClick={() => setLeftView('contacts')}
              className={`px-2 py-1.5 ${leftView === 'contacts' ? 'bg-success text-white' : 'text-text-secondary hover:text-text-primary'}`}
            >
              Contacts
            </button>
          </div>
          {sessionUnreachable && (
            <div className="mt-3 flex items-start gap-2 rounded border border-warning/40 bg-warning-muted px-2.5 py-2">
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-warning" aria-hidden />
              <p className="text-[11px] leading-relaxed text-text-secondary">
                WhatsApp service unreachable — retrying. History still loads; sending is paused until it reconnects.
              </p>
            </div>
          )}
        </header>
        {showImportBanner && (
          <ImportHistoryBanner
            running={importRunning}
            progress={importProgress}
            error={importError}
            onImport={startImport}
          />
        )}
        {leftView === 'threads' && threads.length === 0 && (
          <div className="whatsapp-empty-state px-4 py-8 text-center text-text-muted text-sm">
            No threads yet. Messages appear as they arrive.
          </div>
        )}
        {leftView === 'contacts' && contacts.length === 0 && (
          <div className="whatsapp-empty-state px-4 py-8 text-center text-text-muted text-sm">
            No contacts synced yet.
          </div>
        )}
        {leftView === 'threads' ? (
          <ul>
            {threads.map((t) => (
            <li key={t.chat_id}>
              <button
                onClick={() => setSelected(t.chat_id)}
                className={`whatsapp-list-row w-full text-left px-4 py-3 border-b border-border/70 hover:bg-success-muted transition-colors ${
                  selected === t.chat_id ? 'is-selected bg-success-muted' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{displayThreadTitle(t)}</span>
                      {t.is_group && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-info-muted text-info">group</span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted truncate mt-0.5">
                      {t.last_message_from_me && <span className="text-success">you: </span>}
                      {t.last_message_preview || '(no preview)'}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="text-[11px] text-text-muted">{relTime(t.last_message_at)}</span>
                    {t.unread_count > 0 && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-success text-white font-semibold min-w-[18px] text-center">
                        {t.unread_count}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            </li>
            ))}
          </ul>
        ) : (
          <ul>
            {contacts.map((c) => (
              <li key={c.contact_id}>
                <button
                  onClick={() => {
                    const thread = threads.find((t) => t.chat_id === c.contact_id);
                    if (thread) setSelected(thread.chat_id);
                  }}
                  className="whatsapp-list-row w-full text-left px-4 py-3 border-b border-border/70 hover:bg-success-muted transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{contactTitle(c)}</span>
                        {c.is_group && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-info-muted text-info">group</span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted truncate mt-0.5">
                        {c.phone || c.contact_id}
                      </p>
                    </div>
                    {c.is_my_contact && (
                      <span className="text-[10px] text-success flex-shrink-0">saved</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Thread view */}
      <main className="whatsapp-conversation aios-workbench flex-1 flex flex-col min-w-0">
        {!selectedThread ? (
          <div className="whatsapp-empty-state flex-1 flex items-center justify-center px-6 text-center text-text-muted text-sm">
            Select a thread to open the conversation.
          </div>
        ) : (
          <>
            <header className="whatsapp-conversation-header px-6 py-3 border-b border-border/70 bg-surface-1/80 backdrop-blur-xl">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="font-semibold">{displayThreadTitle(selectedThread)}</h1>
                  <p className="text-xs text-text-muted mt-0.5">
                    {selectedThread.phone || selectedThread.chat_id}
                    {selectedThread.is_group && ' · group chat'}
                  </p>
                </div>
                <button
                  onClick={() => void whatsappApi.markRead(selectedThread.chat_id)}
                  className="btn-secondary !px-2 !py-1 text-xs"
                >
                  mark read
                </button>
              </div>
            </header>

            <div ref={messagesRef} className="whatsapp-message-stage flex-1 overflow-y-auto px-6 py-4">
              <div className="whatsapp-message-column space-y-3">
              {displayedMessages.length === 0 ? (
                <p className="text-center text-text-muted text-sm">No messages yet.</p>
              ) : (
                displayedMessages.map(({ message: m, reactions }) => (
                  <div key={m.id} className={`flex ${m.from_me ? 'justify-end' : 'justify-start'}`}>
                    <div className={`whatsapp-message-stack ${m.from_me ? 'is-outbound' : 'is-inbound'}`}>
                      <div
                        className={`whatsapp-message-bubble max-w-[70%] rounded-lg px-3 py-2 text-sm ${m.from_me ? 'is-outbound' : 'is-inbound'} ${
                          m.from_me
                            ? 'bg-success text-white'
                            : 'bg-surface-1/80 text-text-primary border border-border/70'
                      }`}
                    >
                      {selectedThread.is_group && !m.from_me && senderLabel(m) && (
                        <p className="mb-1 text-[11px] font-medium text-info">
                          {senderLabel(m)}
                        </p>
                      )}
                      <MessageMedia message={m} />
                      {m.body ? (
                        <p className="whitespace-pre-wrap">{m.body}</p>
                      ) : m.message_type !== 'text' && !m.media_url ? (
                        <p className={`italic ${m.from_me ? 'text-white/70' : 'text-text-muted'}`}>[{m.message_type}]</p>
                      ) : null}
                      <p className={`whatsapp-message-time text-[12px] mt-1 ${m.from_me ? 'text-green-100' : 'text-text-muted'}`}>
                        {FMT_DATE.format(new Date(m.sent_at))}
                        {m.from_me && m.ack_status && ` · ${m.ack_status}`}
                      </p>
                      </div>
                      {reactions.length > 0 && (
                        <div className="whatsapp-message-reactions" aria-label="Message reactions">
                          {reactionChips(reactions).map((chip) => (
                            <span
                              key={chip.emoji}
                              className="whatsapp-reaction-chip"
                              title={`${chip.senders.join(', ')} reacted ${chip.emoji}`}
                              aria-label={`${chip.senders.join(', ')} reacted ${chip.emoji}${chip.count > 1 ? ` (${chip.count})` : ''}`}
                            >
                              <span aria-hidden>{chip.emoji}</span>
                              {chip.count > 1 && <span className="whatsapp-reaction-count" aria-hidden>{chip.count}</span>}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
              </div>
            </div>

            {error && (
              <div className="px-6 py-2 bg-danger-muted text-danger text-xs">{error}</div>
            )}

            <footer className="whatsapp-composer p-4 border-t border-border/70 bg-surface-1/80 backdrop-blur-xl">
              <div className="flex gap-2">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Type a reply..."
                  rows={2}
                  className="input flex-1 resize-none text-sm focus:border-success"
                />
                <button
                  onClick={() => void send()}
                  disabled={!reply.trim() || sending}
                  className="btn-primary px-4 py-2 text-sm disabled:bg-surface-3 disabled:text-text-muted"
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </footer>
          </>
        )}
      </main>

      {sopOpen && (
        <DisclaimerSopModal
          onClose={() => setSopOpen(false)}
          onDisconnected={() => { setWasPaired(false); setSelected(null); setThreads([]); setContacts([]); setMessages([]); refreshStatus(); }}
          onReimport={startImport}
          importRunning={importRunning}
          importProgress={importProgress}
        />
      )}
    </div>
  );
}
