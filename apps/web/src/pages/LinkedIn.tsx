import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  GripVertical,
  Image as ImageIcon,
  Link as LinkIcon,
  Linkedin,
  MessageSquare,
  Paperclip,
  RefreshCcw,
  Save,
  Send,
  ShieldCheck,
  ThumbsUp,
  UserPlus,
  Users,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  linkedinApi,
  linkedinSystemApi,
  type LinkedInPostMedia,
  type LinkedInSystemAction,
  type LinkedInSystemBudget,
  type LinkedInSystemMedia,
  type LinkedInSystemOverview,
  type LinkedInSystemPost,
  type LinkedInSystemProfile,
  type LinkedInSystemWebhook,
} from '../lib/api';

type ContentLens = 'win' | 'lesson' | 'loss' | 'behind' | 'proof';
type LinkedInMetricTileId = 'posts' | 'found' | 'requested' | 'accepted' | 'drafts' | 'webhooks';
type LinkedInLeftPanelId = 'post_studio' | 'post_accept_message' | 'system_health' | 'editorial_notes';
type LinkedInRightPanelId = 'proof' | 'pending_draft' | 'posts' | 'connections_webhooks' | 'queue_caps';

const CONTENT_LENSES: Record<ContentLens, { label: string; prompt: string }> = {
  win: { label: 'Win', prompt: 'What worked, why it mattered, and who helped.' },
  lesson: { label: 'Lesson', prompt: 'What changed your mind or sharpened the process.' },
  loss: { label: 'Loss', prompt: 'What missed, what changed, and what improved.' },
  behind: { label: 'Behind scenes', prompt: 'The useful work people rarely see.' },
  proof: { label: 'Proof', prompt: 'A real result with context and restraint.' },
};

const LINKEDIN_METRIC_ORDER_KEY = 'linkedin_metric_tile_order_v1';
const LINKEDIN_LEFT_PANEL_ORDER_KEY = 'linkedin_left_panel_order_v1';
const LINKEDIN_RIGHT_PANEL_ORDER_KEY = 'linkedin_right_panel_order_v1';

const DEFAULT_METRIC_TILE_ORDER: LinkedInMetricTileId[] = ['posts', 'found', 'requested', 'accepted', 'drafts', 'webhooks'];
const DEFAULT_LEFT_PANEL_ORDER: LinkedInLeftPanelId[] = ['post_studio', 'post_accept_message', 'system_health', 'editorial_notes'];
const DEFAULT_RIGHT_PANEL_ORDER: LinkedInRightPanelId[] = ['proof', 'pending_draft', 'posts', 'connections_webhooks', 'queue_caps'];

const FMT_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function mediaTypeFor(file: File): LinkedInPostMedia['type'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'document';
}

function metric(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toLocaleString() : '0';
}

function dateLabel(value?: string | null): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return FMT_DATE.format(parsed);
}

