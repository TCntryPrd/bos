/**
 * Internal CLI bridge for Codex-backed Employee Agents.
 *
 * Codex CLI runs as a subscription-authenticated subprocess, not as an
 * OpenAI/OpenRouter function-calling adapter. This bridge gives that subprocess
 * a narrow way to list and execute only the BOS tools granted to the current
 * Employee Agent run.
 */

import { initDb, closeDb } from './db.js';
import { executeTool, getAvailableTools } from './tools/index.js';

function parseGranted(): Set<string> {
  const raw = process.env.BOSS_EMPLOYEE_AGENT_GRANTED_TOOLS || '[]';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((v) => String(v)).filter(Boolean));
  } catch {
    return new Set();
  }
}

function ensureDb(): void {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL is not configured');
  initDb(url);
}

async function listTools(granted: Set<string>): Promise<void> {
  const tenantId = process.env.BOSS_TENANT_ID || 'default';
  const tools = await getAvailableTools(tenantId, 'admin');
  const filtered = granted.has('*')
    ? tools
    : tools.filter((tool) => granted.has(tool.name));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    agent: process.env.BOSS_EMPLOYEE_AGENT_NAME || null,
    tools: filtered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  }, null, 2)}\n`);
}

async function runTool(granted: Set<string>, toolName: string | undefined, argsJson: string | undefined): Promise<void> {
  if (!toolName) throw new Error('Usage: employee-tool-cli run <tool_name> <json_args>');
  if (!granted.has('*') && !granted.has(toolName)) {
    throw new Error(`Tool "${toolName}" is not granted to this Employee Agent run`);
  }
  let args: Record<string, unknown> = {};
  if (argsJson) {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('json_args must be a JSON object');
    }
    args = parsed as Record<string, unknown>;
  }
  const tenantId = process.env.BOSS_TENANT_ID || 'default';
  const result = await executeTool(toolName, args, {
    tenantId,
    userId: 'employee-agent',
    agentName: process.env.BOSS_EMPLOYEE_AGENT_NAME || 'Employee Agent',
    autonomous: true,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, tool: toolName, result }, null, 2)}\n`);
}

async function main(): Promise<void> {
  ensureDb();
  const granted = parseGranted();
  const [cmd, toolName, argsJson] = process.argv.slice(2);
  if (cmd === 'list') {
    await listTools(granted);
    return;
  }
  if (cmd === 'run') {
    await runTool(granted, toolName, argsJson);
    return;
  }
  throw new Error('Usage: employee-tool-cli <list | run <tool_name> <json_args>>');
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    await closeDb().catch(() => undefined);
    process.exitCode = 1;
  });
