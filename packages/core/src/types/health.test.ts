/**
 * Unit tests — @boss/core health types
 */

import { describe, it, expect } from 'vitest';
import type {
  HealthCheckResult,
  SystemHealth,
  HealthStatus,
  ServiceName,
  Playbook,
  PlaybookSeverity,
} from './health.js';

describe('HealthStatus values', () => {
  it('accepts all defined status strings', () => {
    const statuses: HealthStatus[] = ['healthy', 'degraded', 'unhealthy', 'unknown'];
    expect(statuses).toHaveLength(4);
  });
});

describe('ServiceName values', () => {
  it('covers all required services in the system', () => {
    const services: ServiceName[] = [
      'brain',
      'postgres',
      'redis',
      'weaviate',
      'connector-microsoft',
      'connector-google',
      'voice',
      'backup',
    ];
    expect(services).toHaveLength(8);
  });
});

describe('HealthCheckResult', () => {
  it('constructs a healthy result', () => {
    const result: HealthCheckResult = {
      service: 'postgres',
      status: 'healthy',
      latencyMs: 5,
      checkedAt: new Date(),
    };

    expect(result.service).toBe('postgres');
    expect(result.status).toBe('healthy');
    expect(result.latencyMs).toBe(5);
  });

  it('constructs an unhealthy result with error message', () => {
    const result: HealthCheckResult = {
      service: 'redis',
      status: 'unhealthy',
      message: 'Connection refused on port 6379',
      checkedAt: new Date(),
    };

    expect(result.status).toBe('unhealthy');
    expect(result.message).toBeDefined();
  });
});

describe('SystemHealth', () => {
  it('aggregates service results under an overall status', () => {
    const now = new Date();
    const health: SystemHealth = {
      overall: 'healthy',
      services: [
        { service: 'postgres', status: 'healthy', checkedAt: now },
        { service: 'redis', status: 'healthy', checkedAt: now },
        { service: 'brain', status: 'healthy', checkedAt: now },
      ],
      checkedAt: now,
    };

    expect(health.overall).toBe('healthy');
    expect(health.services).toHaveLength(3);
  });

  it('degrades overall when any service is degraded', () => {
    const now = new Date();
    const services: HealthCheckResult[] = [
      { service: 'postgres', status: 'healthy', checkedAt: now },
      { service: 'redis', status: 'degraded', checkedAt: now },
    ];

    const overall: HealthStatus = services.some((s) => s.status === 'unhealthy')
      ? 'unhealthy'
      : services.some((s) => s.status === 'degraded')
        ? 'degraded'
        : 'healthy';

    const health: SystemHealth = { overall, services, checkedAt: now };
    expect(health.overall).toBe('degraded');
  });

  it('becomes unhealthy when any service is unhealthy', () => {
    const now = new Date();
    const services: HealthCheckResult[] = [
      { service: 'postgres', status: 'healthy', checkedAt: now },
      { service: 'brain', status: 'unhealthy', checkedAt: now },
    ];

    const overall: HealthStatus = services.some((s) => s.status === 'unhealthy')
      ? 'unhealthy'
      : 'healthy';

    expect(overall).toBe('unhealthy');
  });
});

describe('Playbook', () => {
  it('constructs a valid playbook with all required fields', () => {
    const playbook: Playbook = {
      id: 'pb-001',
      failureSignature: 'ECONNREFUSED.*:5432',
      service: 'postgres',
      severity: 'high',
      diagnosisSteps: ['Check if postgres container is running', 'Check pg logs'],
      fixSteps: ['docker restart postgres', 'Verify env POSTGRES_PASSWORD'],
      verification: 'Run SELECT 1; returns row',
      successCount: 3,
      lastUsed: new Date(),
      createdFromIncident: 'incident-2026-03-01',
    };

    expect(playbook.service).toBe('postgres');
    expect(playbook.severity).toBe('high');
    expect(playbook.diagnosisSteps).toHaveLength(2);
    expect(playbook.fixSteps).toHaveLength(2);
    expect(playbook.successCount).toBe(3);
  });

  it('supports all severity levels', () => {
    const severities: PlaybookSeverity[] = ['low', 'medium', 'high', 'critical'];
    expect(severities).toHaveLength(4);

    severities.forEach((severity) => {
      const pb: Playbook = {
        id: `pb-${severity}`,
        failureSignature: 'test',
        service: 'brain',
        severity,
        diagnosisSteps: [],
        fixSteps: [],
        verification: 'ok',
        successCount: 0,
        lastUsed: new Date(),
        createdFromIncident: 'inc-001',
      };
      expect(pb.severity).toBe(severity);
    });
  });
});
