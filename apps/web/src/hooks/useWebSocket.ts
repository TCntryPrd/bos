/**
 * React hook that wraps the BossWebSocket singleton.
 * Components use this to subscribe to real-time health + activity updates.
 */

import { useState, useEffect } from 'react';
import { bossWs } from '../lib/websocket';
import type { SystemHealth, ActivityItem } from '../types/api';

export function useWsHealth(): SystemHealth | null {
  const [health, setHealth] = useState<SystemHealth | null>(null);

  useEffect(() => {
    bossWs.connect();
    const unsub = bossWs.onHealth(setHealth);
    return () => {
      unsub();
    };
  }, []);

  return health;
}

export function useWsActivity(maxItems = 20): ActivityItem[] {
  const [items, setItems] = useState<ActivityItem[]>([]);

  useEffect(() => {
    bossWs.connect();
    const unsub = bossWs.onActivity((item) => {
      setItems((prev) => [item, ...prev].slice(0, maxItems));
    });
    return () => {
      unsub();
    };
  }, [maxItems]);

  return items;
}

export function useWsStatus(): boolean {
  const [connected, setConnected] = useState(bossWs.getIsConnected());

  useEffect(() => {
    const unsub = bossWs.onStatus(setConnected);
    return () => unsub();
  }, []);

  return connected;
}
