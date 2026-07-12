import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Types — OpenAI-compatible request/response shapes used by callers
// ---------------------------------------------------------------------------

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  stream?: boolean;
  /** Optional top-level system prompt (takes precedence over system messages) */
  system?: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ---------------------------------------------------------------------------
// Anthropic client factory
// ---------------------------------------------------------------------------

/**
 * Builds the Anthropic SDK client wired for OAuth subscription token use.
 * The exact header set here is required — do not alter without testing.
 */
export function buildAnthropicClient(authToken: string): Anthropic {
  return new Anthropic({
    apiKey: null as unknown as string, // SDK requires this field; set to null for OAuth flow
    authToken,
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      'anthropic-beta':
        'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
      'user-agent': 'claude-cli/2.1.75',
      'x-app': 'cli',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
  });
}

// ---------------------------------------------------------------------------
// Request translation helpers
// ---------------------------------------------------------------------------

const GATEWAY_SYSTEM_PREFIX: Anthropic.TextBlockParam = {
  type: 'text',
  text: 'You are Claude Code, Anthropics official CLI for Claude.',
  cache_control: { type: 'ephemeral' },
};

/**
 * Extracts the effective system prompt from the request.
 * Priority: explicit `system` field > first message with role "system".
 * System-role messages are stripped from the messages array.
 */
function extractSystem(req: ChatCompletionRequest): {
  systemPrompt: string | null;
  messages: OpenAIMessage[];
} {
  if (req.system) {
    return {
      systemPrompt: req.system,
      messages: req.messages.filter((m) => m.role !== 'system'),
    };
  }

  const systemMessage = req.messages.find((m) => m.role === 'system');
  const filteredMessages = req.messages.filter((m) => m.role !== 'system');
  return {
    systemPrompt: systemMessage?.content ?? null,
    messages: filteredMessages,
  };
}

/**
 * Converts an OpenAI-format messages array into Anthropic MessageParam format.
 * Each message content block gets cache_control: ephemeral so the Anthropic
 * prompt cache can operate across turns.
 */
function toAnthropicMessages(
  messages: OpenAIMessage[],
): Anthropic.MessageParam[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: [
        {
          type: 'text' as const,
          text: m.content,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
    }));
}

/**
 * Builds the system block array for the Anthropic request.
 * Always includes the gateway identity prefix; appends the caller's system
 * prompt as a second block when one is provided.
 */
function buildSystemBlocks(
  systemPrompt: string | null,
): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [GATEWAY_SYSTEM_PREFIX];
  if (systemPrompt) {
    blocks.push({
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Main proxy function
// ---------------------------------------------------------------------------

/**
 * Proxies a ChatCompletionRequest through the Anthropic SDK and returns an
 * OpenAI-compatible ChatCompletionResponse.
 *
 * Always uses client.messages.stream() internally — for non-streaming callers
 * we collect all chunks and return a single response object.  This ensures
 * consistent OAuth token acceptance behaviour regardless of the caller's
 * stream preference.
 */
export async function proxyChatCompletion(
  client: Anthropic,
  req: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const { systemPrompt, messages } = extractSystem(req);
  const anthropicMessages = toAnthropicMessages(messages);
  const systemBlocks = buildSystemBlocks(systemPrompt);
  const maxTokens = req.max_tokens ?? 8192;

  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let messageId = `msg_${Date.now()}`;
  let stopReason = 'stop';

  const stream = await client.messages.stream({
    model: req.model,
    max_tokens: maxTokens,
    system: systemBlocks,
    messages: anthropicMessages,
  });

  for await (const event of stream) {
    if (event.type === 'message_start' && event.message) {
      messageId = event.message.id ?? messageId;
      inputTokens = event.message.usage?.input_tokens ?? 0;
    } else if (
      event.type === 'content_block_delta' &&
      event.delta?.type === 'text_delta'
    ) {
      fullText += event.delta.text;
    } else if (event.type === 'message_delta') {
      outputTokens = event.usage?.output_tokens ?? 0;
      stopReason =
        (event.delta?.stop_reason as string | null | undefined) ?? stopReason;
    }
  }

  // Normalise stop_reason to OpenAI vocabulary
  const finishReason =
    stopReason === 'end_turn'
      ? 'stop'
      : stopReason === 'max_tokens'
        ? 'length'
        : stopReason ?? 'stop';

  return {
    id: messageId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: fullText,
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}
