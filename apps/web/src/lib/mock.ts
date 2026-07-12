/**
 * Mock data for dashboard development.
 * Used when the API is unreachable (local dev without backend).
 * Exported for use in hooks that need fallback data.
 */

import type {
  SystemHealth,
  ActivityItem,
  VoiceDevice,
  BrainConfig,
  ConnectedAccount,
  OnboardingProgress,
  LearnedPreference,
  BehaviorPattern,
  Incident,
  Playbook,
  BackupState,
  TenantSettings,
} from '../types/api';

export const mockSystemHealth: SystemHealth = {
  overall: 'healthy',
  checkedAt: new Date().toISOString(),
  services: [
    { service: 'brain', status: 'healthy', latencyMs: 142, checkedAt: new Date().toISOString() },
    { service: 'postgres', status: 'healthy', latencyMs: 4, checkedAt: new Date().toISOString() },
    { service: 'redis', status: 'healthy', latencyMs: 1, checkedAt: new Date().toISOString() },
    { service: 'weaviate', status: 'healthy', latencyMs: 18, checkedAt: new Date().toISOString() },
    { service: 'connector-google', status: 'healthy', latencyMs: 89, checkedAt: new Date().toISOString() },
    { service: 'connector-microsoft', status: 'degraded', message: 'Token refresh pending', latencyMs: 340, checkedAt: new Date().toISOString() },
    { service: 'voice', status: 'healthy', latencyMs: 22, checkedAt: new Date().toISOString() },
    { service: 'backup', status: 'healthy', latencyMs: 5, checkedAt: new Date().toISOString() },
  ],
};

export const mockActivity: ActivityItem[] = [
  { id: '1', type: 'voice_command', title: 'Voice command processed', description: '"What\'s on my calendar tomorrow?"', timestamp: new Date(Date.now() - 2 * 60_000).toISOString(), severity: 'info' },
  { id: '2', type: 'email_processed', title: 'Email drafted and sent', description: 'Reply to Brad re: BodyShopConnect onboarding', timestamp: new Date(Date.now() - 8 * 60_000).toISOString(), severity: 'success' },
  { id: '3', type: 'healing_action', title: 'Self-healing triggered', description: 'M365 token refreshed automatically', timestamp: new Date(Date.now() - 15 * 60_000).toISOString(), severity: 'warning' },
  { id: '4', type: 'calendar_event', title: 'Meeting scheduled', description: 'Standup — 9:00 AM tomorrow', timestamp: new Date(Date.now() - 32 * 60_000).toISOString(), severity: 'info' },
  { id: '5', type: 'backup_completed', title: 'Backup completed', description: '4.2 MB — pushed to Git + S3', timestamp: new Date(Date.now() - 45 * 60_000).toISOString(), severity: 'success' },
  { id: '6', type: 'learning_update', title: 'Preference learned', description: 'Never schedule before 9 AM detected from correction', timestamp: new Date(Date.now() - 2 * 3600_000).toISOString(), severity: 'info' },
  { id: '7', type: 'task_completed', title: 'Task completed', description: 'Review Q1 contractor invoices', timestamp: new Date(Date.now() - 3 * 3600_000).toISOString(), severity: 'success' },
  { id: '8', type: 'voice_command', title: 'Voice command processed', description: '"Send the SOW to Brad"', timestamp: new Date(Date.now() - 4 * 3600_000).toISOString(), severity: 'info' },
];

export const mockVoiceDevices: VoiceDevice[] = [
  { id: 'vd-1', name: 'Office Satellite', room: 'Office', status: 'online', ipAddress: '192.168.1.101', firmwareVersion: '1.2.3', wakeWord: 'Hey BOS', lastActivity: new Date(Date.now() - 2 * 60_000).toISOString(), uptime: 86_400 * 3 },
  { id: 'vd-2', name: 'Living Room Satellite', room: 'Living Room', status: 'online', ipAddress: '192.168.1.102', firmwareVersion: '1.2.3', wakeWord: 'Hey BOS', lastActivity: new Date(Date.now() - 45 * 60_000).toISOString(), uptime: 86_400 * 3 },
  { id: 'vd-3', name: 'Garage Satellite', room: 'Garage', status: 'offline', ipAddress: '192.168.1.103', firmwareVersion: '1.2.1', wakeWord: 'Hey BOS', lastActivity: new Date(Date.now() - 6 * 3600_000).toISOString() },
  { id: 'vd-4', name: 'Bedroom Satellite', room: 'Bedroom', status: 'provisioning', ipAddress: '192.168.1.104', firmwareVersion: '1.2.3', wakeWord: 'Hey BOS' },
];

