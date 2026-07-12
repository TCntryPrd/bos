/**
 * Health check types for the self-healing engine.
 */

export type ServiceName =
  | 'brain'
  | 'postgres'
  | 'redis'
  | 'weaviate'
  | 'connector-microsoft'
  | 'connector-google'
  | 'voice'
  | 'backup';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface HealthCheckResult {
  service: ServiceName;
  status: HealthStatus;
  message?: string;
  latencyMs?: number;
  checkedAt: Date;
}

export interface SystemHealth {
  overall: HealthStatus;
  services: HealthCheckResult[];
  checkedAt: Date;
}

export type PlaybookSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Playbook {
  id: string;
  failureSignature: string;
  service: ServiceName;
  severity: PlaybookSeverity;
  diagnosisSteps: string[];
  fixSteps: string[];
  verification: string;
  successCount: number;
  lastUsed: Date;
  createdFromIncident: string;
}
