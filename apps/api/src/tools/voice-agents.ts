/**
 * Voice Agent tools — brain tool definitions for routing voice commands
 * to client agents via a single shared tmux session.
 *
 * Pattern: One tmux "voice-session" stays alive while voice mode is active.
 * Brain receives voice → identifies agent → cd to agent dir → fire CLI →
 * capture output → CLI exits → brain speaks response via TTS.
 * Voice OFF → kill the tmux session.
 */

import type { BrainTool } from '@boss/brain';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Agent Roster ──────────────────────────────────────────────────────────────

interface AgentEntry {
  dir: string;
  cli: 'claude' | 'gemini';
  description: string;
}

const AGENT_ROSTER: Record<string, AgentEntry> = {
  'industry rockstarr': {
    dir: '/home/tcntryprd/clients/01-industry-rockstarr',
    cli: 'gemini',
    description: 'Industry Rockstarr community',
  },
  'kane minkus': {
    dir: '/home/tcntryprd/clients/02-kane-minkus',
    cli: 'claude',
    description: 'Kane Minkus / IR + AI District founder',
  },
  'ai district': {
    dir: '/home/tcntryprd/clients/03-ai-district',
    cli: 'gemini',
    description: 'AI District consulting routing, Jess Shelley',
  },
  'douglas': {
    dir: '/home/tcntryprd/clients/04-douglas-estremadoyro',
    cli: 'claude',
    description: 'Douglas Estremadoyro / Magnussen Home Furnishings',
  },
  'john ballard': {
    dir: '/home/tcntryprd/clients/05-john-ballard',
    cli: 'claude',
    description: 'John Ballard / Craft Architecture',
  },
  'debbie': {
    dir: '/home/tcntryprd/clients/06-debbie-wooldridge',
    cli: 'claude',
    description: 'Debbie Wooldridge / TTC Innovations',
  },
  'jessy': {
    dir: '/home/tcntryprd/clients/07-jessy-trusted-ai-experts',
    cli: 'claude',
    description: 'Jessy / Trusted AI Experts',
  },
  'micazen': {
    dir: '/home/tcntryprd/clients/08-micazen-sharon',
    cli: 'claude',
    description: 'Micazen / Sharon, n8n workflows, Zoho to ARMS',
  },
  'sharon': {
    dir: '/home/tcntryprd/clients/08-micazen-sharon',
    cli: 'claude',
    description: 'Micazen / Sharon',
  },
  'lori': {
    dir: '/home/tcntryprd/clients/09-lori-zeoli',
    cli: 'claude',
    description: 'Lori Zeoli / xpLORIZE AI Advisors',
  },
  'pessy': {
    dir: '/home/tcntryprd/clients/10-chris-pessy',
    cli: 'claude',
    description: 'Chris Pessy / lead qualification',
  },
  'chris pessy': {
    dir: '/home/tcntryprd/clients/10-chris-pessy',
    cli: 'claude',
    description: 'Chris Pessy / lead qualification',
  },
  'eric': {
    dir: '/home/tcntryprd/clients/eric-bloom',
    cli: 'claude',
    description: 'Eric Bloom / GatorPixel AI mentee',
  },
  'berfelo': {
    dir: '/home/tcntryprd/clients/john-berfelo',
    cli: 'claude',
    description: 'John Berfelo / pro-bono collaborator',
  },
  'productions': {
    dir: '/home/tcntryprd/clients/sp-productions',
    cli: 'claude',
    description: 'SP Productions content pipeline',
  },
  'sp productions': {
    dir: '/home/tcntryprd/clients/sp-productions',
    cli: 'claude',
    description: 'SP Productions content pipeline',
  },
};