function safeText(value?: string | null): string {
  return value?.trim() || '-';
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${ok ? 'bg-success-muted text-success' : 'bg-surface-3 text-text-muted'}`}>
      {label}
    </span>
  );
}

function normalizeOrder<T extends string>(value: unknown, defaults: readonly T[]): T[] {
  const allowed = new Set<T>(defaults);
  const saved = Array.isArray(value)
    ? value.filter((id): id is T => typeof id === 'string' && allowed.has(id as T))
    : [];
  const next = [...saved];
  for (const id of defaults) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

function readStoredOrder<T extends string>(key: string, defaults: readonly T[]): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return normalizeOrder(JSON.parse(raw), defaults);
  } catch {
    /* ignore corrupt saved layouts */
  }
  return [...defaults];
}

function useStoredOrder<T extends string>(key: string, defaults: readonly T[]) {
  const [order, setOrder] = useState<T[]>(() => readStoredOrder(key, defaults));

  const reorder = useCallback((activeId: T, overId: T) => {
    setOrder((prev) => {
      const current = normalizeOrder(prev, defaults);
      const from = current.indexOf(activeId);
      const to = current.indexOf(overId);
      if (from === -1 || to === -1 || from === to) return current;
      const next = arrayMove(current, from, to);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* local storage can be unavailable in hardened browsers */
      }
      return next;
    });
  }, [defaults, key]);

  return { order, reorder };
}

function SortableTile({ id, children, className = '' }: { id: string; children: ReactNode; className?: string }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative ${className} ${isDragging ? 'z-20 opacity-70' : ''}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="absolute -right-2 -top-2 z-20 inline-flex h-7 w-7 cursor-grab items-center justify-center rounded-full border border-border bg-surface-1 text-text-muted shadow-sm transition hover:text-text-primary active:cursor-grabbing"
        aria-label="Drag tile"
        title="Drag to rearrange"
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {children}
    </div>
  );
}

export default function LinkedInPage() {
  const [overview, setOverview] = useState<LinkedInSystemOverview | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const [postText, setPostText] = useState('');
  const [postLink, setPostLink] = useState('');
  const [media, setMedia] = useState<LinkedInPostMedia | null>(null);
  const [contentLens, setContentLens] = useState<ContentLens>('lesson');

  const [acceptMessage, setAcceptMessage] = useState('');
  const [autoSend, setAutoSend] = useState(false);
  const [messageDirty, setMessageDirty] = useState(false);
  const [savingMessage, setSavingMessage] = useState(false);
  const [actionBusy, setActionBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const next = await linkedinSystemApi.getOverview();
    setOverview(next);
    setLoaded(true);
    if (!messageDirty) {
      setAcceptMessage(next.post_accept_message.message);
      setAutoSend(next.post_accept_message.auto_send);
    }
  }, [messageDirty]);

  useEffect(() => {
    void load().catch((err) => {
      setLoaded(true);
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'LinkedIn data unavailable' });
    });
    const interval = setInterval(() => void load().catch(() => {}), 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const accountReady = Boolean(overview?.account?.unipile_account_id);
  const canPost = accountReady && !busy && (!!postText.trim() || !!media);

  const stats = overview?.stats;
  const posts = overview?.posts ?? [];
  const profiles = overview?.connections.recent ?? [];
  const actions = overview?.queue.recent ?? [];
  const webhooks = overview?.webhooks ?? [];
  const proof = overview?.proof;
  const pendingDraft = overview?.pending_draft
    ?? actions.find((action) => action.action_type === 'publish_post' && action.status === 'needs_review')
    ?? null;
  const postsWithMedia = posts.filter((post) => (post.media?.length ?? 0) > 0).length;

  const lastWebhook = useMemo(() => {
    const latest = webhooks
      .map((item) => item.last_received_at)
      .filter(Boolean)
      .sort()
      .pop();
    return latest ?? null;
  }, [webhooks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const { order: metricOrder, reorder: reorderMetric } = useStoredOrder(LINKEDIN_METRIC_ORDER_KEY, DEFAULT_METRIC_TILE_ORDER);
  const { order: leftPanelOrder, reorder: reorderLeftPanel } = useStoredOrder(LINKEDIN_LEFT_PANEL_ORDER_KEY, DEFAULT_LEFT_PANEL_ORDER);
  const { order: rightPanelOrder, reorder: reorderRightPanel } = useStoredOrder(LINKEDIN_RIGHT_PANEL_ORDER_KEY, DEFAULT_RIGHT_PANEL_ORDER);

  const handleMetricDragEnd = useCallback((event: DragEndEvent) => {
    const overId = event.over?.id;
    if (overId && event.active.id !== overId) {
      reorderMetric(event.active.id as LinkedInMetricTileId, overId as LinkedInMetricTileId);
    }
  }, [reorderMetric]);

  const handleLeftPanelDragEnd = useCallback((event: DragEndEvent) => {
    const overId = event.over?.id;
    if (overId && event.active.id !== overId) {
      reorderLeftPanel(event.active.id as LinkedInLeftPanelId, overId as LinkedInLeftPanelId);
    }
  }, [reorderLeftPanel]);

  const handleRightPanelDragEnd = useCallback((event: DragEndEvent) => {
    const overId = event.over?.id;
    if (overId && event.active.id !== overId) {
      reorderRightPanel(event.active.id as LinkedInRightPanelId, overId as LinkedInRightPanelId);
    }
  }, [reorderRightPanel]);

  async function pickFile(file: File | null) {
    if (!file) {
      setMedia(null);
      return;
    }
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
    setMedia({ type: mediaTypeFor(file), filename: file.name, dataBase64 });
  }

  function shapeDraft() {
    const raw = postText.trim();
    const seed = raw || '[drop the raw note, win, miss, or observation here]';
    const drafts: Record<ContentLens, string> = {
      win: `A small win from the work:\n\n${seed}\n\nWhat made it work:\n- [specific decision, person, or condition]\n\nWhy it mattered:\n[useful takeaway without turning it into a victory lap]\n\nWhat quiet win are you seeing in your work lately?`,
      lesson: `Something I am learning:\n\n${seed}\n\nThe shift:\n[what changed in how you think or work]\n\nThe practical takeaway:\n[one thing someone else could try]\n\nCurious where this shows up for others.`,
      loss: `This did not land the way I wanted:\n\n${seed}\n\nWhat I missed:\n[be concrete, not dramatic]\n\nWhat changes now:\n[the adjustment]\n\nThere is useful signal in the misses when we are willing to look at them.`,
      behind: `A behind-the-scenes note:\n\n${seed}\n\nThe part that is easy to overlook:\n[ordinary detail that made the work better]\n\nWhy it matters:\n[human or business relevance]\n\nMost progress looks ordinary while it is happening.`,
      proof: `A real signal from the work:\n\n${seed}\n\nContext:\n[what made this hard or meaningful]\n\nWhat I would take from it:\n[measured lesson, no hype]\n\nProof is more useful when it comes with the messy middle.`,
    };
    setPostText(drafts[contentLens]);
  }

  async function submitPost() {
    if (!canPost) return;
    setBusy(true);
    setNotice(null);
    try {
      await linkedinApi.publishPost({
        text: postText.trim(),
        ...(postLink.trim() ? { link: postLink.trim() } : {}),
        ...(media ? { media } : {}),
      });
      setPostText('');
      setPostLink('');
      setMedia(null);
      setNotice({ kind: 'ok', text: 'Posted to LinkedIn.' });
      await load();
    } catch (err) {
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'LinkedIn post failed' });
    } finally {
      setBusy(false);
    }
  }

  async function savePostAcceptMessage() {
    if (!acceptMessage.trim() || savingMessage) return;
    setSavingMessage(true);
    setNotice(null);
    try {
      const saved = await linkedinSystemApi.updatePostAcceptMessage({
        message: acceptMessage.trim(),
        auto_send: autoSend,
      });
      setAcceptMessage(saved.post_accept_message.message);
      setAutoSend(saved.post_accept_message.auto_send);
      setMessageDirty(false);
      setNotice({ kind: 'ok', text: 'LinkedIn follow-up message saved.' });
      await load();
    } catch (err) {
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'Could not save message' });
    } finally {
      setSavingMessage(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await linkedinSystemApi.sync();
      await load();
      setNotice({
        kind: 'ok',
        text: typeof result.upserted === 'number'
          ? `LinkedIn posts synced. ${result.upserted} recent posts checked.`
          : 'LinkedIn posts synced.',
      });
    } catch (err) {
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'Sync failed' });
    } finally {
      setBusy(false);
    }
  }

  async function approveAction(id: number) {
    setActionBusy(id);
    setNotice(null);
    try {
      await linkedinSystemApi.approveAction(id);
      await load();
      setNotice({ kind: 'ok', text: 'Action approved. The LinkedIn agent will process it.' });
    } catch (err) {
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'Could not approve action' });
    } finally {
      setActionBusy(null);
    }
  }

  async function cancelAction(id: number) {
    setActionBusy(id);
    setNotice(null);
    try {
      await linkedinSystemApi.cancelAction(id);
      await load();
      setNotice({ kind: 'ok', text: 'Action cancelled.' });
    } catch (err) {
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'Could not cancel action' });
    } finally {
      setActionBusy(null);
    }
  }

  const metricTiles: Record<LinkedInMetricTileId, ReactNode> = {
    posts: <MetricCard icon={BarChart3} label="Posts" value={metric(proof?.posts_loaded ?? stats?.posts)} detail={`${metric(posts.reduce((sum, item) => sum + (item.reaction_counter ?? 0), 0))} reactions`} />,
    found: <MetricCard icon={Users} label="Found" value={metric(stats?.connections_found)} detail={`${metric(stats?.connections_connected)} connected`} />,
    requested: <MetricCard icon={UserPlus} label="Requested" value={metric(stats?.requests_sent)} detail={`${metric(stats?.requests_pending)} pending`} />,
    accepted: <MetricCard icon={CheckCircle2} label="Accepted" value={metric(stats?.requests_accepted)} detail="tracked accepts" />,
    drafts: <MetricCard icon={FileText} label="Drafts" value={pendingDraft ? '1' : '0'} detail={pendingDraft ? `${pendingDraft.status.replace(/_/g, ' ')}` : 'none waiting'} />,
    webhooks: <MetricCard icon={Activity} label="Webhooks" value={metric(stats?.webhooks_last_24h)} detail={lastWebhook ? dateLabel(lastWebhook) : 'no recent hook'} />,
  };

  const leftPanelTiles: Record<LinkedInLeftPanelId, ReactNode> = {
    post_studio: (
      <section className="card p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Post Studio</h2>
            <p className="mt-0.5 text-xs text-text-muted">Win, lesson, loss, behind scenes, proof</p>
          </div>
          <StatusPill ok={accountReady} label={accountReady ? 'Ready' : 'Connect'} />
        </div>

        <div className="mb-3 rounded-md border border-border bg-surface-1 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-text-primary">Angle</div>
              <div className="truncate text-[11px] text-text-muted">{CONTENT_LENSES[contentLens].prompt}</div>
            </div>
            <button
              type="button"
              onClick={shapeDraft}
              className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary"
            >
              Shape draft
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {(Object.keys(CONTENT_LENSES) as ContentLens[]).map((lens) => (
              <button
                key={lens}
                type="button"
                onClick={() => setContentLens(lens)}
                className={`rounded-md px-2 py-1.5 text-xs font-medium ${contentLens === lens ? 'bg-info text-white' : 'bg-surface-2 text-text-secondary hover:text-text-primary'}`}
              >
                {CONTENT_LENSES[lens].label}
              </button>
            ))}
          </div>
        </div>

        <textarea
          value={postText}
          onChange={(event) => setPostText(event.target.value)}
          rows={10}
          maxLength={3000}
          placeholder="Post text"
          className="w-full resize-none rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-info focus:outline-none"
        />

        <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
          <LinkIcon className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            value={postLink}
            onChange={(event) => setPostLink(event.target.value)}
            placeholder="Optional link"
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder-text-muted outline-none"
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
            <input
              type="file"
              accept="image/*,video/*,.pdf,.doc,.docx,.ppt,.pptx"
              className="hidden"
              onChange={(event) => void pickFile(event.target.files?.[0] ?? null)}
            />
            <FileText className="h-4 w-4 shrink-0" />
            <span className="truncate">{media ? media.filename : 'Attachment'}</span>
          </label>
          {media && (
            <button
              type="button"
              onClick={() => setMedia(null)}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary"
            >
              <X className="h-3.5 w-3.5" />
              Remove
            </button>
          )}
        </div>
        {media && <ComposerMediaPreview media={media} />}

        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="vs-mono text-[10px] text-text-muted">{postText.length}/3000</span>
          <button
            type="button"
            onClick={() => void submitPost()}
            disabled={!canPost}
            className="inline-flex items-center gap-2 rounded-md bg-info px-4 py-2 text-sm font-medium text-white disabled:bg-surface-3 disabled:text-text-muted"
          >
            <Send className="h-4 w-4" />
            {busy ? 'Posting...' : 'Post'}
          </button>
        </div>
      </section>
    ),
    post_accept_message: (
      <section className="card p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Message After Accept</h2>
            <p className="mt-0.5 text-xs text-text-muted">{autoSend ? 'Auto-send enabled' : 'Review before send'}</p>
          </div>
          <StatusPill ok={!messageDirty} label={messageDirty ? 'Unsaved' : 'Saved'} />
        </div>
        <textarea
          value={acceptMessage}
          onChange={(event) => {
            setAcceptMessage(event.target.value);
            setMessageDirty(true);
          }}
          rows={6}
          maxLength={2000}
          className="w-full resize-none rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-info focus:outline-none"
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={autoSend}
              onChange={(event) => {
                setAutoSend(event.target.checked);
                setMessageDirty(true);
              }}
              className="h-4 w-4 accent-info"
            />
            Auto-send after accept
          </label>
          <button
            type="button"
            onClick={() => void savePostAcceptMessage()}
            disabled={savingMessage || !acceptMessage.trim()}
            className="inline-flex items-center gap-2 rounded-md bg-info px-3 py-2 text-sm font-medium text-white disabled:bg-surface-3 disabled:text-text-muted"
          >
            <Save className="h-4 w-4" />
            {savingMessage ? 'Saving...' : 'Save'}
          </button>
        </div>
      </section>
    ),
    system_health: <SystemHealthPanel overview={overview} loaded={loaded} />,
    editorial_notes: <CustomGptBridgePanel />,
  };

  const rightPanelTiles: Record<LinkedInRightPanelId, ReactNode> = {
    proof: (
      <section className="card overflow-hidden">
        <PanelHeader icon={ShieldCheck} title="Proof Of Work" meta={proof?.last_posts_sync_at ? `synced ${dateLabel(proof.last_posts_sync_at)}` : 'waiting'} />
        <ProofPanel overview={overview} postsWithMedia={postsWithMedia} pendingDraft={pendingDraft} />
      </section>
    ),
    pending_draft: (
      <section className="card overflow-hidden">
        <PanelHeader icon={FileText} title="Draft Waiting For Approval" meta={pendingDraft ? `#${pendingDraft.id}` : 'none'} />
        <PendingDraftPanel action={pendingDraft} busyId={actionBusy} onApprove={approveAction} onCancel={cancelAction} />
      </section>
    ),
    posts: (
      <section className="card overflow-hidden">
        <PanelHeader icon={BarChart3} title="LinkedIn Posts" meta={`${posts.length} tracked`} />
        <RecentPosts posts={posts} />
      </section>
    ),
    connections_webhooks: (
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card overflow-hidden">
          <PanelHeader icon={Users} title="Connections" meta={`${metric(stats?.connections_found)} found`} />
          <ConnectionList profiles={profiles} />
        </div>
        <div className="card overflow-hidden">
          <PanelHeader icon={Activity} title="Webhooks" meta={`${webhooks.length} streams`} />
          <WebhookList webhooks={webhooks} />
        </div>
      </section>
    ),
    queue_caps: (
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)]">
        <div className="card overflow-hidden">
          <PanelHeader icon={MessageSquare} title="Action Queue" meta={`${metric(overview?.queue.ready)} ready`} />
          <ActionQueue actions={actions} busyId={actionBusy} onApprove={approveAction} onCancel={cancelAction} />
        </div>
        <div className="card overflow-hidden">
          <PanelHeader icon={ShieldCheck} title="Daily Caps" meta="today" />
          <BudgetList budgets={overview?.queue.budgets ?? []} />
        </div>
      </section>
    ),
  };

  return (
    <div className="aios-page aios-page-pad h-full overflow-auto text-text-primary">
      <header className="aios-command-hero mb-5 flex flex-col gap-4 px-4 py-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <div className="vs-mono text-[11px] uppercase tracking-[0.22em] text-text-muted">LinkedIn system</div>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
            <Linkedin className="h-6 w-6 text-info" />
            LinkedIn
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            {loaded ? `${metric(proof?.posts_loaded ?? stats?.posts)} recent posts loaded, ${metric(postsWithMedia)} with media, ${pendingDraft ? 'draft waiting' : 'no draft waiting'}` : 'Loading LinkedIn...'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill ok={accountReady} label={accountReady ? 'Connected' : 'Offline'} />
          <StatusPill ok={Boolean(overview?.agent.running)} label={overview?.agent.running ? 'Agent running' : 'Agent pending'} />
          <button
            type="button"
            onClick={() => void syncNow()}
            className="btn-secondary text-sm disabled:opacity-60"
            disabled={busy}
          >
            <RefreshCcw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
            Sync
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="btn-secondary text-sm"
          >
            <RefreshCcw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </header>

      {notice && (
        <div className={`mb-4 rounded-md border px-3 py-2 text-sm ${notice.kind === 'ok' ? 'border-success/40 bg-success-muted text-success' : 'border-warning/40 bg-warning/10 text-warning'}`}>
          {notice.text}
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleMetricDragEnd}>
        <SortableContext items={metricOrder} strategy={rectSortingStrategy}>
          <section className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            {metricOrder.map((id) => (
              <SortableTile key={id} id={id}>
                {metricTiles[id]}
              </SortableTile>
            ))}
          </section>
        </SortableContext>
      </DndContext>

      <div className="grid gap-4 xl:grid-cols-[minmax(360px,0.9fr)_minmax(0,1.1fr)]">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleLeftPanelDragEnd}>
          <SortableContext items={leftPanelOrder} strategy={rectSortingStrategy}>
            <div className="space-y-4">
              {leftPanelOrder.map((id) => (
                <SortableTile key={id} id={id}>
                  {leftPanelTiles[id]}
                </SortableTile>
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleRightPanelDragEnd}>
          <SortableContext items={rightPanelOrder} strategy={rectSortingStrategy}>
            <div className="space-y-4">
              {rightPanelOrder.map((id) => (
                <SortableTile key={id} id={id}>
                  {rightPanelTiles[id]}
                </SortableTile>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-info/15 text-info">
          <Icon className="h-4 w-4" />
        </span>
        <span className="truncate text-xs text-text-muted">{label}</span>
      </div>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 truncate text-xs text-text-muted">{detail}</div>
    </div>
  );
}

function PanelHeader({ icon: Icon, title, meta }: { icon: LucideIcon; title: string; meta: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-4 w-4 shrink-0 text-info" />
        <h2 className="truncate text-sm font-semibold">{title}</h2>
      </div>
      <span className="shrink-0 text-xs text-text-muted">{meta}</span>
    </div>
  );
}

function ProofPanel({
  overview,
  postsWithMedia,
  pendingDraft,
}: {
  overview: LinkedInSystemOverview | null;
  postsWithMedia: number;
  pendingDraft: LinkedInSystemAction | null;
}) {
  const proof = overview?.proof;
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
      <ProofTile label="Owner" value={safeText(proof?.account_display_name || overview?.account?.display_name)} detail={safeText(proof?.owner_public_identifier || overview?.account?.public_identifier)} />
      <ProofTile label="Recent posts loaded" value={metric(proof?.posts_loaded ?? overview?.stats.posts)} detail={`showing ${metric(proof?.posts_visible ?? overview?.posts.length)}`} />
      <ProofTile label="Media found" value={metric(proof?.posts_with_media ?? postsWithMedia)} detail={proof?.latest_media_url ? 'latest media visible below' : 'no media in latest page'} />
      <ProofTile label="Approval draft" value={pendingDraft ? 'Ready' : 'Missing'} detail={pendingDraft ? `action #${pendingDraft.id}` : 'sync will create one'} />
    </div>
  );
}

function ProofTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-1 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold text-text-primary">{value}</div>
      <div className="mt-1 truncate text-xs text-text-muted">{detail}</div>
    </div>
  );
}

function PendingDraftPanel({
  action,
  busyId,
  onApprove,
  onCancel,
}: {
  action: LinkedInSystemAction | null;
  busyId: number | null;
  onApprove: (id: number) => Promise<void>;
  onCancel: (id: number) => Promise<void>;
}) {
  if (!action) return <EmptyPanel label="No LinkedIn post draft is waiting for approval yet." />;
  const title = action.payload?.draft_title || 'LinkedIn draft';
  const media = action.payload?.media ?? [];
  return (
    <div className="p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-xs text-text-muted">{action.payload?.approval_note || `Created ${dateLabel(action.created_at)}`}</p>
        </div>
        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
          {action.status.replace(/_/g, ' ')}
        </span>
      </div>
      {action.payload?.content_series && <ContentSeriesPanel series={action.payload.content_series} />}
      <div className="rounded-md border border-border bg-surface-2">
        <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          Full Draft
        </div>
        <div className="max-h-[70vh] min-h-[280px] overflow-y-auto whitespace-pre-wrap px-3 py-3 text-sm leading-6">
          {safeText(action.payload?.text)}
        </div>
      </div>
      <MediaPreviewGrid media={media} />
      {action.payload?.source_posts && action.payload.source_posts.length > 0 && (
        <div className="mt-3 rounded-md border border-border bg-surface-1 p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Source Posts And Media</div>
          <SourcePostCards posts={action.payload.source_posts} />
        </div>
      )}
      {action.payload?.email_context && <EmailContextPanel context={action.payload.email_context} />}
      {action.status === 'needs_review' ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void onCancel(action.id)}
            disabled={busyId === action.id}
            className="rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onApprove(action.id)}
            disabled={busyId === action.id}
            className="inline-flex items-center gap-2 rounded-md bg-info px-3 py-2 text-sm font-medium text-white disabled:bg-surface-3 disabled:text-text-muted"
          >
            <Send className="h-4 w-4" />
            Approve Post
          </button>
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-secondary">
          This draft is {action.status.replace(/_/g, ' ')}.
        </div>
      )}
    </div>
  );
}

