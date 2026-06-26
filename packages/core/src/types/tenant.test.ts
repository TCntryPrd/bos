/**
 * Unit tests — @boss/core tenant types
 */

import { describe, it, expect } from 'vitest';
import type { TenantConfig, TenantMode, TenantSettings, TenantContext } from './tenant.js';

describe('TenantMode', () => {
  it('accepts single and multi modes', () => {
    const single: TenantMode = 'single';
    const multi: TenantMode = 'multi';

    expect(single).toBe('single');
    expect(multi).toBe('multi');
  });
});

describe('TenantSettings', () => {
  it('holds all configuration knobs', () => {
    const settings: TenantSettings = {
      timezone: 'America/New_York',
      locale: 'en-US',
      voiceEnabled: true,
      backupIntervalMinutes: 60,
      backupRetentionDays: 30,
      healingEnabled: true,
      learningEnabled: true,
    };

    expect(settings.timezone).toBe('America/New_York');
    expect(settings.backupIntervalMinutes).toBe(60);
    expect(settings.backupRetentionDays).toBe(30);
    expect(settings.healingEnabled).toBe(true);
  });

  it('allows voice to be disabled independently', () => {
    const settings: TenantSettings = {
      timezone: 'UTC',
      locale: 'en-US',
      voiceEnabled: false,
      backupIntervalMinutes: 30,
      backupRetentionDays: 15,
      healingEnabled: true,
      learningEnabled: false,
    };

    expect(settings.voiceEnabled).toBe(false);
    expect(settings.learningEnabled).toBe(false);
  });
});

describe('TenantConfig', () => {
  it('constructs a complete single-tenant config', () => {
    const now = new Date();
    const config: TenantConfig = {
      id: 'kevin-home',
      name: 'Kevin Home',
      mode: 'single',
      brainProvider: 'claude-code',
      connectorProvider: 'google',
      createdAt: now,
      updatedAt: now,
      settings: {
        timezone: 'America/New_York',
        locale: 'en-US',
        voiceEnabled: true,
        backupIntervalMinutes: 60,
        backupRetentionDays: 30,
        healingEnabled: true,
        learningEnabled: true,
      },
    };

    expect(config.id).toBe('kevin-home');
    expect(config.mode).toBe('single');
    expect(config.brainProvider).toBe('claude-code');
    expect(config.connectorProvider).toBe('google');
  });

  it('constructs a multi-tenant config with microsoft connector', () => {
    const now = new Date();
    const config: TenantConfig = {
      id: 'bsc-brad',
      name: 'BodyShopConnect Brad',
      mode: 'multi',
      brainProvider: 'openai',
      connectorProvider: 'microsoft',
      createdAt: now,
      updatedAt: now,
      settings: {
        timezone: 'America/Chicago',
        locale: 'en-US',
        voiceEnabled: false,
        backupIntervalMinutes: 30,
        backupRetentionDays: 15,
        healingEnabled: true,
        learningEnabled: true,
      },
    };

    expect(config.mode).toBe('multi');
    expect(config.brainProvider).toBe('openai');
    expect(config.connectorProvider).toBe('microsoft');
  });
});

describe('TenantContext', () => {
  it('links a tenantId and userId to a full config', () => {
    const now = new Date();
    const context: TenantContext = {
      tenantId: 'tenant-01',
      userId: 'user-01',
      config: {
        id: 'tenant-01',
        name: 'Tenant One',
        mode: 'single',
        brainProvider: 'gemini',
        connectorProvider: 'google',
        createdAt: now,
        updatedAt: now,
        settings: {
          timezone: 'UTC',
          locale: 'en-US',
          voiceEnabled: false,
          backupIntervalMinutes: 60,
          backupRetentionDays: 30,
          healingEnabled: false,
          learningEnabled: false,
        },
      },
    };

    expect(context.tenantId).toBe('tenant-01');
    expect(context.userId).toBe('user-01');
    expect(context.config.brainProvider).toBe('gemini');
  });
});
