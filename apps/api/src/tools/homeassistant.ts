/**
 * Home Assistant tool definitions for BOS brain tool calling.
 *
 * These are the BrainTool descriptors the brain receives so it knows what
 * Home Assistant APIs it can invoke and what parameters each call requires.
 * Execution logic lives in executor.ts.
 *
 * HA runs at http://localhost:8123 from the host, or http://host.docker.internal:8123
 * from inside Docker containers. Auth uses a long-lived access token via HA_ACCESS_TOKEN.
 *
 * Entity IDs follow the pattern: {domain}.{object_id}
 * Examples: light.living_room, switch.garage_door, automation.morning_routine
 */

import type { BrainTool } from '@boss/brain';

// ── Device / entity listing ───────────────────────────────────────────────────

export const haListDevicesTool: BrainTool = {
  name: 'boss_ha_list_devices',
  description:
    'List all Home Assistant devices and entities with their current state. ' +
    'Returns a formatted summary grouped by domain (lights, switches, sensors, etc.). ' +
    'Use this to discover available entities before calling other HA tools.',
  parameters: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description:
          'Optional domain filter to narrow results. ' +
          'Examples: "light", "switch", "sensor", "binary_sensor", "climate", "media_player". ' +
          'Omit to return all entities.',
      },
    },
    required: [],
  },
};

// ── State read ────────────────────────────────────────────────────────────────

export const haGetStateTool: BrainTool = {
  name: 'boss_ha_get_state',
  description:
    'Get the current state and attributes of a specific Home Assistant entity. ' +
    'Returns a human-readable summary including state value and key attributes ' +
    'like brightness, temperature, battery level, etc.',
  parameters: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        description:
          'The Home Assistant entity ID to query. ' +
          'Format: {domain}.{object_id}, e.g. "light.living_room", "switch.garage_door", "sensor.outdoor_temperature".',
      },
    },
    required: ['entity_id'],
  },
};

// ── Power control ─────────────────────────────────────────────────────────────

export const haTurnOnTool: BrainTool = {
  name: 'boss_ha_turn_on',
  description:
    'Turn on a Home Assistant device — works for lights, switches, fans, media players, and any entity that supports the turn_on service. ' +
    'Returns confirmation with the entity name.',
  parameters: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        description:
          'The entity ID to turn on. ' +
          'Format: {domain}.{object_id}, e.g. "light.kitchen", "switch.outdoor_outlet".',
      },
    },
    required: ['entity_id'],
  },
};

export const haTurnOffTool: BrainTool = {
  name: 'boss_ha_turn_off',
  description:
    'Turn off a Home Assistant device — works for lights, switches, fans, media players, and any entity that supports the turn_off service. ' +
    'Returns confirmation with the entity name.',
  parameters: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        description:
          'The entity ID to turn off. ' +
          'Format: {domain}.{object_id}, e.g. "light.bedroom", "switch.coffee_maker".',
      },
    },
    required: ['entity_id'],
  },
};

// ── Light brightness ──────────────────────────────────────────────────────────

export const haSetBrightnessTool: BrainTool = {
  name: 'boss_ha_set_brightness',
  description:
    'Set the brightness of a light in Home Assistant. ' +
    'Also turns the light on if it is currently off. ' +
    'Returns confirmation with the entity name and new brightness percentage.',
  parameters: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        description:
          'The light entity ID to adjust. ' +
          'Must be a light domain entity, e.g. "light.living_room", "light.desk_lamp".',
      },
      brightness_pct: {
        type: 'number',
        description:
          'Brightness as a percentage from 1 to 100. ' +
          'Example: 50 sets the light to half brightness.',
      },
    },
    required: ['entity_id', 'brightness_pct'],
  },
};

// ── Automation trigger ────────────────────────────────────────────────────────

export const haRunAutomationTool: BrainTool = {
  name: 'boss_ha_run_automation',
  description:
    'Trigger a Home Assistant automation to run immediately, regardless of its normal trigger conditions. ' +
    'Returns confirmation with the automation name.',
  parameters: {
    type: 'object',
    properties: {
      entity_id: {
        type: 'string',
        description:
          'The automation entity ID to trigger. ' +
          'Must be an automation domain entity, e.g. "automation.morning_routine", "automation.lock_doors_at_night".',
      },
    },
    required: ['entity_id'],
  },
};

// ── Full export lists ─────────────────────────────────────────────────────────

// READ-ONLY tools — safe for autonomous use (Confidence Tier 1)
export const READONLY_HA_TOOLS: BrainTool[] = [
  haListDevicesTool,
  haGetStateTool,
];

// WRITE tools — require explicit user request (Confidence Tier 2+)
export const WRITE_HA_TOOLS: BrainTool[] = [
  haTurnOnTool,
  haTurnOffTool,
  haSetBrightnessTool,
  haRunAutomationTool,
];

// Full tool set — the confidence engine gates autonomous write actions.
export const ALL_HA_TOOLS: BrainTool[] = [...READONLY_HA_TOOLS, ...WRITE_HA_TOOLS];
