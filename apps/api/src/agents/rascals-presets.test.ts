import { describe, it, expect } from 'vitest';
import { RASCAL_PRESETS, getPreset, type RascalPreset } from './rascals-presets.js';

describe('Little Rascals presets', () => {
  it('ships exactly 13 classic presets', () => {
    expect(RASCAL_PRESETS).toHaveLength(13);
  });

  it('uses unique, lowercase handles suitable for tmux session names', () => {
    const handles = RASCAL_PRESETS.map((r: RascalPreset) => r.handle);
    expect(new Set(handles).size).toBe(13);
    for (const h of handles) {
      expect(h).toMatch(/^[a-z]{2,24}$/);
    }
  });

  it('puts Darla Wooldridge first (v1.4.0 primary)', () => {
    const darla = RASCAL_PRESETS[0];
    expect(darla.handle).toBe('darla');
    expect(darla.displayName).toBe('Darla Wooldridge');
    expect(darla.cli).toBe('claude');
    expect(darla.client).toContain('Debbie');
  });

  it('spells Stymie with "Rockstar" — one r, not two', () => {
    const stymie = RASCAL_PRESETS.find((r: RascalPreset) => r.handle === 'stymie');
    expect(stymie).toBeDefined();
    expect(stymie!.displayName).toBe('Stymie Rockstar');
  });

  it('uses the ollama CLI only for Alfalfa and Stymie', () => {
    const ollama = RASCAL_PRESETS.filter((r: RascalPreset) => r.cli === 'ollama').map((r: RascalPreset) => r.handle).sort();
    expect(ollama).toEqual(['alfalfa', 'stymie']);
  });

  it('defaults projectDir to /home/tcntryprd/rascals/{handle}', () => {
    for (const r of RASCAL_PRESETS) {
      expect(r.projectDir).toBe(`/home/tcntryprd/rascals/${r.handle}`);
    }
  });
});

describe('getPreset', () => {
  it('returns the preset for a known handle', () => {
    expect(getPreset('darla')?.handle).toBe('darla');
  });

  it('returns undefined for an unknown handle', () => {
    expect(getPreset('notreal')).toBeUndefined();
  });
});
