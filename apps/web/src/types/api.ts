/**
 * API response and domain types for the BOS web dashboard.
 * These mirror the backend shapes returned by the Fastify API.
 */

// ─── Health & System ─────────────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export type ServiceName =
  | 'brain'
  | 'postgres'
  | 'redis'
  | 'weaviate'
  | 'connector-microsoft'
  | 'connector-google'
  | 'voice'
  | 'backup';

export interface ServiceHealth {
  service: ServiceName;
  status: HealthStatus;
  message?: string;
  latencyMs?: number;
  checkedAt: string; // ISO string from API
}

export interface SystemHealth {
  overall: HealthStatus;
  services: ServiceHealth[];
  checkedAt: string;
}

// ─── Activity Feed ────────────────────────────────────────────────────────────

export type ActivityType =
  | 'voice_command'
  | 'email_processed'
  | 'calendar_event'
  | 'task_completed'
  | 'healing_action'
  | 'learning_update'
  | 'backup_completed'
  | 'connector_auth';

export interface ActivityItem {
  id: string;
  type: ActivityType;
  title: string;
  description?: string;
  timestamp: string;
  severity?: 'info' | 'warning' | 'error' | 'success';
}

// ─── Voice Devices ────────────────────────────────────────────────────────────

export type VoiceDeviceStatus = 'online' | 'offline' | 'error' | 'provisioning';

export interface VoiceDevice {
  id: string;
  name: string;
  room: string;
  status: VoiceDeviceStatus;
  ipAddress?: string;
  firmwareVersion?: string;
  wakeWord: string;
  lastActivity?: string;
  uptime?: number; // seconds
}

// ─── Brain ────────────────────────────────────────────────────────────────────

export type BrainProvider =
  | 'claude-code'
  | 'openai'
  | 'openrouter'
  | 'gemini'
  | 'openclaw'
  | 'custom';

export interface BrainCapabilities {
  canChat: boolean;
  canStream: boolean;
  canUseTools: boolean;
  canAccessMCP: boolean;
  canExecuteCode: boolean;
  canSpawnAgents: boolean;
  canMaintainMemory: boolean;
  canProcessVoice: boolean;
  canProcessImages: boolean;
  canProcessDocuments: boolean;
}

export interface BrainConfig {
  provider: BrainProvider;
  model?: string;
  endpoint?: string;
  capabilities: BrainCapabilities;
  fallbackProvider?: BrainProvider;
  status: HealthStatus;
  lastUsed?: string;
}

// ─── Connectors ───────────────────────────────────────────────────────────────

export type ConnectorProvider = 'microsoft' | 'google';

export type ConnectorService =
  | 'mail'
  | 'calendar'
  | 'tasks'
  | 'drive'
  | 'contacts'
  | 'chat';

export interface ConnectedAccount {
  id: string;
  provider: ConnectorProvider;
  accountLabel: string;
  email: string;
  scopes: string[];
  tokenExpiresAt: string;
  services: ConnectorServiceStatus[];
}

export interface ConnectorServiceStatus {
  service: ConnectorService;
  enabled: boolean;
  healthy: boolean;
  lastChecked: string;
  error?: string;
}

// ─── Learning ─────────────────────────────────────────────────────────────────

export type PreferenceCategory =
  | 'communication'
  | 'scheduling'
  | 'tasks'
  | 'files'
  | 'voice'
  | 'general';

export type PreferenceSource = 'explicit' | 'behavioral' | 'onboarding';

export interface OnboardingProgress {
  platform: string;
  label: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  percentComplete: number;
  itemsProcessed?: number;
  totalItems?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface LearnedPreference {
  id: string;
  category: PreferenceCategory;
  key: string;
  value: string;
  source: PreferenceSource;
  confidence: number; // 0-1
  createdAt: string;
  updatedAt: string;
}

export interface BehaviorPattern {
  id: string;
  pattern: string;
  description: string;
  observationCount: number;
  confidence: number;
  category: PreferenceCategory;
  lastObserved: string;
}

// ─── Self-Healing ─────────────────────────────────────────────────────────────

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatus = 'open' | 'in_progress' | 'resolved' | 'escalated';

export interface Incident {
  id: string;
  service: ServiceName;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  description: string;
  attempts: HealingAttempt[];
  playbookUsed?: string;
  resolvedAt?: string;
  createdAt: string;
}

export interface HealingAttempt {
  attemptNumber: number;
  action: string;
  result: 'success' | 'failure';
  notes?: string;
  timestamp: string;
}

export interface Playbook {
  id: string;
  failureSignature: string;
  service: ServiceName;
  severity: IncidentSeverity;
  diagnosisSteps: string[];
  fixSteps: string[];
  verification: string;
  successCount: number;
  lastUsed?: string;
  createdAt: string;
  createdFromIncident: string;
}

// ─── Backup ───────────────────────────────────────────────────────────────────

export type BackupDestination = 'git' | 's3' | 'both';
export type BackupStatus = 'idle' | 'running' | 'success' | 'failed';

export interface BackupState {
  status: BackupStatus;
  lastBackupAt?: string;
  lastBackupSize?: number; // bytes
  nextScheduledAt?: string;
  intervalMinutes: number;
  retentionDays: number;
  destination: BackupDestination;
  destinationStatus: {
    git?: { healthy: boolean; lastPushAt?: string; error?: string };
    s3?: { healthy: boolean; lastUploadAt?: string; error?: string };
  };
  history: BackupRecord[];
}

export interface BackupRecord {
  id: string;
  status: 'success' | 'failed';
  startedAt: string;
  completedAt?: string;
  sizeBytes?: number;
  destination: BackupDestination;
  error?: string;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export type TtsProvider = 'elevenlabs' | 'openai-tts' | 'piper';

export interface TenantSettings {
  id: string;
  name: string;
  timezone: string;
  locale: string;
  mode: 'single' | 'multi';
  voiceEnabled: boolean;
  backupIntervalMinutes: number;
  backupRetentionDays: number;
  healingEnabled: boolean;
  learningEnabled: boolean;
  ttsProvider: TtsProvider;
  ttsVoiceId?: string;
  wakeWord: string;
  notificationChannels: NotificationChannel[];
}

export interface NotificationChannel {
  type: 'slack' | 'push' | 'voice' | 'email';
  enabled: boolean;
  config?: Record<string, string>;
}

// ─── API Wrappers ─────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  error?: never;
}

export interface ApiError {
  data?: never;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResult<T> = ApiResponse<T> | ApiError;
