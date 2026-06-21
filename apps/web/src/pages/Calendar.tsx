/**
 * Calendar — aggregated Google Calendar view across all connected accounts.
 *
 * Features:
 *   - Month / Week / Day view toggle (default: week)
 *   - Account filter with color coding
 *   - Navigation: previous / next / today
 *   - Event popup on click
 *   - Pure CSS grid — no external calendar library
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Calendar as CalendarIcon,
  Filter,
  X,
  MapPin,
  Clock,
  ExternalLink,
  User,
} from 'lucide-react';
import { cn } from '../lib/utils';

// ── Types ────────────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  account: string;
  calendarName: string;
  calendarId: string;
  htmlLink: string | null;
  colorId: string | null;
}

interface AccountInfo {
  email: string;
  calendars: { id: string; summary: string; primary: boolean }[];
}

type ViewMode = 'month' | 'week' | 'day';

// ── Account color mapping ────────────────────────────────────────────────────

const ACCOUNT_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  'kevin@starrpartners.ai':           { bg: 'bg-blue-500/15', border: 'border-blue-500/40', text: 'text-blue-300', dot: 'bg-blue-500' },
  'd.caine@dcaine.com':               { bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', text: 'text-emerald-300', dot: 'bg-emerald-500' },
  'kevinstarr@industryrockstar.com':  { bg: 'bg-purple-500/15', border: 'border-purple-500/40', text: 'text-purple-300', dot: 'bg-purple-500' },
  'travelcraft.dc@gmail.com':         { bg: 'bg-orange-500/15', border: 'border-orange-500/40', text: 'text-orange-300', dot: 'bg-orange-500' },
  'absoluterecoverybureau@gmail.com': { bg: 'bg-red-500/15', border: 'border-red-500/40', text: 'text-red-300', dot: 'bg-red-500' },
};

const FALLBACK_COLORS = [
  { bg: 'bg-cyan-500/15', border: 'border-cyan-500/40', text: 'text-cyan-300', dot: 'bg-cyan-500' },
  { bg: 'bg-pink-500/15', border: 'border-pink-500/40', text: 'text-pink-300', dot: 'bg-pink-500' },
  { bg: 'bg-yellow-500/15', border: 'border-yellow-500/40', text: 'text-yellow-300', dot: 'bg-yellow-500' },
];

function getAccountColor(email: string, index: number) {
  return ACCOUNT_COLORS[email.toLowerCase()] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDateRange(start: string, end: string, allDay: boolean): string {
  if (allDay) return 'All day';
  return `${formatTime(start)} - ${formatTime(end)}`;
}

function formatHeaderDate(date: Date, view: ViewMode): string {
  if (view === 'day') {
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  if (view === 'week') {
    const end = addDays(date, 6);
    const sameMonth = date.getMonth() === end.getMonth();
    if (sameMonth) {
      return `${date.toLocaleDateString(undefined, { month: 'long' })} ${date.getDate()} - ${end.getDate()}, ${date.getFullYear()}`;
    }
    return `${date.toLocaleDateString(undefined, { month: 'short' })} ${date.getDate()} - ${end.toLocaleDateString(undefined, { month: 'short' })} ${end.getDate()}, ${end.getFullYear()}`;
  }
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

// ── API helpers ──────────────────────────────────────────────────────────────

const API_BASE = '';

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('boss_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchEvents(start: string, end: string, accounts?: string[]): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({ start, end });
  if (accounts && accounts.length > 0) {
    params.set('accounts', accounts.join(','));
  }
  const res = await fetch(`api/calendar/events?${params}`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
  const data = await res.json();
  return data.events ?? [];
}

async function fetchAccounts(): Promise<AccountInfo[]> {
  const res = await fetch(`api/calendar/accounts`, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to fetch accounts: ${res.status}`);
  const data = await res.json();
  return data.accounts ?? [];
}

// ── Event popup ──────────────────────────────────────────────────────────────

function EventPopup({
  event,
  onClose,
  accountIndex,
}: {
  event: CalendarEvent;
  onClose: () => void;
  accountIndex: number;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const colors = getAccountColor(event.account, accountIndex);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        ref={popupRef}
        className="relative bg-surface-1 border border-border rounded-xl shadow-2xl w-full max-w-md p-5"
      >
        <button
          className="absolute top-3 right-3 p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>

        <div className={cn('w-1 h-full absolute left-0 top-0 rounded-l-xl', colors.dot)} />

        <h3 className="text-lg font-semibold text-text-primary pr-8 mb-3">{event.summary}</h3>

        <div className="space-y-2.5 text-sm">
          <div className="flex items-center gap-2 text-text-secondary">
            <Clock className="w-4 h-4 text-text-muted flex-shrink-0" />
            <span>{formatDateRange(event.start, event.end, event.allDay)}</span>
          </div>

          {!event.allDay && (
            <div className="flex items-center gap-2 text-text-secondary">
              <CalendarIcon className="w-4 h-4 text-text-muted flex-shrink-0" />
              <span>
                {new Date(event.start).toLocaleDateString(undefined, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                })}
              </span>
            </div>
          )}

          {event.location && (
            <div className="flex items-start gap-2 text-text-secondary">
              <MapPin className="w-4 h-4 text-text-muted flex-shrink-0 mt-0.5" />
              <span>{event.location}</span>
            </div>
          )}

          <div className="flex items-center gap-2 text-text-secondary">
            <User className="w-4 h-4 text-text-muted flex-shrink-0" />
            <div className="flex items-center gap-1.5">
              <span className={cn('w-2 h-2 rounded-full flex-shrink-0', colors.dot)} />
              <span>{event.account}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-text-muted text-xs">
            <span>{event.calendarName}</span>
          </div>

          {event.description && (
            <div className="pt-2 border-t border-border">
              <p className="text-text-secondary text-sm whitespace-pre-wrap line-clamp-6">
                {event.description}
              </p>
            </div>
          )}
        </div>

        {event.htmlLink && (
          <a
            href={event.htmlLink}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-1.5 text-sm text-accent hover:text-accent/80 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open in Google Calendar
          </a>
        )}
      </div>
    </div>
  );
}

// ── Week / Day time grid ─────────────────────────────────────────────────────

const HOUR_START = 6;
const HOUR_END = 22;
const HOURS = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i);
const HOUR_HEIGHT = 60; // px per hour

function getEventPosition(event: CalendarEvent, dayStart: Date) {
  const startDate = new Date(event.start);
  const endDate = new Date(event.end);
  const dayStartMs = new Date(dayStart).setHours(HOUR_START, 0, 0, 0);
  const dayEndMs = new Date(dayStart).setHours(HOUR_END, 0, 0, 0);

  const clampedStart = Math.max(startDate.getTime(), dayStartMs);
  const clampedEnd = Math.min(endDate.getTime(), dayEndMs);

  const topMinutes = (clampedStart - dayStartMs) / 60000;
  const durationMinutes = Math.max((clampedEnd - clampedStart) / 60000, 15);

  return {
    top: (topMinutes / 60) * HOUR_HEIGHT,
    height: Math.max((durationMinutes / 60) * HOUR_HEIGHT, 20),
  };
}

/** Returns the pixel offset from the top of the time grid for the current time. */
function getCurrentTimeOffset(): number {
  const now = new Date();
  const minutes = (now.getHours() - HOUR_START) * 60 + now.getMinutes();
  return (minutes / 60) * HOUR_HEIGHT;
}

