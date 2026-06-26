/**
 * BOS dark theme constants.
 * Mirrors the web dashboard aesthetic — deep slate base with indigo/violet accent.
 */

export const Colors = {
  // Base surfaces
  background: '#0a0a0f',
  surface: '#111118',
  surfaceElevated: '#16161f',
  surfaceBorder: '#1e1e2e',

  // Text
  textPrimary: '#e8e8f0',
  textSecondary: '#8888a8',
  textMuted: '#4a4a6a',
  textInverse: '#0a0a0f',

  // Accent — indigo/violet
  accent: '#6366f1',
  accentLight: '#818cf8',
  accentDark: '#4f46e5',
  accentMuted: 'rgba(99,102,241,0.15)',

  // Semantic
  success: '#22c55e',
  successMuted: 'rgba(34,197,94,0.15)',
  warning: '#f59e0b',
  warningMuted: 'rgba(245,158,11,0.15)',
  error: '#ef4444',
  errorMuted: 'rgba(239,68,68,0.15)',
  info: '#3b82f6',
  infoMuted: 'rgba(59,130,246,0.15)',

  // Voice indicator
  voiceActive: '#a855f7',
  voiceActiveGlow: 'rgba(168,85,247,0.4)',
  voiceListening: '#ec4899',

  // Tab bar
  tabActive: '#6366f1',
  tabInactive: '#4a4a6a',
  tabBackground: '#0d0d16',

  // Status colors for health
  healthy: '#22c55e',
  degraded: '#f59e0b',
  unhealthy: '#ef4444',
  unknown: '#6b7280',
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
  '4xl': 64,
} as const;

export const Radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  full: 9999,
} as const;

export const FontSize = {
  xs: 11,
  sm: 13,
  base: 15,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 24,
  '3xl': 30,
  '4xl': 36,
} as const;

export const FontWeight = {
  normal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};
