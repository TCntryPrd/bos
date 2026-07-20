// Per-build brand: 'ir' = Industry Rockstar white-label (Executive scenes,
// "From Industry Rockstar" lockup); 'plain' = clean standard BOS (Original).
// Set via VITE_BRAND at build time; also stamped on <html data-brand> for CSS.
export type Brand = 'ir' | 'plain';
export const BRAND: Brand =
  ((import.meta as { env?: Record<string, string> }).env?.VITE_BRAND === 'plain') ? 'plain' : 'ir';
export const isPlainBrand = BRAND === 'plain';
