// LLM adapter for the agent runtime.
//
// Two layers:
//  1. `LlmClient` interface — the runtime depends on this. Tests inject a
//     fake; production injects the Anthropic adapter.
//  2. `AnthropicLlmClient` — wraps @anthropic-ai/sdk, calls
//     /v1/messages with claude-opus-4-7 + adaptive thinking +
//     xhigh effort + prompt caching on the system prompt.
//
// The wire shape mirrors Anthropic's so we're not abstracting for the sake
// of it — tool_use / tool_result content blocks are the cleanest contract
// for an agent loop today.

import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import type { AgentRuntimeModel } from './job.js';

export type LlmContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean | undefined;
    };

export type LlmMessageRole = 'user' | 'assistant';

export interface LlmMessage {
  role: LlmMessageRole;
  content: LlmContentBlock[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmChatRequest {
  model: AgentRuntimeModel;
  max_tokens: number;
  systemPrompt: string;
  tools: LlmToolDefinition[];
  messages: LlmMessage[];
  // Forces Claude to call at most one tool per turn (Anthropic's
  // `tool_choice.disable_parallel_tool_use`). The runtime relies on this
  // to keep pause state simple — at most one pending tool_use per
  // paused run. Defaulted to true by the runtime.
  disableParallelToolUse?: boolean;
}

export type LlmStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'pause_turn'
  | 'refusal';

export interface LlmChatResponse {
  content: LlmContentBlock[];
  stop_reason: LlmStopReason;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | undefined;
    cache_read_input_tokens?: number | undefined;
  };
}

export interface LlmClient {
  chat(req: LlmChatRequest): Promise<LlmChatResponse>;
}

// DI token. Production binds AnthropicLlmClient; tests bind a fake.
export const LLM_CLIENT = Symbol('LLM_CLIENT');

export class AnthropicLlmClient implements LlmClient {
  private readonly log = new Logger(AnthropicLlmClient.name);
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        'ANTHROPIC_API_KEY is required for the agent runtime in enforced mode',
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async chat(req: LlmChatRequest): Promise<LlmChatResponse> {
    // System prompt is stable across turns within a job — caching it
    // means the second-and-later turns of the same agent run pay ~0.1×
    // for the prompt prefix. See prompt-caching.md for the prefix-match
    // invariant: per-run context goes in the user message, not here.
    const response = await this.client.messages.create({
      model: req.model,
      max_tokens: req.max_tokens,
      thinking: { type: 'adaptive' },
      // xhigh is the skill's recommended setting for agentic + coding work
      // on opus-4-7; "minimum of high for most intelligence-sensitive work".
      output_config: { effort: 'xhigh' },
      system: [
        {
          type: 'text',
          text: req.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
      })),
      tool_choice: req.disableParallelToolUse
        ? { type: 'auto', disable_parallel_tool_use: true }
        : { type: 'auto' },
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content.map((block) => block as Anthropic.Messages.ContentBlockParam),
      })),
    });

    return {
      content: response.content.map((block) => toLocalBlock(block)),
      stop_reason: (response.stop_reason ?? 'end_turn') as LlmStopReason,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens:
          response.usage.cache_creation_input_tokens ?? undefined,
        cache_read_input_tokens:
          response.usage.cache_read_input_tokens ?? undefined,
      },
    };
  }
}

function toLocalBlock(block: Anthropic.Messages.ContentBlock): LlmContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      };
    default:
      // Server-side tool results, redacted_thinking, etc. — render as text
      // so the transcript stays readable without us tracking every block
      // type Anthropic adds.
      return { type: 'text', text: `[unhandled block: ${block.type}]` };
  }
}
