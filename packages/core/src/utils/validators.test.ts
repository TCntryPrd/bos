/**
 * Unit tests — @boss/core validators
 *
 * Tests cover all guard functions and the validateBrainRequest /
 * validateTenantConfig error-collection helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  isString,
  isNonEmptyString,
  isBoolean,
  isPositiveNumber,
  isNonNegativeInteger,
  isDate,
  isRecord,
  isBrainProvider,
  isBrainCapabilities,
  isBrainConfig,
  isBrainRequest,
  isBrainResponse,
  isHealthStatus,
  isServiceName,
  isHealthCheckResult,
  isTenantSettings,
  isTenantConfig,
  validateBrainRequest,
  validateTenantConfig,
} from './validators.js';

// ── Primitive helpers ────────────────────────────────────────────────

describe('isString', () => {
  it('returns true for strings', () => {
    expect(isString('')).toBe(true);
    expect(isString('hello')).toBe(true);
  });

  it('returns false for non-strings', () => {
    expect(isString(42)).toBe(false);
    expect(isString(null)).toBe(false);
    expect(isString(undefined)).toBe(false);
    expect(isString({})).toBe(false);
    expect(isString([])).toBe(false);
  });
});

describe('isNonEmptyString', () => {
  it('returns true for strings with content', () => {
    expect(isNonEmptyString('hello')).toBe(true);
    expect(isNonEmptyString('  hello  ')).toBe(true);
  });

  it('returns false for empty or whitespace-only strings', () => {
    expect(isNonEmptyString('')).toBe(false);
    expect(isNonEmptyString('   ')).toBe(false);
  });

  it('returns false for non-strings', () => {
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(0)).toBe(false);
  });
});

describe('isBoolean', () => {
  it('returns true for booleans', () => {
    expect(isBoolean(true)).toBe(true);
    expect(isBoolean(false)).toBe(true);
  });

  it('returns false for truthy/falsy non-booleans', () => {
    expect(isBoolean(1)).toBe(false);
    expect(isBoolean(0)).toBe(false);
    expect(isBoolean('true')).toBe(false);
    expect(isBoolean(null)).toBe(false);
  });
});

describe('isPositiveNumber', () => {
  it('returns true for positive finite numbers', () => {
    expect(isPositiveNumber(1)).toBe(true);
    expect(isPositiveNumber(0.5)).toBe(true);
    expect(isPositiveNumber(1000)).toBe(true);
  });

  it('returns false for zero, negative, infinite, or non-numbers', () => {
    expect(isPositiveNumber(0)).toBe(false);
    expect(isPositiveNumber(-1)).toBe(false);
    expect(isPositiveNumber(Infinity)).toBe(false);
    expect(isPositiveNumber(NaN)).toBe(false);
    expect(isPositiveNumber('5')).toBe(false);
  });
});

describe('isNonNegativeInteger', () => {
  it('returns true for 0 and positive integers', () => {
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(1)).toBe(true);
    expect(isNonNegativeInteger(100)).toBe(true);
  });

  it('returns false for floats, negatives, or non-numbers', () => {
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(NaN)).toBe(false);
    expect(isNonNegativeInteger('0')).toBe(false);
  });
});

describe('isDate', () => {
  it('returns true for valid Date instances', () => {
    expect(isDate(new Date())).toBe(true);
    expect(isDate(new Date('2026-01-01'))).toBe(true);
  });

  it('returns false for invalid Dates and non-Date values', () => {
    expect(isDate(new Date('not-a-date'))).toBe(false);
    expect(isDate('2026-01-01')).toBe(false);
    expect(isDate(Date.now())).toBe(false);
    expect(isDate(null)).toBe(false);
  });
});

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns false for arrays, null, and primitives', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('string')).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});

// ── BrainProvider ────────────────────────────────────────────────────

describe('isBrainProvider', () => {
  it('accepts all valid provider strings', () => {
    for (const p of ['claude-code', 'openai', 'gemini', 'openclaw', 'custom']) {
      expect(isBrainProvider(p)).toBe(true);
    }
  });

  it('rejects unknown provider strings', () => {
    expect(isBrainProvider('gpt-4')).toBe(false);
    expect(isBrainProvider('anthropic')).toBe(false);
    expect(isBrainProvider('')).toBe(false);
    expect(isBrainProvider(null)).toBe(false);
  });
});

// ── BrainCapabilities ─────────────────────────────────────────────────

describe('isBrainCapabilities', () => {
  const validCaps = {
    canChat: true,
    canStream: true,
    canUseTools: false,
    canAccessMCP: false,
    canExecuteCode: false,
    canSpawnAgents: false,
    canMaintainMemory: false,
    canProcessVoice: false,
    canProcessImages: false,
    canProcessDocuments: false,
  };

  it('accepts a complete valid capabilities object', () => {
    expect(isBrainCapabilities(validCaps)).toBe(true);
  });

  it('rejects objects with missing capability fields', () => {
    const { canChat, ...missing } = validCaps;
    expect(isBrainCapabilities(missing)).toBe(false);
  });

  it('rejects objects with non-boolean capability values', () => {
    expect(isBrainCapabilities({ ...validCaps, canChat: 1 })).toBe(false);
    expect(isBrainCapabilities({ ...validCaps, canStream: 'true' })).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isBrainCapabilities(null)).toBe(false);
    expect(isBrainCapabilities('caps')).toBe(false);
  });
});

// ── BrainConfig ──────────────────────────────────────────────────────

describe('isBrainConfig', () => {
  const baseCaps = {
    canChat: true, canStream: false, canUseTools: false, canAccessMCP: false,
    canExecuteCode: false, canSpawnAgents: false, canMaintainMemory: false,
    canProcessVoice: false, canProcessImages: false, canProcessDocuments: false,
  };

  it('accepts a minimal valid config', () => {
    expect(isBrainConfig({ provider: 'openai', capabilities: baseCaps })).toBe(true);
  });

  it('accepts an extended config with optional fields', () => {
    expect(isBrainConfig({
      provider: 'claude-code',
      capabilities: baseCaps,
      apiKey: 'sk-test-key',
      model: 'claude-sonnet-4-6',
      fallbackProvider: 'openai',
    })).toBe(true);
  });

  it('rejects config with invalid provider', () => {
    expect(isBrainConfig({ provider: 'invalid', capabilities: baseCaps })).toBe(false);
  });

  it('rejects config with empty apiKey string', () => {
    expect(isBrainConfig({ provider: 'openai', capabilities: baseCaps, apiKey: '' })).toBe(false);
  });

  it('rejects config with invalid fallbackProvider', () => {
    expect(isBrainConfig({
      provider: 'openai',
      capabilities: baseCaps,
      fallbackProvider: 'gpt-4o',
    })).toBe(false);
  });
});

// ── BrainRequest ─────────────────────────────────────────────────────

describe('isBrainRequest', () => {
  const valid = {
    id: 'req-001',
    tenantId: 'tenant-1',
    userId: 'user-1',
    prompt: 'Hello',
  };

  it('accepts a minimal valid request', () => {
    expect(isBrainRequest(valid)).toBe(true);
  });

  it('accepts request with optional fields', () => {
    expect(isBrainRequest({
      ...valid,
      context: { timezone: 'UTC' },
      stream: true,
    })).toBe(true);
  });

  it('rejects request missing required fields', () => {
    expect(isBrainRequest({ ...valid, id: undefined })).toBe(false);
    expect(isBrainRequest({ ...valid, prompt: '' })).toBe(false);
    expect(isBrainRequest({ ...valid, tenantId: '' })).toBe(false);
  });

  it('rejects request with invalid optional field types', () => {
    expect(isBrainRequest({ ...valid, context: 'not-an-object' })).toBe(false);
    expect(isBrainRequest({ ...valid, stream: 'yes' })).toBe(false);
  });
});

// ── BrainResponse ────────────────────────────────────────────────────

describe('isBrainResponse', () => {
  it('accepts a valid response', () => {
    expect(isBrainResponse({
      id: 'resp-001',
      requestId: 'req-001',
      content: 'Hello back',
    })).toBe(true);
  });

  it('accepts empty content string', () => {
    expect(isBrainResponse({ id: 'r1', requestId: 'q1', content: '' })).toBe(true);
  });

  it('rejects response missing id or requestId', () => {
    expect(isBrainResponse({ requestId: 'q1', content: 'hi' })).toBe(false);
    expect(isBrainResponse({ id: 'r1', content: 'hi' })).toBe(false);
  });
});

// ── HealthStatus & ServiceName ─────────────────────────────────────────

describe('isHealthStatus', () => {
  it('accepts all valid statuses', () => {
    for (const s of ['healthy', 'degraded', 'unhealthy', 'unknown']) {
      expect(isHealthStatus(s)).toBe(true);
    }
  });

  it('rejects invalid statuses', () => {
    expect(isHealthStatus('ok')).toBe(false);
    expect(isHealthStatus('')).toBe(false);
    expect(isHealthStatus(null)).toBe(false);
  });
});

describe('isServiceName', () => {
  it('accepts all valid service names', () => {
    const names = [
      'brain', 'postgres', 'redis', 'weaviate',
      'connector-microsoft', 'connector-google', 'voice', 'backup',
    ];
    for (const n of names) {
      expect(isServiceName(n)).toBe(true);
    }
  });

  it('rejects unknown service names', () => {
    expect(isServiceName('mysql')).toBe(false);
    expect(isServiceName('api')).toBe(false);
  });
});

describe('isHealthCheckResult', () => {
  it('accepts a valid health check result', () => {
    expect(isHealthCheckResult({
      service: 'postgres',
      status: 'healthy',
      checkedAt: new Date(),
    })).toBe(true);
  });

  it('accepts result with optional latencyMs and message', () => {
    expect(isHealthCheckResult({
      service: 'redis',
      status: 'degraded',
      message: 'Slow responses',
      latencyMs: 250,
      checkedAt: new Date(),
    })).toBe(true);
  });

  it('rejects invalid service or status values', () => {
    expect(isHealthCheckResult({
      service: 'mysql',
      status: 'healthy',
      checkedAt: new Date(),
    })).toBe(false);

    expect(isHealthCheckResult({
      service: 'postgres',
      status: 'ok',
      checkedAt: new Date(),
    })).toBe(false);
  });

  it('rejects negative latencyMs', () => {
    expect(isHealthCheckResult({
      service: 'brain',
      status: 'healthy',
      latencyMs: -5,
      checkedAt: new Date(),
    })).toBe(false);
  });

  it('rejects float latencyMs', () => {
    expect(isHealthCheckResult({
      service: 'brain',
      status: 'healthy',
      latencyMs: 1.5,
      checkedAt: new Date(),
    })).toBe(false);
  });
});

// ── TenantSettings ───────────────────────────────────────────────────

describe('isTenantSettings', () => {
  const valid: Record<string, unknown> = {
    timezone: 'America/New_York',
    locale: 'en-US',
    voiceEnabled: false,
    backupIntervalMinutes: 60,
    backupRetentionDays: 30,
    healingEnabled: true,
    learningEnabled: true,
  };

  it('accepts valid settings', () => {
    expect(isTenantSettings(valid)).toBe(true);
  });

  it('rejects settings with zero backupIntervalMinutes', () => {
    expect(isTenantSettings({ ...valid, backupIntervalMinutes: 0 })).toBe(false);
  });

  it('rejects settings with non-boolean voiceEnabled', () => {
    expect(isTenantSettings({ ...valid, voiceEnabled: 1 })).toBe(false);
  });

  it('rejects settings with missing timezone', () => {
    const { timezone, ...missing } = valid;
    expect(isTenantSettings(missing)).toBe(false);
  });
});

// ── TenantConfig ─────────────────────────────────────────────────────

describe('isTenantConfig', () => {
  const settings = {
    timezone: 'UTC', locale: 'en-US', voiceEnabled: false,
    backupIntervalMinutes: 60, backupRetentionDays: 30,
    healingEnabled: true, learningEnabled: true,
  };

  const valid: Record<string, unknown> = {
    id: 'tenant-1',
    name: 'Tenant One',
    mode: 'single',
    brainProvider: 'openai',
    connectorProvider: 'google',
    createdAt: new Date(),
    updatedAt: new Date(),
    settings,
  };

  it('accepts a valid tenant config', () => {
    expect(isTenantConfig(valid)).toBe(true);
  });

  it('accepts multi mode with microsoft connector', () => {
    expect(isTenantConfig({
      ...valid,
      mode: 'multi',
      connectorProvider: 'microsoft',
    })).toBe(true);
  });

  it('rejects invalid mode', () => {
    expect(isTenantConfig({ ...valid, mode: 'enterprise' })).toBe(false);
  });

  it('rejects invalid connectorProvider', () => {
    expect(isTenantConfig({ ...valid, connectorProvider: 'slack' })).toBe(false);
  });

  it('rejects non-Date createdAt', () => {
    expect(isTenantConfig({ ...valid, createdAt: '2026-01-01' })).toBe(false);
  });
});

// ── validateBrainRequest ─────────────────────────────────────────────

describe('validateBrainRequest', () => {
  const valid = {
    id: 'req-001',
    tenantId: 'tenant-1',
    userId: 'user-1',
    prompt: 'Hello',
  };

  it('returns valid=true with empty errors for a good request', () => {
    const result = validateBrainRequest(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('collects all field errors for a completely invalid object', () => {
    const result = validateBrainRequest({
      id: '',
      tenantId: '',
      userId: '',
      prompt: '',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('reports specific field errors', () => {
    const result = validateBrainRequest({ ...valid, prompt: '' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('prompt'))).toBe(true);
  });

  it('returns a single error for non-object input', () => {
    const result = validateBrainRequest(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('validates optional context must be an object', () => {
    const result = validateBrainRequest({ ...valid, context: 'bad' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('context'))).toBe(true);
  });

  it('validates optional stream must be boolean', () => {
    const result = validateBrainRequest({ ...valid, stream: 'yes' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('stream'))).toBe(true);
  });
});

// ── validateTenantConfig ─────────────────────────────────────────────

describe('validateTenantConfig', () => {
  const settings = {
    timezone: 'UTC', locale: 'en-US', voiceEnabled: false,
    backupIntervalMinutes: 60, backupRetentionDays: 30,
    healingEnabled: true, learningEnabled: true,
  };

  const valid = {
    id: 'tenant-1',
    name: 'Tenant One',
    mode: 'single',
    brainProvider: 'openai',
    connectorProvider: 'google',
    createdAt: new Date(),
    updatedAt: new Date(),
    settings,
  };

  it('returns valid=true for a correct config', () => {
    const result = validateTenantConfig(valid);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('collects errors for multiple invalid fields', () => {
    const result = validateTenantConfig({
      ...valid,
      id: '',
      mode: 'enterprise',
      brainProvider: 'unknown-brain',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('reports error for invalid connectorProvider', () => {
    const result = validateTenantConfig({ ...valid, connectorProvider: 'slack' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('connectorProvider'))).toBe(true);
  });
});
