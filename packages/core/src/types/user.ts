/**
 * User profile and preference types.
 */

export interface UserProfile {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  timezone: string;
  locale: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserPreference {
  id: string;
  userId: string;
  tenantId: string;
  category: PreferenceCategory;
  key: string;
  value: string;
  source: PreferenceSource;
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
}

export type PreferenceCategory =
  | 'communication'
  | 'scheduling'
  | 'tasks'
  | 'files'
  | 'voice'
  | 'general';

export type PreferenceSource =
  | 'explicit'     // User said "never do X"
  | 'behavioral'   // Observed pattern
  | 'onboarding';  // Inferred during deep dive
