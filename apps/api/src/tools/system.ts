/**
 * System monitoring tools — server info, updates, health, and restart management.
 *
 * These tools let BOS monitor the host system, check for updates,
 * and report on server health. Write operations (updates, restarts)
 * require admin trust tier.
 */

import type { BrainTool } from '@boss/brain';

export const sysInfoTool: BrainTool = {
  name: 'boss_sys_info',
  description:
    'Get server system information: hostname, OS, kernel, uptime, CPU, memory, disk usage, ' +
    'running Docker containers, and network interfaces.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const sysUpdatesTool: BrainTool = {
  name: 'boss_sys_updates',
  description:
    'Check for available system package updates (apt). Returns list of upgradable packages ' +
    'with current and available versions.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const sysDockerStatusTool: BrainTool = {
  name: 'boss_sys_docker',
  description:
    'Get status of all Docker containers on the server. Shows name, image, status, ports, ' +
    'uptime, and resource usage.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const sysServicesTool: BrainTool = {
  name: 'boss_sys_services',
  description:
    'List running systemd services, including BOS gateway, OpenClaw, and other user services.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const ALL_SYS_TOOLS: BrainTool[] = [
  sysInfoTool,
  sysUpdatesTool,
  sysDockerStatusTool,
  sysServicesTool,
];
