# Dashboard Tiles

## Overview

The IR Custom AIOS Dashboard (`apps/web/src/pages/Dashboard.tsx`) is composed of self-contained tiles — each a React component with its own polling hook. Tiles live in the right column alongside the Agent Roster, Slack Attention, and Inbox panels.

## Anatomy of a Tile

Every tile follows this pattern:

### 1. State interface
```typescript
interface MyState {
  data: MyData[];
  loaded: boolean;
}
```

### 2. Polling hook
```typescript
function useMyData(): MyState {
  const [state, setState] = useState<MyState>({ data: [], loaded: false });
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      authedFetch('api/my-endpoint')
        .then((r) => (r.ok ? r.json() : { data: [] }))
        .then((data) => {
          if (cancelled) return;
          setState({ data: data.items ?? [], loaded: true });
        })
        .catch(() => { if (!cancelled) setState({ data: [], loaded: true }); });
    };
    load();
    const id = window.setInterval(load, 30_000); // poll every 30s
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);
  return state;
}
```

### 3. Panel component
```typescript
function MyPanel({ state }: { state: MyState }) {
  const { data, loaded } = state;
  return (
    <Panel
      title="My Title"
      icon={<SomeLucideIcon size={14} />}
      accent="linear-gradient(135deg, #color1, #color2)"
      meta={<div>...header controls...</div>}
    >
      {!loaded && <div>loading…</div>}
      {loaded && data.length === 0 && <div>No items.</div>}
      {data.map((item) => <ItemRow key={item.id} item={item} />)}
    </Panel>
  );
}
```

### 4. Wire into Dashboard
```typescript
// Inside the Dashboard() component:
const myState = useMyData();

// Inside the JSX right column:
<MyPanel state={myState} />
```

## The Panel Component

`Panel` is a shared wrapper in `Dashboard.tsx` (defined locally, not imported). It provides:
- Dark card with subtle border
- Title row with icon, title text, and optional `meta` slot (right-aligned controls)
- `accent` prop — a CSS gradient string applied as a left-border accent stripe
- `data-testid` conventions: use `<slug>-tile-panel` and `<slug>-tile-meta`

## WhatsApp Tile (Reference Implementation)

The WhatsApp tile is the canonical example of a fully working tile added in June 2026.

**Hook:** `useWhatsApp()` — polls `api/whatsapp/threads` every 30s  
**Component:** `WhatsAppPanel`  
**Accent color:** `#25d366` / `#128c7e` (WhatsApp green)  
**Test IDs:** `wa-tile-panel`, `wa-tile-meta`

**What it shows:**
- Total unread count in header (green if >0, grey if clear)
- Up to 5 unread threads, sorted by `last_message_at` desc
- Each row: green accent bar, thread name (+ "group" pill if group), message preview with "you: " prefix if from Kevin, relative timestamp, unread badge
- "Open" button in header navigates to `/whatsapp`

**Key data shape:**
```typescript
interface WhatsAppThread {
  chat_id: string;
  display_name: string | null;
  phone: string | null;
  is_group: boolean;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_from_me: boolean | null;
  unread_count: number;
}
```

## Polling Intervals by Tile

| Tile | Interval | Notes |
|---|---|---|
| WhatsApp | 30s | Low urgency; unread count |
| Slack Attention | 30s | |
| Inbox | 30s | |
| Calendar | 60s | |
| Agent Roster | 30s | |

## Adding a New Tile — Checklist

1. Define `interface MyState` with at minimum `{ loaded: boolean }`
2. Write `useMyData()` hook with cleanup-safe `cancelled` flag and `setInterval`
3. Write `MyPanel({ state })` using the `Panel` wrapper
4. Add `data-testid` attributes for `<slug>-tile-panel` and `<slug>-tile-meta`
5. Call the hook inside `Dashboard()` component
6. Add `<MyPanel state={myState} />` in the right column JSX
7. Rebuild: `docker compose build web && docker compose up -d --no-deps web`

## Related Playbooks

- `whatsapp-openwa.md` — WhatsApp data source
- `whatsapp-sync-names.md` — name sync that feeds the tile