/** Hook that returns the current time offset and updates every 60s. */
function useCurrentTime() {
  const [offset, setOffset] = useState(getCurrentTimeOffset);
  useEffect(() => {
    const id = setInterval(() => setOffset(getCurrentTimeOffset()), 60_000);
    return () => clearInterval(id);
  }, []);
  return offset;
}

function TimeGridDay({
  date,
  events,
  allDayEvents,
  accountEmails,
  onEventClick,
  nowOffset,
}: {
  date: Date;
  events: CalendarEvent[];
  allDayEvents: CalendarEvent[];
  accountEmails: string[];
  onEventClick: (event: CalendarEvent) => void;
  nowOffset: number;
}) {
  const showNowLine = isToday(date) && nowOffset >= 0 && nowOffset <= HOURS.length * HOUR_HEIGHT;

  return (
    <div className="flex flex-col min-w-[120px] flex-1">
      {/* All-day events */}
      {allDayEvents.length > 0 && (
        <div className="border-b border-border px-1 py-0.5 space-y-0.5">
          {allDayEvents.map((event) => {
            const colors = getAccountColor(event.account, accountEmails.indexOf(event.account));
            return (
              <button
                key={event.id}
                className={cn(
                  'w-full text-left px-1.5 py-0.5 rounded text-xs truncate border transition-opacity hover:opacity-80',
                  colors.bg, colors.border, colors.text,
                )}
                onClick={() => onEventClick(event)}
                title={event.summary}
              >
                {event.summary}
              </button>
            );
          })}
        </div>
      )}

      {/* Time grid */}
      <div className="relative" style={{ height: HOURS.length * HOUR_HEIGHT }}>
        {/* Hour lines */}
        {HOURS.map((hour) => (
          <div
            key={hour}
            className="absolute w-full border-t border-border/50"
            style={{ top: (hour - HOUR_START) * HOUR_HEIGHT }}
          />
        ))}

        {/* Current time indicator */}
        {showNowLine && (
          <div
            className="absolute left-0 right-0 z-10 pointer-events-none"
            style={{ top: nowOffset }}
          >
            <div className="flex items-center">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500 -ml-1 flex-shrink-0" />
              <div className="flex-1 h-[2px] bg-red-500" />
            </div>
          </div>
        )}

        {/* Events */}
        {events.map((event) => {
          const { top, height } = getEventPosition(event, date);
          const colors = getAccountColor(event.account, accountEmails.indexOf(event.account));
          return (
            <button
              key={event.id}
              className={cn(
                'absolute left-1 right-1 rounded px-1.5 py-0.5 text-xs text-left overflow-hidden border transition-opacity hover:opacity-80 cursor-pointer',
                colors.bg, colors.border, colors.text,
              )}
              style={{ top, height, minHeight: 20 }}
              onClick={() => onEventClick(event)}
              title={`${event.summary} - ${formatTime(event.start)}`}
            >
              <div className="font-medium truncate">{event.summary}</div>
              {height > 30 && (
                <div className="text-[10px] opacity-70 truncate">{formatTime(event.start)}</div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Calendar component ──────────────────────────────────────────────────

export function Calendar() {
  const [view, setView] = useState<ViewMode>('week');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [enabledCalendars, setEnabledCalendars] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const timeGridRef = useRef<HTMLDivElement>(null);
  const nowOffset = useCurrentTime();
  const scrolledRef = useRef(false);

  // Auto-scroll to current time on initial load (week/day view)
  useEffect(() => {
    if (scrolledRef.current) return;
    if ((view === 'week' || view === 'day') && timeGridRef.current && !loading) {
      const scrollTarget = Math.max(0, nowOffset - 150); // center-ish
      timeGridRef.current.scrollTop = scrollTarget;
      scrolledRef.current = true;
    }
  }, [view, loading, nowOffset]);

  const accountEmails = useMemo(() => accounts.map((a) => a.email), [accounts]);

  // Build a unique key for each calendar: "account::calendarId"
  const allCalendarKeys = useMemo(() => {
    const keys: string[] = [];
    for (const acc of accounts) {
      for (const cal of acc.calendars) {
        keys.push(`${acc.email}::${cal.id}`);
      }
    }
    return keys;
  }, [accounts]);

  // Compute date range based on view
  const { rangeStart, rangeEnd } = useMemo(() => {
    if (view === 'day') {
      const start = new Date(currentDate);
      start.setHours(0, 0, 0, 0);
      const end = addDays(start, 1);
      return { rangeStart: start, rangeEnd: end };
    }
    if (view === 'week') {
      const start = startOfWeek(currentDate);
      const end = addDays(start, 7);
      return { rangeStart: start, rangeEnd: end };
    }
    const monthStart = startOfMonth(currentDate);
    const gridStart = startOfWeek(monthStart);
    const gridEnd = addDays(gridStart, 42);
    return { rangeStart: gridStart, rangeEnd: gridEnd };
  }, [view, currentDate]);

  // Load accounts on mount — restore saved selections or use smart defaults
  useEffect(() => {
    fetchAccounts()
      .then((accs) => {
        setAccounts(accs);
        // Try to restore saved selections
        try {
          const saved = localStorage.getItem('boss_calendar_enabled');
          if (saved) {
            const arr = JSON.parse(saved) as string[];
            if (arr.length > 0) {
              setEnabledCalendars(new Set(arr));
              return;
            }
          }
        } catch {}
        // No saved prefs — smart defaults
        const seen = new Set<string>();
        const enabled = new Set<string>();
        for (const acc of accs) {
          for (const cal of acc.calendars) {
            const name = cal.summary.toLowerCase();
            if (seen.has(name) && !cal.primary) continue;
            seen.add(name);
            if (name.includes('day of the year') || name.includes('#daynum')) continue;
            enabled.add(`${acc.email}::${cal.id}`);
          }
        }
        setEnabledCalendars(enabled);
      })
      .catch(() => {});
  }, []);

  // Load events when range changes (fetch all, filter client-side)
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchEvents(rangeStart.toISOString(), rangeEnd.toISOString())
      .then((evts) => { setEvents(evts); setLoading(false); })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, [rangeStart, rangeEnd]);

  // Filter events by enabled calendars (client-side for instant toggle)
  const filteredEvents = useMemo(
    () => events.filter((e) => enabledCalendars.has(`${e.account}::${e.calendarId}`)),
    [events, enabledCalendars],
  );

  // Navigation
  const navigate = useCallback(
    (direction: -1 | 0 | 1) => {
      if (direction === 0) { setCurrentDate(new Date()); return; }
      setCurrentDate((prev) => {
        if (view === 'day') return addDays(prev, direction);
        if (view === 'week') return addDays(prev, direction * 7);
        const d = new Date(prev);
        d.setMonth(d.getMonth() + direction);
        return d;
      });
    },
    [view],
  );

  // Persist calendar selections
  useEffect(() => {
    if (enabledCalendars.size > 0) {
      localStorage.setItem('boss_calendar_enabled', JSON.stringify([...enabledCalendars]));
    }
  }, [enabledCalendars]);

  // Toggle individual calendar
  const toggleCalendar = useCallback((key: string) => {
    setEnabledCalendars((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  // Toggle all calendars for an account
  const toggleAccount = useCallback((email: string) => {
    setEnabledCalendars((prev) => {
      const next = new Set(prev);
      const acc = accounts.find(a => a.email === email);
      if (!acc) return next;
      const accKeys = acc.calendars.map(c => `${email}::${c.id}`);
      const allEnabled = accKeys.every(k => next.has(k));
      for (const k of accKeys) { if (allEnabled) next.delete(k); else next.add(k); }
      return next;
    });
  }, [accounts]);

  // ── Render helpers ───────────────────────────────────────────────

  const weekDays = useMemo(() => {
    const start = startOfWeek(currentDate);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [currentDate]);

  const monthGrid = useMemo(() => {
    const monthStart = startOfMonth(currentDate);
    const gridStart = startOfWeek(monthStart);
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [currentDate]);

  function getEventsForDay(date: Date, allDay?: boolean) {
    return filteredEvents.filter((e) => {
      const eventStart = new Date(e.start);
      const isAllDay = e.allDay;
      if (allDay !== undefined && isAllDay !== allDay) return false;
      // For all-day events, check date overlap
      if (isAllDay) {
        const eventEnd = new Date(e.end);
        const dayStart = new Date(date);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = addDays(dayStart, 1);
        return eventStart < dayEnd && eventEnd > dayStart;
      }
      return isSameDay(eventStart, date);
    });
  }

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-border bg-surface-1">
        <div className="flex items-center gap-3">
          <CalendarIcon className="w-5 h-5 text-accent" />
          <h1 className="text-lg font-semibold text-text-primary">Calendar</h1>
        </div>

        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex rounded-lg border border-border overflow-hidden">
            {(['month', 'week', 'day'] as ViewMode[]).map((v) => (
              <button
                key={v}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium transition-colors',
                  view === v
                    ? 'bg-accent text-white'
                    : 'bg-surface-2 text-text-secondary hover:bg-surface-3',
                )}
                onClick={() => setView(v)}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>

        </div>
      </div>

      {/* Navigation bar */}
      <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2 border-b border-border bg-surface-2">
        <button
          className="px-3 py-1 rounded-lg text-xs font-medium bg-surface-3 text-text-secondary hover:bg-surface-4 border border-border transition-colors"
          onClick={() => navigate(0)}
        >
          Today
        </button>
        <button
          className="p-1.5 rounded-lg text-text-muted hover:bg-surface-3 hover:text-text-primary transition-colors"
          onClick={() => navigate(-1)}
          aria-label="Previous"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          className="p-1.5 rounded-lg text-text-muted hover:bg-surface-3 hover:text-text-primary transition-colors"
          onClick={() => navigate(1)}
          aria-label="Next"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <h2 className="text-sm font-medium text-text-primary">
          {formatHeaderDate(view === 'week' ? startOfWeek(currentDate) : currentDate, view)}
        </h2>
        {loading && (
          <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin ml-auto" />
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="px-4 py-2 bg-danger/10 border-b border-danger/20 text-danger text-sm">
          {error}
        </div>
      )}

      {/* Main area: sidebar + calendar */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar — calendar checkboxes */}
        <div className="w-56 flex-shrink-0 border-r border-border bg-surface-1 overflow-y-auto p-3">
          <p className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-2">Calendars</p>
          {accounts.map((acc, accIdx) => {
            const colors = getAccountColor(acc.email, accIdx);
            const accKeys = acc.calendars.map(c => `${acc.email}::${c.id}`);
            const allOn = accKeys.every(k => enabledCalendars.has(k));
            const someOn = accKeys.some(k => enabledCalendars.has(k));
            return (
              <div key={acc.email} className="mb-2.5">
                <label className="flex items-center gap-2 py-1 rounded hover:bg-surface-3 cursor-pointer">
                  <input type="checkbox" checked={allOn} onChange={() => toggleAccount(acc.email)} className="sr-only" />
                  <span className={cn('w-3 h-3 rounded border-2 flex items-center justify-center flex-shrink-0',
                    allOn ? `${colors.dot} border-transparent` : someOn ? `${colors.dot} border-transparent opacity-50` : 'border-border bg-surface-3',
                  )}>
                    {(allOn || someOn) && <svg className="w-2 h-2 text-white" viewBox="0 0 12 12" fill="none"><path d={allOn ? "M2 6l3 3 5-5" : "M3 6h6"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                  </span>
                  <span className="text-[11px] font-medium text-text-primary truncate">{acc.email.split('@')[0]}</span>
                </label>
                {acc.calendars.map((cal) => {
                  const key = `${acc.email}::${cal.id}`;
                  const isOn = enabledCalendars.has(key);
                  return (
                    <label key={key} className="flex items-center gap-2 py-0.5 pl-5 rounded hover:bg-surface-3 cursor-pointer">
                      <input type="checkbox" checked={isOn} onChange={() => toggleCalendar(key)} className="sr-only" />
                      <span className={cn('w-2.5 h-2.5 rounded border flex items-center justify-center flex-shrink-0',
                        isOn ? `${colors.dot} border-transparent` : 'border-border bg-surface-3',
                      )}>
                        {isOn && <svg className="w-1.5 h-1.5 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                      </span>
                      <span className="text-[10px] text-text-secondary truncate">{cal.summary}</span>
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Calendar grid */}
        <div className="flex-1 overflow-auto min-h-0">
        {/* ── Month view ── */}
        {view === 'month' && (
          <div className="h-full flex flex-col">
            {/* Day-of-week headers */}
            <div className="grid grid-cols-7 border-b border-border bg-surface-2 flex-shrink-0">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div key={d} className="px-2 py-1.5 text-xs font-medium text-text-muted text-center">
                  {d}
                </div>
              ))}
            </div>
            {/* Grid */}
            <div className="grid grid-cols-7 grid-rows-6 flex-1">
              {monthGrid.map((day, i) => {
                const dayEvents = getEventsForDay(day);
                const inMonth = day.getMonth() === currentDate.getMonth();
                return (
                  <div
                    key={i}
                    className={cn(
                      'border-b border-r border-border p-1 min-h-[80px] overflow-hidden cursor-pointer transition-colors',
                      !inMonth && 'bg-surface-2/50',
                      isToday(day) && 'bg-accent/5',
                      'hover:bg-surface-3/50',
                    )}
                    onClick={() => {
                      setCurrentDate(day);
                      setView('day');
                    }}
                  >
                    <div
                      className={cn(
                        'text-xs font-medium mb-0.5 w-6 h-6 flex items-center justify-center rounded-full',
                        isToday(day) && 'bg-accent text-white',
                        !isToday(day) && inMonth && 'text-text-primary',
                        !isToday(day) && !inMonth && 'text-text-muted',
                      )}
                    >
                      {day.getDate()}
                    </div>
                    <div className="space-y-0.5">
                      {dayEvents.slice(0, 3).map((event) => {
                        const colors = getAccountColor(event.account, accountEmails.indexOf(event.account));
                        return (
                          <button
                            key={event.id}
                            className={cn(
                              'w-full text-left px-1 py-px rounded text-[10px] truncate border transition-opacity hover:opacity-80',
                              colors.bg, colors.border, colors.text,
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedEvent(event);
                            }}
                            title={event.summary}
                          >
                            {!event.allDay && (
                              <span className="opacity-70 mr-0.5">{formatTime(event.start)}</span>
                            )}
                            {event.summary}
                          </button>
                        );
                      })}
                      {dayEvents.length > 3 && (
                        <div className="text-[10px] text-text-muted px-1">
                          +{dayEvents.length - 3} more
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Week view ── */}
        {view === 'week' && (
          <div className="flex flex-col min-h-0">
            {/* Day headers */}
            <div className="flex border-b border-border bg-surface-2 flex-shrink-0">
              <div className="w-14 flex-shrink-0" /> {/* gutter for time labels */}
              {weekDays.map((day, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex-1 min-w-[120px] text-center py-2 border-l border-border cursor-pointer hover:bg-surface-3/50 transition-colors',
                  )}
                  onClick={() => {
                    setCurrentDate(day);
                    setView('day');
                  }}
                >
                  <div className="text-xs text-text-muted">
                    {day.toLocaleDateString(undefined, { weekday: 'short' })}
                  </div>
                  <div
                    className={cn(
                      'text-sm font-medium mt-0.5 w-7 h-7 flex items-center justify-center rounded-full mx-auto',
                      isToday(day) ? 'bg-accent text-white' : 'text-text-primary',
                    )}
                  >
                    {day.getDate()}
                  </div>
                </div>
              ))}
            </div>

            {/* Time grid */}
            <div ref={timeGridRef} className="flex flex-1 overflow-auto">
              {/* Time labels */}
              <div className="w-14 flex-shrink-0 relative" style={{ height: HOURS.length * HOUR_HEIGHT }}>
                {HOURS.map((hour) => {
                  const hourTop = (hour - HOUR_START) * HOUR_HEIGHT;
                  // Hide hour label if current time indicator would overlap it (within 20px)
                  const tooClose = nowOffset >= 0 && Math.abs(hourTop - nowOffset) < 20;
                  return (
                    <div
                      key={hour}
                      className={cn(
                        'absolute w-full text-right pr-2 text-[10px] text-text-muted -translate-y-1/2',
                        tooClose && 'opacity-0',
                      )}
                      style={{ top: hourTop }}
                    >
                      {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
                    </div>
                  );
                })}
                {/* Current time label in gutter */}
                {nowOffset >= 0 && nowOffset <= HOURS.length * HOUR_HEIGHT && (
                  <div
                    className="absolute w-full text-right pr-2 text-[10px] text-red-400 font-semibold -translate-y-1/2 z-10"
                    style={{ top: nowOffset }}
                  >
                    {new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </div>
                )}
              </div>

              {/* Day columns */}
              {weekDays.map((day, i) => (
                <div key={i} className="border-l border-border flex-1 min-w-[120px]">
                  <TimeGridDay
                    date={day}
                    events={getEventsForDay(day, false)}
                    allDayEvents={getEventsForDay(day, true)}
                    accountEmails={accountEmails}
                    onEventClick={setSelectedEvent}
                    nowOffset={nowOffset}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Day view ── */}
        {view === 'day' && (
          <div ref={timeGridRef} className="flex min-h-0 overflow-auto">
            {/* Time labels */}
            <div className="w-14 flex-shrink-0 relative" style={{ height: HOURS.length * HOUR_HEIGHT }}>
              {HOURS.map((hour) => {
                const hourTop = (hour - HOUR_START) * HOUR_HEIGHT;
                const tooClose = isToday(currentDate) && nowOffset >= 0 && Math.abs(hourTop - nowOffset) < 20;
                return (
                  <div
                    key={hour}
                    className={cn(
                      'absolute w-full text-right pr-2 text-[10px] text-text-muted -translate-y-1/2',
                      tooClose && 'opacity-0',
                    )}
                    style={{ top: hourTop }}
                  >
                    {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
                  </div>
                );
              })}
              {/* Current time label in gutter */}
              {isToday(currentDate) && nowOffset >= 0 && nowOffset <= HOURS.length * HOUR_HEIGHT && (
                <div
                  className="absolute w-full text-right pr-2 text-[10px] text-red-400 font-semibold -translate-y-1/2 z-10"
                  style={{ top: nowOffset }}
                >
                  {new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </div>
              )}
            </div>

            {/* Single day column */}
            <div className="flex-1 border-l border-border">
              <TimeGridDay
                date={currentDate}
                events={getEventsForDay(currentDate, false)}
                allDayEvents={getEventsForDay(currentDate, true)}
                accountEmails={accountEmails}
                onEventClick={setSelectedEvent}
                nowOffset={nowOffset}
              />
            </div>
          </div>
        )}
      </div>
      </div>{/* end flex: sidebar + calendar */}

      {/* Event popup */}
      {selectedEvent && (
        <EventPopup
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          accountIndex={accountEmails.indexOf(selectedEvent.account)}
        />
      )}
    </div>
  );
}

export default Calendar;
