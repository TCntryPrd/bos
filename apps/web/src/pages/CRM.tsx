/**
 * CRM - receptionist workstation for Katalyst/Keap data.
 *
 * The page replaces the Katalyst iframe with a custom, API-backed desk view:
 * a phone-like search surface on the left and a monitor with contact/tag
 * results on the right.
 */

import React, { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useTilesLocked } from '../lib/tileLock';
import {
  CheckCircle2,
  ContactRound,
  ExternalLink,
  Eye,
  ListChecks,
  Loader2,
  Mic2,
  Monitor,
  Move,
  Phone,
  RefreshCw,
  Search,
  Tags,
  Users,
} from 'lucide-react';

interface CrmContact {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  tags: string[];
  source?: string | null;
  dateAdded?: string | null;
  syncedAt?: string | null;
  profileUrl: string;
  provider: string;
}

interface CrmOpportunity {
  id: string;
  name?: string | null;
  stage?: string | null;
  value?: number | null;
  status?: string | null;
  updatedAt?: string | null;
}

interface CrmSearchResponse {
  mode: 'search' | 'tag';
  query: string;
  tag: string | null;
  contacts: CrmContact[];
}

interface CrmStatus {
  provider: string;
  contacts: number;
  tagged: number;
  lastSync: string | null;
  connections: {
    katalyst: boolean;
    keap: boolean;
  };
}

interface CrmTag {
  tag: string;
  count: number;
}

interface CrmContactDetail {
  contact: CrmContact;
  opportunities: CrmOpportunity[];
}

interface ActionPreview {
  selectedCount: number;
  action: string;
  tag: string | null;
  message: string;
}

const KEAP_URL = 'https://app.keap.com';
const DEFAULT_ACTION = 'start callback queue';
const TILE_STORAGE_KEY = 'vasari.crm.reception.tiles.v1';
const PAGE_LEFT_EDGE = 212;
const PAGE_PADDING = 12;
const PAGE_TOP_PADDING = 48;

type TileId = 'phone' | 'monitor';
type ResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface TileLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TileInteraction {
  tile: TileId;
  mode: 'move' | 'resize';
  edge?: ResizeEdge;
  pointerId: number;
  startX: number;
  startY: number;
  start: TileLayout;
}

const RESIZE_EDGES: ResizeEdge[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];
const TILE_LIMITS: Record<TileId, { minWidth: number; minHeight: number }> = {
  phone: { minWidth: 250, minHeight: 440 },
  monitor: { minWidth: 500, minHeight: 420 },
};

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function viewportSize() {
  if (typeof window === 'undefined') return { vw: 1440, vh: 900 };
  return { vw: window.innerWidth, vh: window.innerHeight };
}

function desktopLeftEdge(vw: number): number {
  return vw > 900 ? PAGE_LEFT_EDGE : PAGE_PADDING;
}

