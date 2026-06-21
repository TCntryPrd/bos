/**
 * Tenant configuration types.
 * Supports both single-tenant and multi-tenant modes.
 */

import type { BrainProvider } from './brain.js';
import type { ConnectorProvider } from './connector.js';

export type TenantMode = 'single' | 'multi';

export interface TenantConfig {
  id: string;
  name: string;
  mode: TenantMode;
  brainProvider: BrainProvider;
  connectorProvider: ConnectorProvider;
  createdAt: Date;
  updatedAt: Date;
  settings: TenantSettings;
}

export interface TenantSettings {
  timezone: string;
  locale: string;
  voiceEnabled: boolean;
  backupIntervalMinutes: number;
  backupRetentionDays: number;
  healingEnabled: boolean;
  learningEnabled: boolean;
}

export interface TenantContext {
  tenantId: string;
  userId: string;
  config: TenantConfig;
}
