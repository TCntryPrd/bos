// Global tile lock — one switch that governs whether tiles anywhere in the app
// (Dashboard command wall, Health vitals grid, LinkedIn tiles, sortable card
// grids) can be moved/resized. Locked by default; the padlock in the TopBar
// flips it. Persisted per browser; broadcast so every mounted page reacts live.
import { useSyncExternalStore } from 'react';

const KEY = 'boss_tiles_locked_v1';
const EVENT = 'boss-tiles-lock-changed';

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'unlocked';
  } catch {
    return true;
  }
}

let locked = read();

export function tilesLocked(): boolean {
  return locked;
}

export function setTilesLocked(next: boolean): void {
  locked = next;
  try {
    localStorage.setItem(KEY, next ? 'locked' : 'unlocked');
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      locked = read();
      cb();
    }
  };
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}

export function useTilesLocked(): boolean {
  return useSyncExternalStore(subscribe, tilesLocked, () => true);
}
