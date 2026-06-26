/**
 * Learning routes — /api/learning/*
 *
 *   GET    /profile             — the user's learned profile (communication style, patterns)
 *   GET    /preferences         — list preferences for the current user
 *   PUT    /preferences/:key    — upsert a preference (explicit)
 *   DELETE /preferences/:key    — remove a specific preference
 *   GET    /onboarding          — onboarding progress and next steps
 *   POST   /onboarding/complete — mark the current step complete and advance
 *
 * Phase 5: @boss/learning is a stub.  Routes maintain in-memory state keyed
 * by userId + tenantId.  Replace with Postgres-backed storage in Phase 5.
 *
 * Preference categories: communication | scheduling | tasks | files | voice | general
 * Preference sources:    explicit | behavioral | onboarding
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PreferenceCategory = 'communication' | 'scheduling' | 'tasks' | 'files' | 'voice' | 'general';
type PreferenceSource = 'explicit' | 'behavioral' | 'onboarding';

interface UserPreference {
  key: string;
  category: PreferenceCategory;
  value: string;
  source: PreferenceSource;
  confidence: number; // 0–1
  updatedAt: Date;
}

interface LearningProfile {
  userId: string;
  tenantId: string;
  communicationStyle: 'concise' | 'detailed' | 'structured' | 'casual';
  preferredResponseFormat: 'prose' | 'bullets' | 'tables';
  activeHours: { start: number; end: number }; // 0–23
  dominantTopics: string[];
  totalInteractions: number;
  profileUpdatedAt: Date;
}

type OnboardingStatus = 'not_started' | 'in_progress' | 'completed';

interface OnboardingProgress {
  userId: string;
  tenantId: string;
  status: OnboardingStatus;
  currentStep: number;
  totalSteps: number;
  steps: Array<{
    index: number;
    id: string;
    label: string;
    completed: boolean;
    completedAt?: Date;
  }>;
  startedAt?: Date;
  completedAt?: Date;
}

// ---------------------------------------------------------------------------
// In-memory stores (Phase 5: replace with Postgres)
// ---------------------------------------------------------------------------

const preferenceStore = new Map<string, Map<string, UserPreference>>();
const profileStore = new Map<string, LearningProfile>();
const onboardingStore = new Map<string, OnboardingProgress>();

const ONBOARDING_STEPS = [
  { id: 'welcome', label: 'Welcome to BOS' },
  { id: 'brain_select', label: 'Choose your AI brain' },
  { id: 'connect_suite', label: 'Connect your business suite (Google or Microsoft)' },
  { id: 'get_apps', label: 'Get mobile and desktop apps' },
  { id: 'voice_setup', label: 'Configure voice devices (optional)' },
  { id: 'ready', label: 'Setup complete' },
];

function getUserKey(userId: string, tenantId: string): string {
  return `${tenantId}:${userId}`;
}

function getOrCreateProfile(userId: string, tenantId: string): LearningProfile {
  const key = getUserKey(userId, tenantId);
  const existing = profileStore.get(key);
  if (existing) return existing;
  const profile: LearningProfile = {
    userId,
    tenantId,
    communicationStyle: 'concise',
    preferredResponseFormat: 'bullets',
    activeHours: { start: 8, end: 18 },
    dominantTopics: [],
    totalInteractions: 0,
    profileUpdatedAt: new Date(),
  };
  profileStore.set(key, profile);
  return profile;
}

function getOrCreateOnboarding(userId: string, tenantId: string): OnboardingProgress {
  const key = getUserKey(userId, tenantId);
  const existing = onboardingStore.get(key);
  if (existing) return existing;
  const progress: OnboardingProgress = {
    userId,
    tenantId,
    status: 'not_started',
    currentStep: 0,
    totalSteps: ONBOARDING_STEPS.length,
    steps: ONBOARDING_STEPS.map((s, i) => ({ ...s, index: i, completed: false })),
  };
  onboardingStore.set(key, progress);
  return progress;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const preferenceKeyParam = {
  type: 'object',
  required: ['key'],
  properties: { key: { type: 'string', minLength: 1, maxLength: 128 } },
} as const;

const upsertPreferenceBodySchema = {
  type: 'object',
  required: ['value', 'category'],
  properties: {
    category: {
      type: 'string',
      enum: ['communication', 'scheduling', 'tasks', 'files', 'voice', 'general'],
    },
    value: { type: 'string', minLength: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1, default: 1.0 },
  },
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Route handler interfaces
// ---------------------------------------------------------------------------

interface UpsertPrefBody {
  category: PreferenceCategory;
  value: string;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function learningRoutes(server: FastifyInstance) {
  /**
   * GET /api/learning/profile
   * Return the AI-inferred communication and behavioural profile for the
   * current user.  This is built automatically from interactions over time.
   *
   * Example response:
   *   { "communicationStyle": "concise", "activeHours": { "start": 8, "end": 18 }, ... }
   */
  server.get(
    '/profile',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              userId: { type: 'string' },
              communicationStyle: { type: 'string' },
              preferredResponseFormat: { type: 'string' },
              activeHours: {
                type: 'object',
                properties: {
                  start: { type: 'number' },
                  end: { type: 'number' },
                },
              },
              dominantTopics: { type: 'array', items: { type: 'string' } },
              totalInteractions: { type: 'number' },
              profileUpdatedAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.auth?.userId ?? 'anonymous';
      const tenantId = request.tenant?.tenantId ?? 'default';
      const profile = getOrCreateProfile(userId, tenantId);

      return reply.status(200).send({
        ...profile,
        profileUpdatedAt: profile.profileUpdatedAt.toISOString(),
      });
    },
  );

  /**
   * GET /api/learning/preferences
   * List all preferences for the current user, grouped by category.
   *
   * Query params: category (filter)
   *
   * Example response:
   *   [{ "key": "email.signature", "category": "communication", "value": "Regards", "source": "explicit" }]
   */
  server.get(
    '/preferences',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['communication', 'scheduling', 'tasks', 'files', 'voice', 'general'],
            },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                category: { type: 'string' },
                value: { type: 'string' },
                source: { type: 'string' },
                confidence: { type: 'number' },
                updatedAt: { type: 'string' },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.auth?.userId ?? 'anonymous';
      const tenantId = request.tenant?.tenantId ?? 'default';
      const qs = request.query as { category?: PreferenceCategory };
      const key = getUserKey(userId, tenantId);

      const userPrefs = preferenceStore.get(key) ?? new Map();
      let prefs = Array.from(userPrefs.values());

      if (qs.category) {
        prefs = prefs.filter((p) => p.category === qs.category);
      }

      return reply.status(200).send(
        prefs.map((p) => ({ ...p, updatedAt: p.updatedAt.toISOString() })),
      );
    },
  );

  /**
   * PUT /api/learning/preferences/:key
   * Upsert a single explicit preference.
   *
   * Example request:
   *   PUT /api/learning/preferences/email.signature
   *   { "category": "communication", "value": "Best, Kevin" }
   *
   * Example response:
   *   { "key": "email.signature", "category": "communication", "value": "Best, Kevin", ... }
   */
  server.put<{ Params: { key: string }; Body: UpsertPrefBody }>(
    '/preferences/:key',
    {
      schema: {
        params: preferenceKeyParam,
        body: upsertPreferenceBodySchema,
      },
    },
    async (
      request: FastifyRequest<{ Params: { key: string }; Body: UpsertPrefBody }>,
      reply: FastifyReply,
    ) => {
      const userId = request.auth?.userId ?? 'anonymous';
      const tenantId = request.tenant?.tenantId ?? 'default';
      const storeKey = getUserKey(userId, tenantId);

      if (!preferenceStore.has(storeKey)) {
        preferenceStore.set(storeKey, new Map());
      }

      const userPrefs = preferenceStore.get(storeKey)!;
      const pref: UserPreference = {
        key: request.params.key,
        category: request.body.category,
        value: request.body.value,
        source: 'explicit',
        confidence: request.body.confidence ?? 1.0,
        updatedAt: new Date(),
      };
      userPrefs.set(pref.key, pref);

      request.log.info({ userId, key: pref.key }, 'Preference upserted');
      return reply.status(200).send({ ...pref, updatedAt: pref.updatedAt.toISOString() });
    },
  );

  /**
   * DELETE /api/learning/preferences/:key
   * Remove a specific preference.
   */
  server.delete<{ Params: { key: string } }>(
    '/preferences/:key',
    { schema: { params: preferenceKeyParam } },
    async (
      request: FastifyRequest<{ Params: { key: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.auth?.userId ?? 'anonymous';
      const tenantId = request.tenant?.tenantId ?? 'default';
      const storeKey = getUserKey(userId, tenantId);
      const userPrefs = preferenceStore.get(storeKey);

      if (!userPrefs?.has(request.params.key)) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Preference '${request.params.key}' not found`,
        });
      }

      userPrefs.delete(request.params.key);
      request.log.info({ userId, key: request.params.key }, 'Preference removed');
      return reply.status(200).send({ message: 'Preference removed' });
    },
  );

  /**
   * GET /api/learning/onboarding
   * Return current onboarding progress and next actionable step.
   *
   * Example response:
   *   { "status": "in_progress", "currentStep": 1, "totalSteps": 5, "steps": [...] }
   */
  server.get(
    '/onboarding',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              currentStep: { type: 'number' },
              totalSteps: { type: 'number' },
              percentComplete: { type: 'number' },
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'number' },
                    id: { type: 'string' },
                    label: { type: 'string' },
                    completed: { type: 'boolean' },
                    completedAt: { type: 'string' },
                  },
                },
              },
              startedAt: { type: 'string' },
              completedAt: { type: 'string' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.auth?.userId ?? 'anonymous';
      const tenantId = request.tenant?.tenantId ?? 'default';
      const progress = getOrCreateOnboarding(userId, tenantId);
      const completedCount = progress.steps.filter((s) => s.completed).length;

      return reply.status(200).send({
        ...progress,
        percentComplete: Math.round((completedCount / progress.totalSteps) * 100),
        steps: progress.steps.map((s) => ({
          ...s,
          completedAt: s.completedAt?.toISOString(),
        })),
        startedAt: progress.startedAt?.toISOString(),
        completedAt: progress.completedAt?.toISOString(),
      });
    },
  );

  /**
   * POST /api/learning/onboarding/complete
   * Mark the current onboarding step as complete.
   * Advances to the next step; marks the entire onboarding complete when
   * all steps are done.
   *
   * Example response:
   *   { "status": "in_progress", "currentStep": 2, "nextStep": { "id": "voice_setup", ... } }
   */
  server.post(
    '/onboarding/complete',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            stepId: { type: 'string' }, // optional: explicitly name the step to complete
          },
          additionalProperties: false,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.auth?.userId ?? 'anonymous';
      const tenantId = request.tenant?.tenantId ?? 'default';
      const progress = getOrCreateOnboarding(userId, tenantId);
      const body = request.body as { stepId?: string };

      if (progress.status === 'completed') {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'Onboarding already completed',
        });
      }

      if (progress.status === 'not_started') {
        progress.status = 'in_progress';
        progress.startedAt = new Date();
      }

      // Find the step to complete
      const stepIndex = body.stepId
        ? progress.steps.findIndex((s) => s.id === body.stepId)
        : progress.currentStep;

      if (stepIndex < 0 || stepIndex >= progress.steps.length) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: `Step not found: ${body.stepId}`,
        });
      }

      progress.steps[stepIndex].completed = true;
      progress.steps[stepIndex].completedAt = new Date();

      // Advance currentStep to next incomplete step
      const nextIncomplete = progress.steps.findIndex((s) => !s.completed);
      if (nextIncomplete === -1) {
        progress.currentStep = progress.totalSteps;
        progress.status = 'completed';
        progress.completedAt = new Date();
      } else {
        progress.currentStep = nextIncomplete;
      }

      const nextStep = progress.steps[progress.currentStep] ?? null;
      request.log.info({ userId, stepIndex, status: progress.status }, 'Onboarding step completed');

      return reply.status(200).send({
        status: progress.status,
        currentStep: progress.currentStep,
        totalSteps: progress.totalSteps,
        percentComplete: Math.round(
          (progress.steps.filter((s) => s.completed).length / progress.totalSteps) * 100,
        ),
        nextStep: nextStep
          ? { id: nextStep.id, label: nextStep.label }
          : null,
        completedAt: progress.completedAt?.toISOString(),
      });
    },
  );
}
