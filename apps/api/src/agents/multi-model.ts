/**
 * multi-model.ts
 *
 * Provider-agnostic LLM dispatcher. Routes a prompt to the right
 * provider by model ID prefix. Reads per-rascal config from
 * ~/sp-hub/config/rascals/<handle>.json (BOS handoff v2.1
 * sections 4.1 + 4.2) to pick a model by task type.
 *
 * Use cases:
 *   - Cron-driven morning_check, summarize: pick the cheap tier
 *   - Code generation tasks: pick Codex / GPT
 *   - Heavy reasoning: pick Opus
 *   - Default chat: stays on Claude tmux path (rascal-chat.ts), not
 *     this dispatcher
 *
 * Keys come from runtime_config (loaded into process.env at boot):
 *   CLAUDE_API_KEY_DIRECT  Anthropic direct API (sk-ant-api03)
 *   OPENAI_API_KEY         OpenAI / Codex
 *   GROK_API_KEY           xAI
 *   GEMINI_API_KEY         Google AI Studio
 *   GEMINI_API_KEY_BACKUP_1, _2  fallbacks if main is rate-limited
 *
 * Native Node 22 fetch only, no provider SDKs needed.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DispatchOpts {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface DispatchResult {
  text: string;
  provider: 'anthropic' | 'openai' | 'xai' | 'google';
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
}

export type Provider = 'anthropic' | 'openai' | 'xai' | 'google';

export function providerFor(modelId: string): Provider {
  const m = modelId.toLowerCase();
  if (m.startsWith('claude-')) return 'anthropic';
  if (m.startsWith('grok-')) return 'xai';
  if (m.startsWith('gemini-')) return 'google';
  if (m.startsWith('gpt-') || m.startsWith('o1-') || m.startsWith('o3-') || m.startsWith('codex')) {
    return 'openai';
  }
  throw new Error(`unknown model id (no provider mapping): ${modelId}`);
}

function keyFor(provider: Provider): string {
  switch (provider) {
    case 'anthropic': {
      const k = process.env.CLAUDE_API_KEY_DIRECT;
      if (!k) throw new Error('CLAUDE_API_KEY_DIRECT not set in runtime_config');
      return k;
    }
    case 'openai': {
      const k = process.env.OPENAI_API_KEY;
      if (!k) throw new Error('OPENAI_API_KEY not set in runtime_config');
      return k;
    }
    case 'xai': {
      const k = process.env.GROK_API_KEY;
      if (!k) throw new Error('GROK_API_KEY not set in runtime_config');
      return k;
    }
    case 'google': {
      const k = process.env.GEMINI_API_KEY;
      if (!k) throw new Error('GEMINI_API_KEY not set in runtime_config');
      return k;
    }
  }
}

async function fetchJSON(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const bodyText = await res.text();
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}: ${bodyText.slice(0, 400)}`);
    }
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new Error(`non-JSON response: ${bodyText.slice(0, 400)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---- Anthropic (Claude direct API) -----------------------------------------

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

async function dispatchAnthropic(model: string, prompt: string, opts: DispatchOpts): Promise<DispatchResult> {
  const start = Date.now();
  const body = {
    model,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: opts.temperature,
    system: opts.system,
    messages: [{ role: 'user', content: prompt }],
  };
  const raw = (await fetchJSON('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': keyFor('anthropic'),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, opts.timeoutMs ?? 60_000)) as AnthropicResponse;
  const text = (raw.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  return {
    text,
    provider: 'anthropic',
    model,
    tokensIn: raw.usage?.input_tokens ?? null,
    tokensOut: raw.usage?.output_tokens ?? null,
    durationMs: Date.now() - start,
  };
}

// ---- OpenAI-compatible (OpenAI + xAI) --------------------------------------

interface ChatCompletionsResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

async function dispatchChatCompletions(
  endpoint: string,
  model: string,
  prompt: string,
  opts: DispatchOpts,
  provider: 'openai' | 'xai',
): Promise<DispatchResult> {
  const start = Date.now();
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: prompt });
  const body: Record<string, unknown> = {
    model,
    messages,
  };
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  const raw = (await fetchJSON(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${keyFor(provider)}`,
    },
    body: JSON.stringify(body),
  }, opts.timeoutMs ?? 60_000)) as ChatCompletionsResponse;
  return {
    text: raw.choices?.[0]?.message?.content ?? '',
    provider,
    model,
    tokensIn: raw.usage?.prompt_tokens ?? null,
    tokensOut: raw.usage?.completion_tokens ?? null,
    durationMs: Date.now() - start,
  };
}

// ---- Google AI Studio (Gemini) ---------------------------------------------

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

async function dispatchGemini(model: string, prompt: string, opts: DispatchOpts): Promise<DispatchResult> {
  const start = Date.now();
  const key = keyFor('google');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  };
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }
  const cfg: Record<string, unknown> = {};
  if (opts.maxTokens !== undefined) cfg.maxOutputTokens = opts.maxTokens;
  if (opts.temperature !== undefined) cfg.temperature = opts.temperature;
  if (Object.keys(cfg).length > 0) body.generationConfig = cfg;

  const raw = (await fetchJSON(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, opts.timeoutMs ?? 60_000)) as GeminiResponse;

  const text = (raw.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('');
  return {
    text,
    provider: 'google',
    model,
    tokensIn: raw.usageMetadata?.promptTokenCount ?? null,
    tokensOut: raw.usageMetadata?.candidatesTokenCount ?? null,
    durationMs: Date.now() - start,
  };
}

// ---- Top-level dispatch ----------------------------------------------------

export async function dispatch(modelId: string, prompt: string, opts: DispatchOpts = {}): Promise<DispatchResult> {
  const provider = providerFor(modelId);
  switch (provider) {
    case 'anthropic':
      return dispatchAnthropic(modelId, prompt, opts);
    case 'openai':
      return dispatchChatCompletions('https://api.openai.com/v1/chat/completions', modelId, prompt, opts, 'openai');
    case 'xai':
      return dispatchChatCompletions('https://api.x.ai/v1/chat/completions', modelId, prompt, opts, 'xai');
    case 'google':
      return dispatchGemini(modelId, prompt, opts);
  }
}

// ---- Rascal config loader --------------------------------------------------

export interface RascalConfig {
  name: string;
  handle: string;
  kind: 'rascal' | 'outsider';
  client?: string | null;
  client_contact?: string | null;
  role?: string;
  primary_model: string;
  fallback_model: string;
  heavy_model?: string;
  task_overrides: Record<string, string>;
  project_dir: string;
  memory_path: string;
  skills_path: string;
  context_path?: string;
  clients_path?: string;
}

const CONFIG_ROOT = process.env.BOSS_CONFIG_ROOT ?? '/home/boss/sp-hub/config';

export async function loadAgentConfig(handle: string): Promise<RascalConfig> {
  for (const kind of ['rascals', 'outsiders']) {
    const path = join(CONFIG_ROOT, kind, `${handle}.json`);
    try {
      const text = await readFile(path, 'utf-8');
      return JSON.parse(text) as RascalConfig;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw new Error(`no config for agent handle: ${handle}`);
}

export function modelForTask(cfg: RascalConfig, taskType: string): string {
  return cfg.task_overrides[taskType] ?? cfg.primary_model;
}

export async function dispatchForTask(
  handle: string,
  taskType: string,
  prompt: string,
  opts: DispatchOpts = {},
): Promise<DispatchResult> {
  const cfg = await loadAgentConfig(handle);
  const modelId = modelForTask(cfg, taskType);
  return dispatch(modelId, prompt, opts);
}