function ContentSeriesPanel({
  series,
}: {
  series: NonNullable<NonNullable<LinkedInSystemAction['payload']>['content_series']>;
}) {
  return (
    <div className="mb-3 rounded-md border border-info/30 bg-info/10 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-info">Content Series</div>
      <div className="mt-1 text-sm font-semibold text-text-primary">{series.name || 'Recurring post'}</div>
      {series.promise && <p className="mt-1 text-xs leading-5 text-text-secondary">{series.promise}</p>}
      {series.trust_message && <p className="mt-2 text-xs leading-5 text-text-muted">{series.trust_message}</p>}
    </div>
  );
}

function EmailContextPanel({
  context,
}: {
  context: NonNullable<NonNullable<LinkedInSystemAction['payload']>['email_context']>;
}) {
  return (
    <div className="mt-3 rounded-md border border-border bg-surface-1 p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Email Context</div>
      <div className="text-sm font-medium text-text-primary">{context.source || 'Gmail context'}</div>
      {context.themes && context.themes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {context.themes.map((theme) => (
            <span key={theme} className="rounded-full bg-info/10 px-2 py-0.5 text-xs text-info">{theme}</span>
          ))}
        </div>
      )}
      {context.messages && context.messages.length > 0 && (
        <div className="mt-3 space-y-2">
          {context.messages.map((message, index) => (
            <article key={message.id || index} className="rounded-md border border-border bg-surface-2 p-3">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
                <span>{message.date ? dateLabel(message.date) : safeText(message.from)}</span>
                <span className="truncate">{message.subject}</span>
              </div>
              <p className="text-xs leading-5 text-text-secondary">{message.angle || message.context}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function SourcePostCards({
  posts,
}: {
  posts: NonNullable<NonNullable<LinkedInSystemAction['payload']>['source_posts']>;
}) {
  return (
    <div className="space-y-3">
      {posts.slice(0, 3).map((post, index) => (
        <article key={`${post.social_id || index}`} className="rounded-md border border-border bg-surface-2 p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-text-muted">{dateLabel(post.parsed_datetime)}</span>
            {post.share_url && <ExternalLinkAnchor href={post.share_url} />}
          </div>
          <p className="whitespace-pre-wrap text-xs leading-5 text-text-secondary">{safeText(post.text)}</p>
          <MediaPreviewGrid media={post.media} compact />
          {(post.media?.length ?? 0) === 0 && (
            <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
              <FileText className="h-3 w-3" />
              Text only
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

function SystemHealthPanel({ overview, loaded }: { overview: LinkedInSystemOverview | null; loaded: boolean }) {
  const account = overview?.account;
  const syncError = overview?.sync_error;
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Account And Agent</h2>
          <p className="mt-0.5 text-xs text-text-muted">{loaded ? safeText(account?.display_name || account?.unipile_account_id) : 'loading'}</p>
        </div>
        <StatusPill ok={Boolean(overview?.agent.running)} label={overview?.agent.running ? 'Running' : 'Pending'} />
      </div>
      <div className="grid gap-2 text-sm">
        <HealthRow icon={Linkedin} label="Account" value={safeText(account?.status)} />
        <HealthRow icon={ShieldCheck} label="Unipile ID" value={safeText(account?.unipile_account_id)} />
        <HealthRow icon={Clock3} label="Last account status" value={dateLabel(account?.last_status_at)} />
        <HealthRow icon={Activity} label="Worker heartbeat" value={dateLabel(overview?.agent.last_heartbeat_at)} />
        {syncError && <HealthRow icon={AlertTriangle} label="Sync note" value={syncError} warn />}
      </div>
    </section>
  );
}

function CustomGptBridgePanel() {
  const schemaUrl = typeof window === 'undefined'
    ? '/api/linkedin-system/gpt/openapi.json'
    : `${window.location.origin}/api/linkedin-system/gpt/openapi.json`;
  return (
    <section className="card p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Editorial Style Notes</h2>
          <p className="mt-0.5 text-xs text-text-muted">Roast-or-Toast structure for skimmable posts</p>
        </div>
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-info/15 text-info">
          <Bot className="h-4 w-4" />
        </span>
      </div>
      <div className="rounded-md border border-border bg-surface-2 p-3 text-sm leading-6 text-text-secondary">
        <p className="font-medium text-text-primary">Hook. Then make the hidden cost scannable.</p>
        <p className="mt-2">Use short lines, bullets, and a plain-language consequence before the lesson.</p>
      </div>
      <div className="mt-3 grid gap-2">
        {[
          'Build Breakdown',
          'Consultant Toolkit',
          'Client Delivery Mistakes',
          'AI in the Trenches',
          'Workflow Clinic',
        ].map((series) => (
          <div key={series} className="rounded-md bg-surface-2 px-3 py-2 text-xs font-medium text-text-secondary">
            {series}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-5 text-text-muted">
        Show the messy middle. The point is judgment: making consultants look good, documenting the work, and leaving the client better than you found them.
      </p>
      <div className="mt-3 rounded-md border border-border bg-surface-2 p-3">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Optional GPT Action Schema</div>
        <a href={schemaUrl} target="_blank" rel="noreferrer" className="break-all text-sm text-info hover:underline">
          {schemaUrl}
        </a>
      </div>
      <p className="mt-3 text-xs leading-5 text-text-muted">
        A Custom GPT can still use this bridge, but the LinkedIn Agent now applies the structure directly.
      </p>
    </section>
  );
}

function HealthRow({ icon: Icon, label, value, warn = false }: { icon: LucideIcon; label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-3 py-2">
      <span className="flex min-w-0 items-center gap-2 text-text-muted">
        <Icon className={`h-4 w-4 shrink-0 ${warn ? 'text-warning' : ''}`} />
        <span className="truncate">{label}</span>
      </span>
      <span className={`min-w-0 truncate text-right ${warn ? 'text-warning' : 'text-text-primary'}`}>{value}</span>
    </div>
  );
}

function mediaUrl(item: LinkedInSystemMedia): string {
  return String(item.preview_url || item.url || '').trim();
}

function MediaPreviewGrid({ media, compact = false }: { media?: LinkedInSystemMedia[] | null; compact?: boolean }) {
  const items = (media ?? []).filter((item) => mediaUrl(item));
  if (items.length === 0) return null;
  return (
    <div className={`mt-3 grid gap-2 ${compact ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}`}>
      {items.map((item, index) => {
        const url = mediaUrl(item);
        const label = item.file_name || item.type || 'media';
        if (item.type === 'image') {
          return (
            <a key={`${url}-${index}`} href={url} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-md border border-border bg-surface-1">
              <div className={compact ? 'aspect-video' : 'aspect-[16/10]'}>
                <img src={url} alt={label} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
              </div>
              {!compact && <MediaCaption icon={ImageIcon} label={label} />}
            </a>
          );
        }
        if (item.type === 'video') {
          return (
            <div key={`${url}-${index}`} className="overflow-hidden rounded-md border border-border bg-surface-1">
              <video src={url} controls preload="metadata" className={compact ? 'aspect-video w-full object-cover' : 'aspect-[16/10] w-full object-cover'} />
              {!compact && <MediaCaption icon={Video} label={label} />}
            </div>
          );
        }
        return (
          <a key={`${url}-${index}`} href={url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
            <Paperclip className="h-4 w-4 shrink-0" />
            <span className="truncate">{label}</span>
          </a>
        );
      })}
    </div>
  );
}

function MediaCaption({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-xs text-text-muted">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}

function ComposerMediaPreview({ media }: { media: LinkedInPostMedia }) {
  const source = String(media.dataBase64 || '').trim();
  if (!source) return null;
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-border bg-surface-1">
      {media.type === 'image' ? (
        <img src={source} alt={media.filename || 'selected media'} className="max-h-80 w-full object-contain" />
      ) : media.type === 'video' ? (
        <video src={source} controls preload="metadata" className="max-h-80 w-full" />
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-secondary">
          <Paperclip className="h-4 w-4" />
          <span className="truncate">{media.filename || 'Attachment selected'}</span>
        </div>
      )}
    </div>
  );
}

function RecentPosts({ posts }: { posts: LinkedInSystemPost[] }) {
  if (posts.length === 0) return <EmptyPanel label="No LinkedIn posts tracked yet." />;
  return (
    <div className="max-h-[520px] overflow-y-auto">
      {posts.map((post) => (
        <article key={`${post.source}-${post.id}`} className="border-b border-border px-4 py-3 last:border-b-0">
          <div className="mb-2 flex items-start justify-between gap-3">
            <span className="rounded-full bg-info/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-info">{post.source}</span>
            <span className="shrink-0 text-xs text-text-muted">{dateLabel(post.posted_at)}</span>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-6">{safeText(post.text)}</p>
          <MediaPreviewGrid media={post.media} compact />
          {(post.media?.length ?? 0) === 0 && (
            <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
              <FileText className="h-3 w-3" />
              Text only
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1"><ThumbsUp className="h-3.5 w-3.5" />{metric(post.reaction_counter)}</span>
            <span className="inline-flex items-center gap-1"><MessageSquare className="h-3.5 w-3.5" />{metric(post.comment_counter)}</span>
            <span className="inline-flex items-center gap-1"><Activity className="h-3.5 w-3.5" />{metric(post.impressions_counter)}</span>
            {post.share_url && <ExternalLinkAnchor href={post.share_url} />}
          </div>
        </article>
      ))}
    </div>
  );
}

function ConnectionList({ profiles }: { profiles: LinkedInSystemProfile[] }) {
  if (profiles.length === 0) return <EmptyPanel label="No LinkedIn connections tracked yet." />;
  return (
    <div className="max-h-[420px] overflow-y-auto">
      {profiles.map((profile) => (
        <article key={profile.id} className="border-b border-border px-4 py-3 last:border-b-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{safeText(profile.full_name)}</p>
              <p className="mt-1 truncate text-xs text-text-muted">{safeText(profile.headline || profile.current_company)}</p>
            </div>
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
              {profile.stage || 'found'}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-muted">
            <span>{profile.connected_at ? `Connected ${dateLabel(profile.connected_at)}` : `Found ${dateLabel(profile.first_seen_at)}`}</span>
            {(profile.public_profile_url || profile.profile_url) && <ExternalLinkAnchor href={profile.public_profile_url || profile.profile_url || '#'} />}
          </div>
        </article>
      ))}
    </div>
  );
}

function WebhookList({ webhooks }: { webhooks: LinkedInSystemWebhook[] }) {
  if (webhooks.length === 0) return <EmptyPanel label="No Unipile webhooks received yet." />;
  return (
    <div className="max-h-[420px] overflow-y-auto">
      {webhooks.map((hook) => (
        <article key={`${hook.source}-${hook.event_type}`} className="border-b border-border px-4 py-3 last:border-b-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{hook.event_type}</p>
              <p className="mt-1 truncate text-xs text-text-muted">{hook.source}</p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${hook.pending > 0 ? 'bg-warning/10 text-warning' : 'bg-success-muted text-success'}`}>
              {hook.pending > 0 ? `${hook.pending} pending` : 'clear'}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-text-muted">
            <span>{metric(hook.count)} received</span>
            <span>{dateLabel(hook.last_received_at)}</span>
          </div>
        </article>
      ))}
    </div>
  );
}

function ActionQueue({
  actions,
  busyId,
  onApprove,
  onCancel,
}: {
  actions: LinkedInSystemAction[];
  busyId: number | null;
  onApprove: (id: number) => Promise<void>;
  onCancel: (id: number) => Promise<void>;
}) {
  if (actions.length === 0) return <EmptyPanel label="No queued LinkedIn actions." />;
  return (
    <div className="max-h-[420px] overflow-y-auto">
      {actions.map((action) => (
        <article key={action.id} className="border-b border-border px-4 py-3 last:border-b-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{action.payload?.draft_title || action.payload?.profile_full_name || action.action_type}</p>
              <p className={`mt-1 text-xs leading-5 text-text-muted ${action.action_type === 'publish_post' ? 'max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-surface-2 p-2' : 'line-clamp-2'}`}>
                {action.payload?.text || action.last_error || action.action_type}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
              {action.status}
            </span>
          </div>
          <MediaPreviewGrid media={action.payload?.media} compact />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-text-muted">{action.executed_at ? `Sent ${dateLabel(action.executed_at)}` : `Next ${dateLabel(action.not_before)}`}</span>
            {action.status === 'needs_review' && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void onCancel(action.id)}
                  disabled={busyId === action.id}
                  className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void onApprove(action.id)}
                  disabled={busyId === action.id}
                  className="rounded-md bg-info px-2 py-1 text-xs font-medium text-white disabled:bg-surface-3 disabled:text-text-muted"
                >
                  Approve
                </button>
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function BudgetList({ budgets }: { budgets: LinkedInSystemBudget[] }) {
  if (budgets.length === 0) return <EmptyPanel label="No daily caps loaded." />;
  return (
    <div className="max-h-[420px] overflow-y-auto px-4 py-3">
      <div className="space-y-3">
        {budgets.map((budget) => {
          const pct = budget.cap > 0 ? Math.min(100, Math.round((budget.count / budget.cap) * 100)) : 0;
          return (
            <div key={budget.action_type}>
              <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-text-secondary">{budget.action_type.replace(/_/g, ' ')}</span>
                <span className="shrink-0 text-text-muted">{metric(budget.count)} / {metric(budget.cap)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-info" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExternalLinkAnchor({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-info hover:underline">
      <ExternalLink className="h-3.5 w-3.5" />
      Open
    </a>
  );
}

function EmptyPanel({ label }: { label: string }) {
  return <div className="px-4 py-10 text-center text-sm text-text-muted">{label}</div>;
}