function clampTileLayout(tile: TileId, layout: TileLayout): TileLayout {
  const { vw, vh } = viewportSize();
  const limits = TILE_LIMITS[tile];
  const leftEdge = desktopLeftEdge(vw);
  const width = clamp(layout.width, limits.minWidth, Math.max(limits.minWidth, vw - leftEdge - PAGE_PADDING));
  const height = clamp(layout.height, limits.minHeight, Math.max(limits.minHeight, vh - PAGE_TOP_PADDING - PAGE_PADDING));
  return {
    x: Math.round(clamp(layout.x, leftEdge, Math.max(leftEdge, vw - width - PAGE_PADDING))),
    y: Math.round(clamp(layout.y, PAGE_TOP_PADDING, Math.max(PAGE_TOP_PADDING, vh - height - PAGE_PADDING))),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function defaultTileLayouts(): Record<TileId, TileLayout> {
  const { vw, vh } = viewportSize();
  return {
    phone: clampTileLayout('phone', {
      x: vw - 332,
      y: 124,
      width: 250,
      height: 610,
    }),
    monitor: clampTileLayout('monitor', {
      x: 238,
      y: 72,
      width: 682,
      height: Math.min(680, Math.max(620, vh - 232)),
    }),
  };
}

function isTileLayout(value: unknown): value is TileLayout {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TileLayout>;
  return [item.x, item.y, item.width, item.height].every((part) => typeof part === 'number' && Number.isFinite(part));
}

function readTileLayouts(): Record<TileId, TileLayout> {
  const fallback = defaultTileLayouts();
  if (typeof window === 'undefined') return fallback;
  try {
    const saved = JSON.parse(localStorage.getItem(TILE_STORAGE_KEY) || '{}') as Partial<Record<TileId, TileLayout>>;
    return {
      phone: clampTileLayout('phone', isTileLayout(saved.phone) ? saved.phone : fallback.phone),
      monitor: clampTileLayout('monitor', isTileLayout(saved.monitor) ? saved.monitor : fallback.monitor),
    };
  } catch {
    return fallback;
  }
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('boss_token') ?? '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 180)}`);
  }
  return res.json();
}

function formatDate(value?: string | null): string {
  if (!value) return 'not synced';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'not synced';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'C';
}

export default function CRM() {
  const interactionRef = useRef<TileInteraction | null>(null);
  const [query, setQuery] = useState('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [selectedContact, setSelectedContact] = useState<CrmContact | null>(null);
  const [detail, setDetail] = useState<CrmContactDetail | null>(null);
  const [tags, setTags] = useState<CrmTag[]>([]);
  const [status, setStatus] = useState<CrmStatus | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionPreview, setActionPreview] = useState<ActionPreview | null>(null);
  const [tileLayouts, setTileLayouts] = useState<Record<TileId, TileLayout>>(readTileLayouts);
  const [isCompactLayout, setIsCompactLayout] = useState(() => (
    typeof window !== 'undefined' && window.innerWidth <= 900
  ));
  const [activeTile, setActiveTile] = useState<TileId | null>(null);

  const selectedCount = selectedIds.size;
  const monitorMode = activeTag ? 'tag' : selectedContact ? 'contact' : 'search';

  const selectedRows = useMemo(
    () => contacts.filter((contact) => selectedIds.has(contact.id)),
    [contacts, selectedIds],
  );

  const loadStatus = async () => {
    const [statusData, tagData] = await Promise.all([
      api<CrmStatus>('api/crm/status'),
      api<{ tags: CrmTag[] }>('api/crm/tags?limit=18'),
    ]);
    setStatus(statusData);
    setTags(tagData.tags);
  };

  const searchContacts = async (nextQuery = query, nextTag = activeTag) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (nextQuery.trim()) params.set('q', nextQuery.trim());
      if (nextTag) params.set('tag', nextTag);
      params.set('limit', nextTag ? '80' : '36');
      const data = await api<CrmSearchResponse>(`api/crm/search?${params.toString()}`);
      setContacts(data.contacts);
      setSelectedIds(new Set());
      setActionPreview(null);
      setSelectedContact((current) => (
        current && data.contacts.some((contact) => contact.id === current.id)
          ? current
          : data.contacts[0] ?? null
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadContact = async (contact: CrmContact) => {
    setSelectedContact(contact);
    setDetailLoading(true);
    setError(null);
    try {
      const data = await api<CrmContactDetail>(`api/crm/contact/${encodeURIComponent(contact.id)}`);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDetail({ contact, opportunities: [] });
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        await loadStatus();
        await searchContacts('', null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncViewport = () => {
      setIsCompactLayout(window.innerWidth <= 900);
      setTileLayouts((current) => ({
        phone: clampTileLayout('phone', current.phone),
        monitor: clampTileLayout('monitor', current.monitor),
      }));
    };
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(TILE_STORAGE_KEY, JSON.stringify(tileLayouts));
    } catch {
      // Saved placement is a convenience; the CRM still works without browser storage.
    }
  }, [tileLayouts]);

  useEffect(() => {
    const updateTile = (event: PointerEvent) => {
      const active = interactionRef.current;
      if (!active) return;
      event.preventDefault();
      const dx = event.clientX - active.startX;
      const dy = event.clientY - active.startY;
      const next = { ...active.start };

      if (active.mode === 'move') {
        next.x = active.start.x + dx;
        next.y = active.start.y + dy;
      } else if (active.edge) {
        const limits = TILE_LIMITS[active.tile];
        if (active.edge.includes('e')) next.width = active.start.width + dx;
        if (active.edge.includes('s')) next.height = active.start.height + dy;
        if (active.edge.includes('w')) {
          next.width = Math.max(limits.minWidth, active.start.width - dx);
          next.x = active.start.x + (active.start.width - next.width);
        }
        if (active.edge.includes('n')) {
          next.height = Math.max(limits.minHeight, active.start.height - dy);
          next.y = active.start.y + (active.start.height - next.height);
        }
      }

      setTileLayouts((current) => ({
        ...current,
        [active.tile]: clampTileLayout(active.tile, next),
      }));
    };

    const stopTileUpdate = (event: PointerEvent) => {
      const active = interactionRef.current;
      if (!active) return;
      const target = event.target as HTMLElement | null;
      try {
        target?.releasePointerCapture?.(active.pointerId);
      } catch {
        // The browser may already have released capture when the pointer leaves the handle.
      }
      interactionRef.current = null;
      setActiveTile(null);
    };

    window.addEventListener('pointermove', updateTile);
    window.addEventListener('pointerup', stopTileUpdate);
    window.addEventListener('pointercancel', stopTileUpdate);
    return () => {
      window.removeEventListener('pointermove', updateTile);
      window.removeEventListener('pointerup', stopTileUpdate);
      window.removeEventListener('pointercancel', stopTileUpdate);
    };
  }, []);

  useEffect(() => {
    if (!selectedContact) {
      setDetail(null);
      return;
    }
    void loadContact(selectedContact);
  }, [selectedContact?.id]);

  const applySearch = () => {
    setActiveTag(null);
    void searchContacts(query, null);
  };

  const useTag = (tag: string) => {
    setActiveTag(tag);
    setQuery(tag);
    setSelectedContact(null);
    void searchContacts('', tag);
  };

  const clearDesk = () => {
    setQuery('');
    setActiveTag(null);
    setSelectedContact(null);
    setSelectedIds(new Set());
    setActionPreview(null);
    void searchContacts('', null);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds((current) => (
      current.size === contacts.length
        ? new Set()
        : new Set(contacts.map((contact) => contact.id))
    ));
  };

  const stageAction = async (action = DEFAULT_ACTION) => {
    const payload = {
      action,
      tag: activeTag,
      contactIds: selectedRows.map((contact) => contact.id),
    };
    const data = await api<ActionPreview>('api/crm/action-preview', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    setActionPreview(data);
  };

  const activeDetail = detail?.contact ?? selectedContact;

  const beginMove = (tile: TileId) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (isCompactLayout) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    interactionRef.current = {
      tile,
      mode: 'move',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start: tileLayouts[tile],
    };
    setActiveTile(tile);
  };

  const beginResize = (tile: TileId, edge: ResizeEdge) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (isCompactLayout) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    interactionRef.current = {
      tile,
      mode: 'resize',
      edge,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      start: tileLayouts[tile],
    };
    setActiveTile(tile);
  };

  const tileStyle = (tile: TileId): CSSProperties | undefined => {
    if (isCompactLayout) return undefined;
    const layout = tileLayouts[tile];
    return {
      left: layout.x,
      top: layout.y,
      width: layout.width,
      height: layout.height,
      right: 'auto',
      bottom: 'auto',
    };
  };

  const crmTilesLocked = useTilesLocked();
  const resizeHandles = (tile: TileId) => crmTilesLocked ? null : RESIZE_EDGES.map((edge) => (
    <button
      key={edge}
      type="button"
      className={`crm-resize-handle is-${edge}`}
      aria-label={`Resize ${tile}`}
      title={`Resize ${tile}`}
      onPointerDown={beginResize(tile, edge)}
    />
  ));

  return (
    <div className="crm-reception-page" aria-label="Reception CRM desk">
      <div className="crm-reception-skyline" aria-hidden />
      <div className="crm-reception-elevators" aria-hidden>
        <span />
        <span />
        <span />
      </div>

      <section
        className={activeTile === 'phone' ? 'crm-phone-console is-adjusting' : 'crm-phone-console'}
        style={tileStyle('phone')}
        aria-label="CRM phone search"
      >
        {!crmTilesLocked && (
        <button
          type="button"
          className="crm-tile-move-handle"
          aria-label="Move phone"
          title="Move phone"
          onPointerDown={beginMove('phone')}
        >
          <Move className="h-4 w-4" />
        </button>
        )}
        {resizeHandles('phone')}
        <div className="crm-phone-speaker" aria-hidden />
        <div className="crm-phone-screen">
          <div className="crm-phone-status">
            <Phone className="h-4 w-4" />
            <span>Reception</span>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          </div>
          <label className="sr-only" htmlFor="crm-search">Search contacts or tags</label>
          <div className="crm-search-box">
            <Search className="h-5 w-5" />
            <input
              id="crm-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applySearch();
              }}
              placeholder="Name, phone, company, tag"
            />
          </div>
          <div className="crm-phone-actions">
            <button type="button" onClick={applySearch}>
              <Search className="h-4 w-4" />
              Search
            </button>
            <button type="button" onClick={clearDesk}>
              <RefreshCw className="h-4 w-4" />
              Clear
            </button>
            <button type="button" className="is-voice">
              <Mic2 className="h-4 w-4" />
              Talk
            </button>
          </div>
          <div className="crm-connection-strip">
            <span className={status?.connections.katalyst ? 'is-live' : ''}>Katalyst</span>
            <span className={status?.connections.keap ? 'is-live' : ''}>Keap</span>
          </div>
          <div className="crm-phone-metrics">
            <div>
              <strong>{status?.contacts ?? contacts.length}</strong>
              <span>contacts</span>
            </div>
            <div>
              <strong>{status?.tagged ?? 0}</strong>
              <span>tagged</span>
            </div>
          </div>
          <div className="crm-quick-tags" aria-label="Top tags">
            {tags.slice(0, 10).map((item) => (
              <button key={item.tag} type="button" onClick={() => useTag(item.tag)}>
                <Tags className="h-3.5 w-3.5" />
                <span>{item.tag}</span>
                <small>{item.count}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="crm-phone-base" aria-hidden />
      </section>

      <section
        className={activeTile === 'monitor' ? 'crm-monitor-station is-adjusting' : 'crm-monitor-station'}
        style={tileStyle('monitor')}
        aria-label="CRM contact monitor"
      >
        {!crmTilesLocked && (
        <button
          type="button"
          className="crm-tile-move-handle"
          aria-label="Move monitor"
          title="Move monitor"
          onPointerDown={beginMove('monitor')}
        >
          <Move className="h-4 w-4" />
        </button>
        )}
        {resizeHandles('monitor')}
        <div className="crm-monitor">
          <div className="crm-monitor-topbar">
            <div>
              <div className="vs-mono crm-monitor-kicker">CRM MONITOR / {monitorMode.toUpperCase()}</div>
              <h1>{activeTag ? `Tag: ${activeTag}` : activeDetail?.name ?? 'Reception queue'}</h1>
            </div>
            <div className="crm-monitor-status">
              <Monitor className="h-4 w-4" />
              <span>{formatDate(status?.lastSync)}</span>
            </div>
          </div>

          {error && <div className="crm-monitor-error">{error}</div>}

          {activeTag ? (
            <div className="crm-tag-results">
              <div className="crm-tag-toolbar">
                <button type="button" onClick={selectAll}>
                  <ListChecks className="h-4 w-4" />
                  {selectedCount === contacts.length && contacts.length > 0 ? 'Clear all' : 'Select all'}
                </button>
                <button type="button" disabled={selectedCount === 0} onClick={() => void stageAction()}>
                  <Users className="h-4 w-4" />
                  Action
                </button>
                <span>{selectedCount} selected</span>
              </div>
              <div className="crm-result-list">
                {contacts.map((contact) => (
                  <button
                    key={contact.id}
                    type="button"
                    className={selectedIds.has(contact.id) ? 'crm-result-row is-selected' : 'crm-result-row'}
                    onClick={() => toggleSelected(contact.id)}
                  >
                    <span className="crm-contact-avatar">{initials(contact.name)}</span>
                    <span className="crm-result-main">
                      <strong>{contact.name}</strong>
                      <small>{contact.company || contact.email || contact.phone || 'No contact detail'}</small>
                    </span>
                    {selectedIds.has(contact.id) && <CheckCircle2 className="h-4 w-4" />}
                  </button>
                ))}
              </div>
              {actionPreview && (
                <div className="crm-action-preview">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>{actionPreview.message}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="crm-contact-workspace">
              <aside className="crm-contact-queue" aria-label="Contact results">
                {loading ? (
                  <div className="crm-contact-loading">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Searching CRM
                  </div>
                ) : contacts.length === 0 ? (
                  <div className="crm-contact-loading">No contacts found</div>
                ) : (
                  contacts.map((contact) => (
                    <button
                      key={contact.id}
                      type="button"
                      className={contact.id === activeDetail?.id ? 'crm-contact-card is-active' : 'crm-contact-card'}
                      onClick={() => setSelectedContact(contact)}
                    >
                      <span className="crm-contact-avatar">{initials(contact.name)}</span>
                      <span>
                        <strong>{contact.name}</strong>
                        <small>{contact.company || contact.email || contact.phone || 'Katalyst contact'}</small>
                      </span>
                    </button>
                  ))
                )}
              </aside>

              <main className="crm-contact-file" aria-label="Selected contact file">
                {activeDetail ? (
                  <>
                    <div className="crm-file-header">
                      <span className="crm-contact-avatar is-large">{initials(activeDetail.name)}</span>
                      <div>
                        <h2>{activeDetail.name}</h2>
                        <p>{activeDetail.company || activeDetail.source || 'Katalyst contact'}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => window.open(activeDetail.profileUrl, '_blank', 'noopener,noreferrer')}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Edit
                      </button>
                    </div>
                    <div className="crm-contact-fields">
                      <div><span>Email</span><strong>{activeDetail.email || 'missing'}</strong></div>
                      <div><span>Phone</span><strong>{activeDetail.phone || 'missing'}</strong></div>
                      <div><span>Source</span><strong>{activeDetail.source || 'unknown'}</strong></div>
                      <div><span>Synced</span><strong>{formatDate(activeDetail.syncedAt)}</strong></div>
                    </div>
                    <div className="crm-contact-tags">
                      {activeDetail.tags.length ? activeDetail.tags.map((tag) => (
                        <button key={tag} type="button" onClick={() => useTag(tag)}>{tag}</button>
                      )) : <span>No tags</span>}
                    </div>
                    <div className="crm-opportunity-panel">
                      <div className="crm-section-title">
                        <ContactRound className="h-4 w-4" />
                        <span>{detailLoading ? 'Loading profile' : 'Related opportunities'}</span>
                      </div>
                      {detail?.opportunities.length ? detail.opportunities.map((opportunity) => (
                        <div key={opportunity.id} className="crm-opportunity-row">
                          <strong>{opportunity.name || 'Opportunity'}</strong>
                          <span>{opportunity.stage || opportunity.status || 'No stage'}</span>
                          <small>{opportunity.value ? `$${Math.round(opportunity.value).toLocaleString()}` : '$0'}</small>
                        </div>
                      )) : (
                        <p className="crm-empty-note">No mirrored opportunities for this contact yet.</p>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="crm-empty-monitor">
                    <Eye className="h-8 w-8" />
                    <span>Search on the phone or tap a tag to fill the monitor.</span>
                  </div>
                )}
              </main>
            </div>
          )}
        </div>
        <div className="crm-monitor-stand" aria-hidden />
      </section>

      <div className="crm-desk-edge" aria-hidden />
      <a className="crm-keap-dock" href={KEAP_URL} target="_blank" rel="noopener noreferrer">
        <ExternalLink className="h-4 w-4" />
        Keap
      </a>
    </div>
  );
}