const ALIASES: Record<string, string> = {
  'ir': 'industry rockstarr',
  'rockstarr': 'industry rockstarr',
  'kane': 'kane minkus',
  'minkus': 'kane minkus',
  'district': 'ai district',
  'douglas e': 'douglas',
  'magnussen': 'douglas',
  'ballard': 'john ballard',
  'craft': 'john ballard',
  'debbie w': 'debbie',
  'wooldridge': 'debbie',
  'ttc': 'debbie',
  'trusted ai': 'jessy',
  'lori z': 'lori',
  'lori zeoli': 'lori',
  'xplorize': 'lori',
  'chris': 'chris pessy',
  'eric bloom': 'eric',
  'bloom': 'eric',
  'gatorpixel': 'eric',
  'john b': 'berfelo',
  'sp prod': 'productions',
  'content': 'productions',
};

function resolveAgent(name: string): AgentEntry | null {
  const n = name.toLowerCase().trim();
  if (AGENT_ROSTER[n]) return AGENT_ROSTER[n];
  const aliased = ALIASES[n];
  if (aliased && AGENT_ROSTER[aliased]) return AGENT_ROSTER[aliased];
  for (const [key, entry] of Object.entries(AGENT_ROSTER)) {
    if (key.startsWith(n) || key.includes(n)) return entry;
  }
  return null;
}

// ── Bridge Script ─────────────────────────────────────────────────────────────
const BRIDGE_SCRIPT = '/home/tcntryprd/boss-dev/scripts/voice-agent-bridge.sh';

// ── Tool Definitions ──────────────────────────────────────────────────────────

export const voiceRouteToAgentTool: BrainTool = {
  name: 'boss_voice_route_agent',
  description:
    'Route a voice command to a specific client agent. Use when the user addresses an agent ' +
    'by name (e.g., "Hey Productions, what stories are ready?", "Ask Debbie about the TTC proposal"). ' +
    'The CLI spins up in the agent\'s project directory, does the work, returns the response, then exits. ' +
    'Returns the agent\'s response text.',
  parameters: {
    type: 'object',
    properties: {
      agent_name: {
        type: 'string',
        description:
          'The agent name as spoken by the user. Examples: "productions", "debbie", "eric", "pessy", ' +
          '"douglas", "jessy", "lori", "kane minkus", "ai district", "industry rockstarr", "micazen", "berfelo".',
      },
      prompt: {
        type: 'string',
        description:
          'The question or task for the agent. Strip the agent name/greeting and pass just the actionable part. ' +
          'The agent will read its own CLAUDE.md for context. Prepend "Read CLAUDE.md and MEMORY.md for context. Then: " ' +
          'to the prompt so the agent knows its role.',
      },
    },
    required: ['agent_name', 'prompt'],
  },
};

export const voiceListAgentsTool: BrainTool = {
  name: 'boss_voice_list_agents',
  description:
    'List all available voice-routable agents. Use when the user asks "who can I talk to?" ' +
    'or "what agents are available?".',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const voiceNavigateTool: BrainTool = {
  name: 'boss_voice_navigate',
  description:
    'Navigate the BOS UI to a specific page. Use when the user asks to go somewhere ' +
    '(e.g., "go to calendar", "open CRM", "show me code", "switch to paperclip"). ' +
    'Returns a navigation instruction the frontend executes.',
  parameters: {
    type: 'object',
    properties: {
      route: {
        type: 'string',
        enum: ['/', '/calendar', '/paperclip', '/crm', '/code', '/oc', '/voice-devices'],
        description: 'The route path to navigate to.',
      },
      spoken_confirmation: {
        type: 'string',
        description: 'Brief spoken confirmation like "Switching to Calendar."',
      },
    },
    required: ['route', 'spoken_confirmation'],
  },
};

export const uiCommandTool: BrainTool = {
  name: 'boss_ui_command',
  description:
    'Trigger a voice-addressable action on the current page (click a button, ' +
    'open a panel, refresh, scroll, toggle, etc.) when the user asks for something ' +
    'that has to happen on the screen rather than via backend APIs. Prefer direct ' +
    'backend tools (e.g., boss_tasks_create) whenever they exist — only use this ' +
    'tool for UI-only actions or when the user explicitly asks to "click", "open", ' +
    '"refresh", "scroll", "show", "hide", etc. Returns a UI instruction the frontend ' +
    'executes against its command registry. If the target does not exist on the ' +
    'current page, the frontend will tell the user.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['click', 'toggle', 'open', 'close', 'refresh', 'scroll', 'focus', 'fill', 'custom'],
        description: 'The category of interaction. Use "custom" for anything that does not fit.',
      },
      target: {
        type: 'string',
        description:
          'The registry name of the UI element/action to invoke (e.g., "sidebar", ' +
          '"create_task_button", "page_top"). Keep lowercase_snake_case. If unsure, ' +
          'emit "help" as target to ask the frontend what is registered.',
      },
      args: {
        type: 'object',
        description:
          'Optional arguments (free-form JSON) the target callback may consume. ' +
          'For "fill", typically { value: "..." }. For "scroll", { to: "top" | "bottom" }.',
        additionalProperties: true,
      },
      spoken_confirmation: {
        type: 'string',
        description: 'Brief spoken confirmation like "Refreshing." or "Opening the sidebar."',
      },
    },
    required: ['action', 'target', 'spoken_confirmation'],
  },
};