export const mockBrainConfig: BrainConfig = {
  provider: 'claude-code',
  model: 'claude-opus-4-6',
  capabilities: {
    canChat: true,
    canStream: true,
    canUseTools: true,
    canAccessMCP: true,
    canExecuteCode: true,
    canSpawnAgents: true,
    canMaintainMemory: true,
    canProcessVoice: true,
    canProcessImages: true,
    canProcessDocuments: true,
  },
  fallbackProvider: 'openai',
  status: 'healthy',
  lastUsed: new Date(Date.now() - 2 * 60_000).toISOString(),
};

export const mockConnectedAccounts: ConnectedAccount[] = [
  {
    id: 'acc-1',
    provider: 'google',
    accountLabel: 'Work',
    email: 'owner@example.com',
    scopes: ['gmail.read', 'gmail.send', 'calendar', 'drive', 'tasks', 'contacts'],
    tokenExpiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    services: [
      { service: 'mail', enabled: true, healthy: true, lastChecked: new Date().toISOString() },
      { service: 'calendar', enabled: true, healthy: true, lastChecked: new Date().toISOString() },
      { service: 'drive', enabled: true, healthy: true, lastChecked: new Date().toISOString() },
      { service: 'tasks', enabled: true, healthy: true, lastChecked: new Date().toISOString() },
      { service: 'contacts', enabled: true, healthy: true, lastChecked: new Date().toISOString() },
    ],
  },
  {
    id: 'acc-2',
    provider: 'microsoft',
    accountLabel: 'M365',
    email: 'ops@example.com',
    scopes: ['mail.read', 'mail.send', 'calendar', 'onedrive', 'tasks'],
    tokenExpiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
    services: [
      { service: 'mail', enabled: true, healthy: true, lastChecked: new Date().toISOString() },
      { service: 'calendar', enabled: true, healthy: false, lastChecked: new Date().toISOString(), error: 'Token refresh pending' },
      { service: 'drive', enabled: true, healthy: true, lastChecked: new Date().toISOString() },
      { service: 'tasks', enabled: true, healthy: true, lastChecked: new Date().toISOString() },
      { service: 'chat', enabled: false, healthy: false, lastChecked: new Date().toISOString() },
    ],
  },
];

