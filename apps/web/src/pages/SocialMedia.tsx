import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  ExternalLink,
  FileText,
  Heart,
  Image as ImageIcon,
  Instagram,
  Link as LinkIcon,
  Linkedin,
  MessageCircle,
  MessageSquare,
  Orbit,
  RefreshCcw,
  Send,
  ThumbsUp,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  linkedinApi,
  socialApi,
  whatsappApi,
  type LinkedInPost,
  type LinkedInPostMedia,
  type LinkedInStatus,
  type SocialData,
  type WhatsappContact,
  type WhatsappThread,
} from '../lib/api';

type Platform = 'linkedin' | 'facebook' | 'instagram' | 'whatsapp';
type ContentLens = 'win' | 'lesson' | 'loss' | 'behind' | 'proof';

const PLATFORM_META: Record<Platform, { label: string; color: string; icon: LucideIcon }> = {
  linkedin: { label: 'LinkedIn', color: '#0A66C2', icon: Linkedin },
  facebook: { label: 'Facebook', color: '#1877F2', icon: Orbit },
  instagram: { label: 'Instagram', color: '#D946EF', icon: Instagram },
  whatsapp: { label: 'WhatsApp', color: '#25D366', icon: MessageCircle },
};

const CONTENT_LENSES: Record<ContentLens, { label: string; prompt: string }> = {
  win: { label: 'Win', prompt: 'What worked, why it mattered, and who helped.' },
  lesson: { label: 'Lesson', prompt: 'What changed your mind or sharpened the process.' },
  loss: { label: 'Loss', prompt: 'What missed, what you learned, and what changes next.' },
  behind: { label: 'Behind the scenes', prompt: 'The ordinary work people rarely see.' },
  proof: { label: 'Proof', prompt: 'A result, with context and restraint.' },
};

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
  return typeof value === 'number' ? value.toLocaleString() : '-';
}

function FeedTime({ value }: { value?: string | null }) {
  if (!value) return null;
  return <span className="text-xs text-text-muted">{FMT_DATE.format(new Date(value))}</span>;
}

