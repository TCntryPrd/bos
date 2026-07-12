/**
 * Runtime type validators for core BOS types.
 * These guard functions complement the TypeScript compile-time types
 * with runtime checks used in API boundary validation, deserialization,
 * and configuration loading.
 */

import type {
  BrainCapabilities,
  BrainConfig,
  BrainProvider,
  BrainRequest,
  BrainResponse,
} from '../types/brain.js';
import type { TenantConfig, TenantSettings } from '../types/tenant.js';
import type { HealthCheckResult, HealthStatus, ServiceName } from '../types/health.js';

// ── Primitive helpers ────────────────────────────────────────────────

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

export function isPositiveNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

export function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export function isDate(v: unknown): v is Date {
  return v instanceof Date && !Number.isNaN(v.getTime());
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── BrainProvider ────────────────────────────────────────────────────

const BRAIN_PROVIDERS: BrainProvider[] = [
  'claude-code',
  'openai',
  'gemini',
  'openclaw',
  'custom',
];

export function isBrainProvider(v: unknown): v is BrainProvider {
  return isString(v) && (BRAIN_PROVIDERS as string[]).includes(v);
}

// ── BrainCapabilities ─────────────────────────────────────────────────

const CAPABILITY_KEYS: (keyof BrainCapabilities)[] = [
  'canChat',
  'canStream',
  'canUseTools',
  'canAccessMCP',
  'canExecuteCode',
  'canSpawnAgents',
  'canMaintainMemory',
  'canProcessVoice',
  'canProcessImages',
  'canProcessDocuments',
];

export function isBrainCapabilities(v: unknown): v is BrainCapabilities {
  if (!isRecord(v)) return false;
  return CAPABILITY_KEYS.every((key) => isBoolean(v[key]));
}

// ── BrainConfig ──────────────────────────────────────────────────────

export function isBrainConfig(v: unknown): v is BrainConfig {
  if (!isRecord(v)) return false;
  if (!isBrainProvider(v.provider)) return false;
  if (!isBrainCapabilities(v.capabilities)) return false;
  if (v.apiKey !== undefined && !isNonEmptyString(v.apiKey)) return false;
  if (v.endpoint !== undefined && !isNonEmptyString(v.endpoint)) return false;
  if (v.model !== undefined && !isNonEmptyString(v.model)) return false;
  if (v.fallbackProvider !== undefined && !isBrainProvider(v.fallbackProvider)) return false;
  return true;
}

// ── BrainRequest ─────────────────────────────────────────────────────

export function isBrainRequest(v: unknown): v is BrainRequest {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.tenantId)) return false;
  if (!isNonEmptyString(v.userId)) return false;
  if (!isNonEmptyString(v.prompt)) return false;
  if (v.context !== undefined && !isRecord(v.context)) return false;
  if (v.stream !== undefined && !isBoolean(v.stream)) return false;
  return true;
}

// ── BrainResponse ────────────────────────────────────────────────────

export function isBrainResponse(v: unknown): v is BrainResponse {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.requestId)) return false;
  if (typeof v.content !== 'string') return false;
  return true;
}

// ── HealthStatus ─────────────────────────────────────────────────────

const HEALTH_STATUSES: HealthStatus[] = ['healthy', 'degraded', 'unhealthy', 'unknown'];
const SERVICE_NAMES: ServiceName[] = [
  'brain',
  'postgres',
  'redis',
  'weaviate',
  'connector-microsoft',
  'connector-google',
  'voice',
  'backup',
];

export function isHealthStatus(v: unknown): v is HealthStatus {
  return isString(v) && (HEALTH_STATUSES as string[]).includes(v);
}

export function isServiceName(v: unknown): v is ServiceName {
  return isString(v) && (SERVICE_NAMES as string[]).includes(v);
}

export function isHealthCheckResult(v: unknown): v is HealthCheckResult {
  if (!isRecord(v)) return false;
  if (!isServiceName(v.service)) return false;
  if (!isHealthStatus(v.status)) return false;
  if (!isDate(v.checkedAt)) return false;
  if (v.message !== undefined && !isString(v.message)) return false;
  if (v.latencyMs !== undefined && !isNonNegativeInteger(v.latencyMs)) return false;
  return true;
}

// ── TenantSettings ───────────────────────────────────────────────────

export function isTenantSettings(v: unknown): v is TenantSettings {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.timezone)) return false;
  if (!isNonEmptyString(v.locale)) return false;
  if (!isBoolean(v.voiceEnabled)) return false;
  if (!isPositiveNumber(v.backupIntervalMinutes)) return false;
  if (!isPositiveNumber(v.backupRetentionDays)) return false;
  if (!isBoolean(v.healingEnabled)) return false;
  if (!isBoolean(v.learningEnabled)) return false;
  return true;
}

// ── TenantConfig ─────────────────────────────────────────────────────

export function isTenantConfig(v: unknown): v is TenantConfig {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.id)) return false;
  if (!isNonEmptyString(v.name)) return false;
  if (v.mode !== 'single' && v.mode !== 'multi') return false;
  if (!isBrainProvider(v.brainProvider)) return false;
  if (v.connectorProvider !== 'google' && v.connectorProvider !== 'microsoft') return false;
  if (!isDate(v.createdAt)) return false;
  if (!isDate(v.updatedAt)) return false;
  if (!isTenantSettings(v.settings)) return false;
  return true;
}

// ── Utility: collect validation errors ──────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateBrainRequest(v: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(v)) return { valid: false, errors: ['Value is not an object'] };

  if (!isNonEmptyString(v.id)) errors.push('id: required non-empty string');
  if (!isNonEmptyString(v.tenantId)) errors.push('tenantId: required non-empty string');
  if (!isNonEmptyString(v.userId)) errors.push('userId: required non-empty string');
  if (!isNonEmptyString(v.prompt)) errors.push('prompt: required non-empty string');
  if (v.context !== undefined && !isRecord(v.context)) errors.push('context: must be an object');
  if (v.stream !== undefined && !isBoolean(v.stream)) errors.push('stream: must be a boolean');

  return { valid: errors.length === 0, errors };
}

export function validateTenantConfig(v: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(v)) return { valid: false, errors: ['Value is not an object'] };

  if (!isNonEmptyString(v.id)) errors.push('id: required non-empty string');
  if (!isNonEmptyString(v.name)) errors.push('name: required non-empty string');
  if (v.mode !== 'single' && v.mode !== 'multi') errors.push('mode: must be "single" or "multi"');
  if (!isBrainProvider(v.brainProvider)) errors.push(`brainProvider: must be one of ${BRAIN_PROVIDERS.join(', ')}`);
  if (v.connectorProvider !== 'google' && v.connectorProvider !== 'microsoft') {
    errors.push('connectorProvider: must be "google" or "microsoft"');
  }
  if (!isDate(v.createdAt)) errors.push('createdAt: must be a valid Date');
  if (!isDate(v.updatedAt)) errors.push('updatedAt: must be a valid Date');
  if (!isTenantSettings(v.settings)) errors.push('settings: invalid TenantSettings structure');

  return { valid: errors.length === 0, errors };
}