export const mockOnboardingProgress: OnboardingProgress[] = [
  { platform: 'gmail', label: 'Gmail', status: 'complete', percentComplete: 100, itemsProcessed: 2847, totalItems: 2847, completedAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
  { platform: 'calendar', label: 'Google Calendar', status: 'complete', percentComplete: 100, itemsProcessed: 1204, totalItems: 1204, completedAt: new Date(Date.now() - 90 * 60_000).toISOString() },
  { platform: 'drive', label: 'Google Drive', status: 'running', percentComplete: 67, itemsProcessed: 804, totalItems: 1204, startedAt: new Date(Date.now() - 20 * 60_000).toISOString() },
  { platform: 'tasks', label: 'Tasks / To Do', status: 'pending', percentComplete: 0 },
];

export const mockPreferences: LearnedPreference[] = [
  { id: 'pref-1', category: 'scheduling', key: 'no_meetings_before', value: '9:00 AM', source: 'explicit', confidence: 1.0, createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(), updatedAt: new Date(Date.now() - 3 * 86400_000).toISOString() },
  { id: 'pref-2', category: 'communication', key: 'email_style', value: 'Direct and concise, no fluff', source: 'onboarding', confidence: 0.92, createdAt: new Date(Date.now() - 5 * 86400_000).toISOString(), updatedAt: new Date(Date.now() - 5 * 86400_000).toISOString() },
  { id: 'pref-3', category: 'communication', key: 'cold_sales_emails', value: 'Archive without reply', source: 'explicit', confidence: 1.0, createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(), updatedAt: new Date(Date.now() - 2 * 86400_000).toISOString() },
  { id: 'pref-4', category: 'scheduling', key: 'preferred_meeting_length', value: '30 minutes unless explicitly longer', source: 'behavioral', confidence: 0.85, createdAt: new Date(Date.now() - 7 * 86400_000).toISOString(), updatedAt: new Date(Date.now() - 1 * 86400_000).toISOString() },
  { id: 'pref-5', category: 'general', key: 'priority_contact', value: 'Flag all emails from Brad immediately', source: 'explicit', confidence: 1.0, createdAt: new Date(Date.now() - 1 * 86400_000).toISOString(), updatedAt: new Date(Date.now() - 1 * 86400_000).toISOString() },
  { id: 'pref-6', category: 'tasks', key: 'task_reminders', value: 'Morning summary at 8:45 AM', source: 'explicit', confidence: 1.0, createdAt: new Date(Date.now() - 4 * 86400_000).toISOString(), updatedAt: new Date(Date.now() - 4 * 86400_000).toISOString() },
];

export const mockBehaviorPatterns: BehaviorPattern[] = [
  { id: 'bp-1', pattern: 'peak_productivity', description: 'Most focused work happens 9 AM – 12 PM weekdays', observationCount: 42, confidence: 0.94, category: 'scheduling', lastObserved: new Date(Date.now() - 1 * 86400_000).toISOString() },
  { id: 'bp-2', pattern: 'email_batch_processing', description: 'Checks email 3x/day: ~9 AM, noon, ~4 PM', observationCount: 67, confidence: 0.88, category: 'communication', lastObserved: new Date(Date.now() - 2 * 3600_000).toISOString() },
  { id: 'bp-3', pattern: 'friday_cleanup', description: 'Reviews and closes tasks every Friday afternoon', observationCount: 18, confidence: 0.78, category: 'tasks', lastObserved: new Date(Date.now() - 2 * 86400_000).toISOString() },
  { id: 'bp-4', pattern: 'document_naming', description: 'Prefers YYYY-MM-DD prefix for project docs', observationCount: 34, confidence: 0.91, category: 'files', lastObserved: new Date(Date.now() - 3 * 86400_000).toISOString() },
];

export const mockIncidents: Incident[] = [
  {
    id: 'inc-1',
    service: 'connector-microsoft',
    severity: 'medium',
    status: 'resolved',
    title: 'M365 token expiry',
    description: 'OAuth access token expired before scheduled refresh',
    attempts: [
      { attemptNumber: 1, action: 'Attempted token refresh via stored refresh token', result: 'success', timestamp: new Date(Date.now() - 15 * 60_000).toISOString() },
    ],
    playbookUsed: 'pb-1',
    resolvedAt: new Date(Date.now() - 14 * 60_000).toISOString(),
    createdAt: new Date(Date.now() - 16 * 60_000).toISOString(),
  },
  {
    id: 'inc-2',
    service: 'redis',
    severity: 'low',
    status: 'resolved',
    title: 'Redis connection timeout',
    description: 'Single connection timed out during high load',
    attempts: [
      { attemptNumber: 1, action: 'Cleared connection pool and reconnected', result: 'success', timestamp: new Date(Date.now() - 2 * 86400_000).toISOString() },
    ],
    resolvedAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
    createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
  },
  {
    id: 'inc-3',
    service: 'voice',
    severity: 'low',
    status: 'open',
    title: 'Garage satellite offline',
    description: 'Voice PE in garage has not responded to ping for 6+ hours',
    attempts: [
      { attemptNumber: 1, action: 'Sent wake-on-LAN packet', result: 'failure', notes: 'Device did not respond', timestamp: new Date(Date.now() - 5 * 3600_000).toISOString() },
      { attemptNumber: 2, action: 'Attempted firmware restart via mDNS', result: 'failure', notes: 'Device not reachable on mDNS', timestamp: new Date(Date.now() - 4 * 3600_000).toISOString() },
    ],
    createdAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
  },
];

export const mockPlaybooks: Playbook[] = [
  {
    id: 'pb-1',
    failureSignature: 'oauth.*token.*expir',
    service: 'connector-microsoft',
    severity: 'medium',
    diagnosisSteps: ['Check token expiry timestamp', 'Verify refresh token is present', 'Test Microsoft Graph token endpoint'],
    fixSteps: ['Call /oauth2/v2.0/token with refresh_token grant', 'Store new access + refresh tokens', 'Re-verify connector health'],
    verification: 'GET /me from Graph API returns 200',
    successCount: 7,
    lastUsed: new Date(Date.now() - 15 * 60_000).toISOString(),
    createdAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
    createdFromIncident: 'inc-first',
  },
  {
    id: 'pb-2',
    failureSignature: 'redis.*connect.*timeout|redis.*ECONNREFUSED',
    service: 'redis',
    severity: 'medium',
    diagnosisSteps: ['Check Redis process status', 'Review connection pool stats', 'Check memory usage'],
    fixSteps: ['Flush idle connections from pool', 'Reconnect with fresh client', 'Run PING to verify'],
    verification: 'Redis PING returns PONG',
    successCount: 3,
    lastUsed: new Date(Date.now() - 2 * 86400_000).toISOString(),
    createdAt: new Date(Date.now() - 20 * 86400_000).toISOString(),
    createdFromIncident: 'inc-redis-1',
  },
  {
    id: 'pb-3',
    failureSignature: 'weaviate.*cluster.*unavailable',
    service: 'weaviate',
    severity: 'high',
    diagnosisSteps: ['Check Weaviate container status', 'Review Weaviate logs for OOM', 'Check disk space'],
    fixSteps: ['Restart Weaviate container', 'Wait for index reload', 'Run readiness check'],
    verification: 'GET /v1/.well-known/ready returns 200',
    successCount: 1,
    createdAt: new Date(Date.now() - 15 * 86400_000).toISOString(),
    createdFromIncident: 'inc-weaviate-1',
  },
];

export const mockBackupState: BackupState = {
  status: 'idle',
  lastBackupAt: new Date(Date.now() - 42 * 60_000).toISOString(),
  lastBackupSize: 4_294_967,
  nextScheduledAt: new Date(Date.now() + 18 * 60_000).toISOString(),
  intervalMinutes: 60,
  retentionDays: 30,
  destination: 'both',
  destinationStatus: {
    git: { healthy: true, lastPushAt: new Date(Date.now() - 42 * 60_000).toISOString() },
    s3: { healthy: true, lastUploadAt: new Date(Date.now() - 42 * 60_000).toISOString() },
  },
  history: [
    { id: 'bk-1', status: 'success', startedAt: new Date(Date.now() - 42 * 60_000).toISOString(), completedAt: new Date(Date.now() - 41 * 60_000).toISOString(), sizeBytes: 4_294_967, destination: 'both' },
    { id: 'bk-2', status: 'success', startedAt: new Date(Date.now() - 102 * 60_000).toISOString(), completedAt: new Date(Date.now() - 101 * 60_000).toISOString(), sizeBytes: 4_287_432, destination: 'both' },
    { id: 'bk-3', status: 'failed', startedAt: new Date(Date.now() - 162 * 60_000).toISOString(), destination: 'both', error: 'S3 upload timeout — retried on next cycle' },
    { id: 'bk-4', status: 'success', startedAt: new Date(Date.now() - 222 * 60_000).toISOString(), completedAt: new Date(Date.now() - 221 * 60_000).toISOString(), sizeBytes: 4_275_000, destination: 'both' },
    { id: 'bk-5', status: 'success', startedAt: new Date(Date.now() - 282 * 60_000).toISOString(), completedAt: new Date(Date.now() - 281 * 60_000).toISOString(), sizeBytes: 4_260_000, destination: 'both' },
  ],
};

export const mockSettings: TenantSettings = {
  id: 'tenant-kevin',
  name: 'Kevin Starr — Starr & Partners',
  timezone: 'America/New_York',
  locale: 'en-US',
  mode: 'single',
  voiceEnabled: true,
  backupIntervalMinutes: 60,
  backupRetentionDays: 30,
  healingEnabled: true,
  learningEnabled: true,
  ttsProvider: 'elevenlabs',
  ttsVoiceId: 'rachel',
  wakeWord: 'Hey BOS',
  notificationChannels: [
    { type: 'slack', enabled: true, config: { webhook: 'https://hooks.slack.com/...' } },
    { type: 'voice', enabled: true },
    { type: 'push', enabled: false },
    { type: 'email', enabled: false },
  ],
};