function StatusPill({ ready }: { ready: boolean }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${ready ? 'bg-success-muted text-success' : 'bg-surface-3 text-text-muted'}`}>
      {ready ? 'Ready' : 'Offline'}
    </span>
  );
}

export default function SocialMedia() {
  const [platform, setPlatform] = useState<Platform>('linkedin');
  const [linkedinStatus, setLinkedinStatus] = useState<LinkedInStatus | null>(null);
  const [linkedinPosts, setLinkedinPosts] = useState<LinkedInPost[]>([]);
  const [social, setSocial] = useState<SocialData | null>(null);
  const [threads, setThreads] = useState<WhatsappThread[]>([]);
  const [contacts, setContacts] = useState<WhatsappContact[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const [postText, setPostText] = useState('');
  const [postLink, setPostLink] = useState('');
  const [linkedinMedia, setLinkedinMedia] = useState<LinkedInPostMedia | null>(null);
  const [igImageUrl, setIgImageUrl] = useState('');
  const [waPhone, setWaPhone] = useState('');
  const [contentLens, setContentLens] = useState<ContentLens>('lesson');

  const load = useCallback(async () => {
    const [liStatus, liPosts, socialActivity, waThreads, waContacts] = await Promise.allSettled([
      linkedinApi.getStatus(),
      linkedinApi.listPosts(20),
      socialApi.getActivity(),
      whatsappApi.listThreads(),
      whatsappApi.listContacts(),
    ]);

    if (liStatus.status === 'fulfilled') setLinkedinStatus(liStatus.value);
    if (liPosts.status === 'fulfilled') setLinkedinPosts(liPosts.value.posts ?? []);
    if (socialActivity.status === 'fulfilled') setSocial(socialActivity.value);
    if (waThreads.status === 'fulfilled') setThreads(waThreads.value.threads ?? []);
    if (waContacts.status === 'fulfilled') setContacts(waContacts.value.contacts ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load().catch((err) => {
      setLoaded(true);
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'Social media data unavailable' });
    });
    const interval = setInterval(() => void load().catch(() => {}), 30_000);
    return () => clearInterval(interval);
  }, [load]);

  const fb = social?.facebook ?? null;
  const ig = social?.instagram ?? null;
  const unread = threads.reduce((sum, thread) => sum + (thread.unread_count ?? 0), 0);

  const platformReady: Record<Platform, boolean> = {
    linkedin: !!linkedinStatus?.connected,
    facebook: !!fb,
    instagram: !!ig,
    whatsapp: threads.length > 0 || contacts.length > 0,
  };

  const activeMeta = PLATFORM_META[platform];
  const ActiveIcon = activeMeta.icon;

  const canSend = useMemo(() => {
    if (busy) return false;
    if (platform === 'linkedin') return !!linkedinStatus?.connected && (!!postText.trim() || !!linkedinMedia);
    if (platform === 'facebook') return !!fb && !!postText.trim();
    if (platform === 'instagram') return !!ig && !!igImageUrl.trim();
    return !!waPhone.trim() && !!postText.trim();
  }, [busy, fb, ig, igImageUrl, linkedinMedia, linkedinStatus?.connected, platform, postText, waPhone]);

  async function pickLinkedInFile(file: File | null) {
    if (!file) {
      setLinkedinMedia(null);
      return;
    }
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
    setLinkedinMedia({ type: mediaTypeFor(file), filename: file.name, dataBase64 });
  }

  async function submit() {
    if (!canSend) return;
    setBusy(true);
    setNotice(null);
    try {
      if (platform === 'linkedin') {
        await linkedinApi.publishPost({
          text: postText.trim(),
          ...(postLink.trim() ? { link: postLink.trim() } : {}),
          ...(linkedinMedia ? { media: linkedinMedia } : {}),
        });
        setNotice({ kind: 'ok', text: 'Posted to LinkedIn.' });
      } else if (platform === 'facebook') {
        await socialApi.publishFacebook({
          message: postText.trim(),
          ...(postLink.trim() ? { link: postLink.trim() } : {}),
        });
        setNotice({ kind: 'ok', text: 'Posted to Facebook.' });
      } else if (platform === 'instagram') {
        await socialApi.publishInstagram({
          imageUrl: igImageUrl.trim(),
          ...(postText.trim() ? { caption: postText.trim() } : {}),
        });
        setNotice({ kind: 'ok', text: 'Posted to Instagram.' });
      } else {
        await whatsappApi.startConversation(waPhone.trim(), postText.trim());
        setNotice({ kind: 'ok', text: 'WhatsApp message sent.' });
      }
      setPostText('');
      setPostLink('');
      setIgImageUrl('');
      setWaPhone('');
      setLinkedinMedia(null);
      await load();
    } catch (err) {
      setNotice({ kind: 'warn', text: err instanceof Error ? err.message : 'Send failed' });
    } finally {
      setBusy(false);
    }
  }

  function shapeDraft() {
    const raw = postText.trim();
    const seed = raw || '[drop the raw note, win, miss, or observation here]';
    const drafts: Record<ContentLens, string> = {
      win: `A small win from today:\n\n${seed}\n\nWhat made it work:\n- [specific condition, person, or decision]\n\nWhy I am sharing it:\n[useful takeaway without turning it into a victory lap]\n\nWhat is a quiet win you have seen lately?`,
      lesson: `Something I am learning:\n\n${seed}\n\nThe shift:\n[what changed in how you think or work]\n\nThe practical takeaway:\n[one thing someone else could try]\n\nCurious where this shows up for others.`,
      loss: `This did not land the way I wanted:\n\n${seed}\n\nWhat I missed:\n[be concrete, not dramatic]\n\nWhat changes now:\n[the adjustment]\n\nThere is a lot of useful signal in the misses if we are willing to look at them.`,
      behind: `A behind-the-scenes note from today:\n\n${seed}\n\nThe part that is easy to overlook:\n[ordinary detail that made the work better]\n\nWhy it matters:\n[human/business relevance]\n\nMost progress looks boring while it is happening.`,
      proof: `A real signal from the work:\n\n${seed}\n\nContext:\n[what made this hard or meaningful]\n\nWhat I would take from it:\n[measured lesson, no hype]\n\nProof is more useful when it comes with the messy middle.`,
    };
    setPostText(drafts[contentLens]);
  }

  return (
    <div className="aios-page aios-page-pad h-full overflow-auto text-text-primary">
      <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="vs-mono text-[11px] uppercase tracking-[0.22em] text-text-muted">Command center</div>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
            <BarChart3 className="h-6 w-6 text-info" />
            Social Media
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            {loaded ? `${linkedinPosts.length} LinkedIn posts, ${threads.length} WhatsApp threads` : 'Loading live channels...'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex w-fit items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
        >
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </button>
      </header>

      <section className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard platform="linkedin" title="LinkedIn" ready={platformReady.linkedin} value={linkedinStatus?.connected ? 'Connected' : 'Not connected'} detail={`${linkedinPosts.length} BOS posts`} />
        <MetricCard platform="facebook" title="Facebook" ready={platformReady.facebook} value={fb ? metric(fb.followers) : '-'} detail={fb ? `${metric(fb.totals.reactions)} reactions, ${metric(fb.totals.comments)} comments` : 'No Page data'} />
        <MetricCard platform="instagram" title="Instagram" ready={platformReady.instagram} value={ig ? metric(ig.followers) : '-'} detail={ig ? `${metric(ig.totals.likes)} likes, ${metric(ig.totals.comments)} comments` : 'No IG data'} />
        <MetricCard platform="whatsapp" title="WhatsApp" ready={platformReady.whatsapp} value={String(threads.length)} detail={`${contacts.length} contacts, ${unread} unread`} />
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(360px,1.05fr)]">
        <section className="card p-4">
          <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {(Object.keys(PLATFORM_META) as Platform[]).map((id) => {
              const meta = PLATFORM_META[id];
              const Icon = meta.icon;
              const active = platform === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setPlatform(id);
                    setNotice(null);
                  }}
                  className="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors"
                  style={{
                    borderColor: active ? meta.color : 'var(--color-border, rgb(43 51 76))',
                    background: active ? `${meta.color}18` : 'var(--color-surface-2, rgba(255,255,255,0.03))',
                    color: active ? meta.color : 'inherit',
                  }}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                  <span className={`h-2 w-2 rounded-full ${platformReady[id] ? 'bg-success' : 'bg-surface-3'}`} />
                </button>
              );
            })}
          </div>

          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <ActiveIcon className="h-5 w-5" />
              <h2 className="text-sm font-semibold">{activeMeta.label}</h2>
            </div>
            <StatusPill ready={platformReady[platform]} />
          </div>

          {platform === 'whatsapp' && (
            <input
              value={waPhone}
              onChange={(e) => setWaPhone(e.target.value)}
              placeholder="Phone number"
              className="mb-3 w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-success focus:outline-none"
            />
          )}

          {platform === 'instagram' && (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
              <ImageIcon className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                value={igImageUrl}
                onChange={(e) => setIgImageUrl(e.target.value)}
                placeholder="Image URL"
                className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder-text-muted outline-none"
              />
            </div>
          )}

          {platform !== 'whatsapp' && (
            <div className="mb-3 rounded-md border border-border bg-surface-1 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-text-primary">Post angle</div>
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
          )}

          <textarea
            value={postText}
            onChange={(e) => setPostText(e.target.value)}
            rows={9}
            maxLength={platform === 'whatsapp' ? 4000 : 3000}
            placeholder={platform === 'whatsapp' ? 'Message' : platform === 'instagram' ? 'Caption' : 'Post text'}
            className="w-full resize-none rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder-text-muted focus:border-info focus:outline-none"
          />

          {(platform === 'linkedin' || platform === 'facebook') && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
              <LinkIcon className="h-4 w-4 shrink-0 text-text-muted" />
              <input
                value={postLink}
                onChange={(e) => setPostLink(e.target.value)}
                placeholder="Optional link"
                className="min-w-0 flex-1 bg-transparent text-sm text-text-primary placeholder-text-muted outline-none"
              />
            </div>
          )}

          {platform === 'linkedin' && (
            <label className="mt-3 inline-flex max-w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm text-text-secondary hover:text-text-primary">
              <input
                type="file"
                accept="image/*,video/*,.pdf,.doc,.docx,.ppt,.pptx"
                className="hidden"
                onChange={(e) => void pickLinkedInFile(e.target.files?.[0] ?? null)}
              />
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">{linkedinMedia ? linkedinMedia.filename : 'Attachment'}</span>
            </label>
          )}

          {notice && (
            <div className={`mt-3 rounded-md border px-3 py-2 text-sm ${notice.kind === 'ok' ? 'border-success/40 bg-success-muted text-success' : 'border-warning/40 bg-warning/10 text-warning'}`}>
              {notice.text}
            </div>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="vs-mono text-[10px] text-text-muted">{postText.length}/{platform === 'whatsapp' ? '4000' : '3000'}</span>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSend}
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white disabled:bg-surface-3 disabled:text-text-muted"
              style={{ background: canSend ? activeMeta.color : undefined }}
            >
              <Send className="h-4 w-4" />
              {busy ? 'Sending...' : platform === 'whatsapp' ? 'Send message' : 'Post'}
            </button>
          </div>
        </section>

        <section className="card overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Analytics and Engagement</h2>
              <p className="mt-0.5 text-xs text-text-muted">{PLATFORM_META[platform].label}</p>
            </div>
            <StatusPill ready={platformReady[platform]} />
          </div>
          <div className="max-h-[680px] overflow-y-auto">
            <EngagementFeed
              platform={platform}
              linkedinPosts={linkedinPosts}
              social={social}
              threads={threads}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricCard({ platform, title, ready, value, detail }: { platform: Platform; title: string; ready: boolean; value: string; detail: string }) {
  const meta = PLATFORM_META[platform];
  const Icon = meta.icon;
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: `${meta.color}18`, color: meta.color }}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{title}</div>
            <div className="truncate text-xs text-text-muted">{detail}</div>
          </div>
        </div>
        <StatusPill ready={ready} />
      </div>
      <div className="mt-3 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function EngagementFeed({
  platform,
  linkedinPosts,
  social,
  threads,
}: {
  platform: Platform;
  linkedinPosts: LinkedInPost[];
  social: SocialData | null;
  threads: WhatsappThread[];
}) {
  if (platform === 'linkedin') {
    return linkedinPosts.length === 0 ? (
      <EmptyFeed label="No LinkedIn posts yet." />
    ) : (
      <div>
        {linkedinPosts.map((post) => (
          <article key={post.id} className="border-b border-border px-4 py-3 last:border-b-0">
            <p className="whitespace-pre-wrap text-sm leading-6">{post.text}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-muted">
              <FeedTime value={post.posted_at} />
              {post.media_kind && post.media_kind !== 'text' && <span>{post.media_kind}</span>}
              {post.viewUrl && <ExternalLinkAnchor href={post.viewUrl} />}
            </div>
          </article>
        ))}
      </div>
    );
  }

  if (platform === 'facebook') {
    const posts = social?.facebook?.posts ?? [];
    return posts.length === 0 ? (
      <EmptyFeed label="No Facebook activity yet." />
    ) : (
      <div>
        {posts.map((post) => (
          <article key={post.id} className="border-b border-border px-4 py-3 last:border-b-0">
            <p className="whitespace-pre-wrap text-sm leading-6">{post.message || post.story || '(no text)'}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-muted">
              <FeedTime value={post.created_time} />
              <span className="inline-flex items-center gap-1"><ThumbsUp className="h-3.5 w-3.5" />{metric(post.reactions)}</span>
              <span className="inline-flex items-center gap-1"><MessageSquare className="h-3.5 w-3.5" />{metric(post.comments_count)}</span>
              {post.permalink_url && <ExternalLinkAnchor href={post.permalink_url} />}
            </div>
            {post.comments.length > 0 && (
              <div className="mt-2 space-y-1">
                {post.comments.slice(0, 3).map((comment, index) => (
                  <p key={`${post.id}-${index}`} className="truncate text-xs text-text-muted">
                    <span className="font-medium text-text-secondary">{comment.from}</span>: {comment.message}
                  </p>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    );
  }

  if (platform === 'instagram') {
    const media = social?.instagram?.media ?? [];
    return media.length === 0 ? (
      <EmptyFeed label="No Instagram media yet." />
    ) : (
      <div>
        {media.map((item) => (
          <article key={item.id} className="border-b border-border px-4 py-3 last:border-b-0">
            <p className="whitespace-pre-wrap text-sm leading-6">{item.caption || '(no caption)'}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-muted">
              <FeedTime value={item.timestamp} />
              <span className="inline-flex items-center gap-1"><Heart className="h-3.5 w-3.5" />{metric(item.like_count)}</span>
              <span className="inline-flex items-center gap-1"><MessageSquare className="h-3.5 w-3.5" />{metric(item.comments_count)}</span>
              {item.permalink && <ExternalLinkAnchor href={item.permalink} />}
            </div>
            {item.comments.length > 0 && (
              <div className="mt-2 space-y-1">
                {item.comments.slice(0, 3).map((comment, index) => (
                  <p key={`${item.id}-${index}`} className="truncate text-xs text-text-muted">
                    <span className="font-medium text-text-secondary">@{comment.username}</span>: {comment.text}
                  </p>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    );
  }

  return threads.length === 0 ? (
    <EmptyFeed label="No WhatsApp threads yet." />
  ) : (
    <div>
      {threads.slice(0, 30).map((thread) => (
        <article key={thread.chat_id} className="border-b border-border px-4 py-3 last:border-b-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{thread.display_name || thread.phone || thread.chat_id}</p>
              <p className="mt-1 truncate text-xs text-text-muted">{thread.last_message_preview || '(no preview)'}</p>
            </div>
            {thread.unread_count > 0 && (
              <span className="rounded-full bg-success px-2 py-0.5 text-xs font-semibold text-white">{thread.unread_count}</span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3 text-xs text-text-muted">
            <FeedTime value={thread.last_message_at} />
            <span className="inline-flex items-center gap-1"><Users className="h-3.5 w-3.5" />{thread.is_group ? 'Group' : 'Direct'}</span>
          </div>
        </article>
      ))}
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

function EmptyFeed({ label }: { label: string }) {
  return <div className="px-4 py-10 text-center text-sm text-text-muted">{label}</div>;
}
