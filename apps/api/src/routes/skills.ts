/**
 * Skills routes — /api/skills/*
 *
 * Exposes the BOS skill system over HTTP:
 *   GET  /api/skills           — list all skills with enabled status
 *   GET  /api/skills/:id       — get full skill detail including prompt content
 *   POST /api/skills/:id/enable  — enable a skill (persists to runtime_config)
 *   POST /api/skills/:id/disable — disable a skill (persists to runtime_config)
 *
 * Skills are loaded from disk at startup and cached in memory.
 * Enable/disable state is persisted to Postgres runtime_config.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadSkills, setSkillEnabled, isSkillEnabled } from '../skills/loader.js';
import { invalidateCache as invalidatePromptCache } from '../prompt-cache.js';

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const skillSummarySchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    version: { type: 'string' },
    author: { type: 'string' },
    category: { type: 'string' },
    triggers: { type: 'array', items: { type: 'string' } },
    enabled: { type: 'boolean' },
  },
} as const;

const skillDetailSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    version: { type: 'string' },
    author: { type: 'string' },
    category: { type: 'string' },
    triggers: { type: 'array', items: { type: 'string' } },
    enabled: { type: 'boolean' },
    promptContent: { type: 'string' },
  },
} as const;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export async function skillsRoutes(server: FastifyInstance) {
  /**
   * GET /api/skills
   * List all skills with their current enabled status.
   *
   * Example response:
   *   [{ "id": "project-management", "name": "Project Management", "enabled": true, ... }]
   */
  server.get(
    '/',
    {
      schema: {
        response: {
          200: {
            type: 'array',
            items: skillSummarySchema,
          },
        },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const skills = loadSkills();

      // Resolve live enabled status (accounts for runtime_config overrides)
      const results = skills.map((skill) => {
        const envKey = `SKILL_${skill.id.toUpperCase().replace(/-/g, '_')}_ENABLED`;
        const envVal = process.env[envKey];
        const enabled = envVal !== undefined ? envVal === 'true' : skill.enabled;
        return {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          version: skill.version,
          author: skill.author,
          category: skill.category,
          triggers: skill.triggers,
          enabled,
        };
      });

      return reply.status(200).send(results);
    },
  );

  /**
   * GET /api/skills/:id
   * Get full skill detail including prompt content.
   *
   * Example response:
   *   { "id": "email-triage", "name": "Email Triage", "promptContent": "...", "enabled": true }
   */
  server.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        response: {
          200: skillDetailSchema,
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const skill = loadSkills().find((s) => s.id === id);

      if (!skill) {
        return reply.status(404).send({ error: `Skill "${id}" not found` });
      }

      const envKey = `SKILL_${skill.id.toUpperCase().replace(/-/g, '_')}_ENABLED`;
      const envVal = process.env[envKey];
      const enabled = envVal !== undefined ? envVal === 'true' : skill.enabled;

      return reply.status(200).send({ ...skill, enabled });
    },
  );

  /**
   * POST /api/skills/:id/enable
   * Enable a skill. Persists to runtime_config in Postgres.
   *
   * Example response:
   *   { "id": "project-management", "enabled": true }
   */
  server.post<{ Params: { id: string } }>(
    '/:id/enable',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              enabled: { type: 'boolean' },
            },
          },
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const skill = loadSkills().find((s) => s.id === id);

      if (!skill) {
        return reply.status(404).send({ error: `Skill "${id}" not found` });
      }

      try {
        await setSkillEnabled(id, true);
      } catch (err) {
        request.log.warn({ err, skillId: id }, 'skills/enable: failed to persist to Postgres — in-memory only');
      }

      // Invalidate the static prompt cache so the next request rebuilds with
      // the updated skills set.
      invalidatePromptCache();

      request.log.info({ skillId: id, userId: request.auth?.userId }, 'skill enabled');
      return reply.status(200).send({ id, enabled: true });
    },
  );

  /**
   * POST /api/skills/:id/disable
   * Disable a skill. Persists to runtime_config in Postgres.
   *
   * Example response:
   *   { "id": "project-management", "enabled": false }
   */
  server.post<{ Params: { id: string } }>(
    '/:id/disable',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              enabled: { type: 'boolean' },
            },
          },
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      const skill = loadSkills().find((s) => s.id === id);

      if (!skill) {
        return reply.status(404).send({ error: `Skill "${id}" not found` });
      }

      try {
        await setSkillEnabled(id, false);
      } catch (err) {
        request.log.warn({ err, skillId: id }, 'skills/disable: failed to persist to Postgres — in-memory only');
      }

      // Invalidate the static prompt cache so the next request rebuilds with
      // the updated skills set.
      invalidatePromptCache();

      request.log.info({ skillId: id, userId: request.auth?.userId }, 'skill disabled');
      return reply.status(200).send({ id, enabled: false });
    },
  );
}