export const ALL_VOICE_AGENT_TOOLS: BrainTool[] = [
  voiceRouteToAgentTool,
  voiceListAgentsTool,
  voiceNavigateTool,
  uiCommandTool,
];

// ── Tool Handlers ─────────────────────────────────────────────────────────────

export async function handleVoiceRouteAgent(
  args: Record<string, unknown>,
): Promise<string> {
  const agentName = String(args.agent_name ?? '');
  const prompt = String(args.prompt ?? '');

  if (!agentName) return 'No agent name provided.';
  if (!prompt) return 'No prompt provided for the agent.';

  const agent = resolveAgent(agentName);
  if (!agent) {
    const available = [...new Set(Object.values(AGENT_ROSTER).map(a => a.description))];
    return `Agent "${agentName}" not found. Available agents: ${available.join(', ')}`;
  }

  try {
    // voice-agent-bridge.sh <project-dir> <cli> <prompt>
    // One shared tmux session, cd to agent dir, fire CLI, capture, CLI exits
    const { stdout, stderr } = await execFileAsync(
      BRIDGE_SCRIPT,
      [agent.dir, agent.cli, prompt],
      {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: '/home/tcntryprd' },
      },
    );
    const output = stdout.trim() || stderr.trim();
    if (!output) return `${agent.description} agent processed your request but returned no output.`;
    return output;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('TIMEOUT') || msg.includes('timed out')) {
      return `${agent.description} agent is still working. You can follow up.`;
    }
    return `Error reaching ${agent.description} agent: ${msg}`;
  }
}

export async function handleVoiceListAgents(): Promise<string> {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(AGENT_ROSTER)) {
    if (seen.has(entry.dir)) continue;
    seen.add(entry.dir);
    lines.push(`- ${name}: ${entry.description} (${entry.cli})`);
  }
  return `Available voice agents:\n${lines.join('\n')}`;
}

export async function handleVoiceNavigate(
  args: Record<string, unknown>,
): Promise<string> {
  const confirmation = String(args.spoken_confirmation ?? 'Done.');
  return `__NAVIGATE__:${args.route ?? '/'}|${confirmation}`;
}

export async function handleUICommand(
  args: Record<string, unknown>,
): Promise<string> {
  // Return a sentinel the brain SSE emitter parses and forwards as
  // `event: ui_command`. The frontend's registry handles target resolution
  // and executes (or tells the user the target doesn't exist).
  const payload = {
    action: String(args.action ?? 'custom'),
    target: String(args.target ?? 'unknown'),
    args: (args.args && typeof args.args === 'object') ? args.args : {},
  };
  const confirmation = String(args.spoken_confirmation ?? 'Done.');
  return `__UI_COMMAND__:${JSON.stringify(payload)}|${confirmation}`;
}
