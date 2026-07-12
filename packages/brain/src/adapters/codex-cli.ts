/**
 * Codex CLI adapter — BOS brain runtime over subscription-authenticated Codex.
 *
 * This adapter deliberately removes OPENAI_API_KEY from the subprocess
 * environment so Codex uses CODEX_HOME subscription auth instead of API billing.
 */

import { spawn } from 'node:child_process';
import type {
  AdapterStatus,
  BrainAdapter,
  BrainAdapterInfo,
  BrainRequest,
  BrainResponse,
  BrainStreamChunk,
} from '../types.js';
import { getTextContent } from '../types.js';

export interface CodexCliConfig {
  bin?: string;
  codexHome?: string;
  workspace?: string;
  model?: string;
  timeoutMs?: number;
  priority?: number;
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 300_000;

export class CodexCliAdapter implements BrainAdapter {
  readonly info: BrainAdapterInfo;
  private readonly bin: string;
  private readonly codexHome: string;
  private readonly workspace: string;
  private readonly model?: string;
  private readonly timeoutMs: number;

  constructor(config: CodexCliConfig = {}) {
    this.bin = config.bin ?? process.env.BOSS_BRAIN_CODEX_BIN ?? process.env.BOSS_GIO_BIN ?? 'codex';
    this.codexHome = config.codexHome ?? process.env.CODEX_HOME ?? '/home/boss/.codex';
    this.workspace = config.workspace
      ?? process.env.BOSS_BRAIN_WORKSPACE
      ?? process.env.BOSS_GIO_WORKSPACE
      ?? '/home/boss/gio';
    this.model = config.model ?? process.env.BOSS_BRAIN_CODEX_MODEL ?? process.env.CODEX_MODEL;
    this.timeoutMs = config.timeoutMs ?? Number(process.env.BOSS_BRAIN_CODEX_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

    this.info = {
      id: 'codex-cli',
      name: 'Codex CLI',
      capabilities: {
        canChat: true,
        canStream: true,
        canUseTools: true,
        canAccessMCP: true,
        canExecuteCode: true,
        canSpawnAgents: true,
        canMaintainMemory: true,
        canProcessVoice: false,
        canProcessImages: false,
        canProcessDocuments: true,
      },
      status: 'ready',
      priority: config.priority ?? 0,
    };
  }

  async execute(request: BrainRequest): Promise<BrainResponse> {
    const start = Date.now();
    const { text, usage } = await this.runCodex(this.buildPrompt(request), request);
    return {
      id: `codex-${Date.now()}`,
      requestId: request.id,
      adapterId: this.info.id,
      content: text || 'Codex CLI completed without a final message.',
      usage: usage.inputTokens || usage.outputTokens
        ? {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.inputTokens + usage.outputTokens,
          }
        : undefined,
      latencyMs: Date.now() - start,
    };
  }

  async *stream(request: BrainRequest): AsyncIterable<BrainStreamChunk> {
    const response = await this.execute(request);
    yield {
      requestId: response.requestId,
      adapterId: response.adapterId,
      delta: response.content,
      done: true,
      usage: response.usage,
    };
  }

  async healthCheck(): Promise<AdapterStatus> {
    return new Promise((resolve) => {
      const child = spawn(this.bin, ['--version'], {
        env: this.codexEnv(),
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        this.info.status = 'unavailable';
        resolve('unavailable');
      }, 5000);
      child.on('error', () => {
        clearTimeout(timer);
        this.info.status = 'unavailable';
        resolve('unavailable');
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.info.status = code === 0 ? 'ready' : 'unavailable';
        resolve(this.info.status);
      });
    });
  }

  private codexEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: this.codexHome,
      BOSS_EMPLOYEE_AGENT_ID: process.env.BOSS_EMPLOYEE_AGENT_ID ?? 'boss-brain',
      BOSS_EMPLOYEE_AGENT_NAME: process.env.BOSS_EMPLOYEE_AGENT_NAME ?? 'BOS Brain',
      BOSS_EMPLOYEE_AGENT_GRANTED_TOOLS: process.env.BOSS_EMPLOYEE_AGENT_GRANTED_TOOLS ?? '["*"]',
      BOSS_TENANT_ID: process.env.BOSS_TENANT_ID ?? 'default',
    };
    delete env.OPENAI_API_KEY;
    return env;
  }

  private buildPrompt(request: BrainRequest): string {
    const lines: string[] = [];
    if (request.context?.conversationHistory?.length) {
      lines.push('Conversation context:');
      for (const item of request.context.conversationHistory) {
        lines.push(`${item.role.toUpperCase()}: ${getTextContent(item.content)}`);
      }
      lines.push('');
    }
    if (request.tools?.length) {
      const toolNames = request.tools.map((tool) => tool.name);
      lines.push('BOS TOOL BRIDGE');
      lines.push('Use the local bridge for BOS tools when live business context is needed.');
      lines.push('List granted tools and schemas: node /app/apps/api/dist/employee-tool-cli.js list');
      lines.push('Run a granted tool: node /app/apps/api/dist/employee-tool-cli.js run <tool_name> \'<json_args>\'');
      lines.push(`Granted tool names: ${toolNames.join(', ')}`);
      lines.push('');
    }
    lines.push(request.prompt);
    return lines.join('\n');
  }

  private runCodex(
    prompt: string,
    request: BrainRequest,
  ): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    return new Promise((resolve, reject) => {
      const args = [
        'exec',
        '--json',
        '--ephemeral',
        '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-hook-trust',
        '--skip-git-repo-check',
        '--cd',
        this.workspace,
      ];
      const model = request.model && request.model !== 'codex-cli' && request.model !== 'codex'
        ? request.model
        : this.model;
      if (model) args.push('--model', model);
      args.push('-');

      const child = spawn(this.bin, args, {
        cwd: this.workspace,
        env: this.codexEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        reject(new Error(`Codex CLI timed out after ${this.timeoutMs}ms: ${stderrBuffer.slice(-1000)}`));
      }, this.timeoutMs);
      timer.unref();

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const event = JSON.parse(trimmed) as CodexEvent;
          if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
            text += event.item.text;
          }
          if (event.usage) {
            inputTokens = event.usage.input_tokens ?? inputTokens;
            outputTokens = event.usage.output_tokens ?? outputTokens;
          }
        } catch {
          // Codex --json emits JSONL; ignore incidental non-JSON text.
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });
      child.stderr?.on('data', (chunk: string) => { stderrBuffer += chunk; });
      child.stdin?.end(`${prompt}\n`);

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        if (code !== 0) {
          reject(new Error(`Codex CLI exited ${code}: ${stderrBuffer.slice(-2000)}`));
          return;
        }
        resolve({ text, usage: { inputTokens, outputTokens } });
      });
    });
  }
}
