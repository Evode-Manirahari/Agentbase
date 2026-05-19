import { Inject, Injectable, Logger } from '@nestjs/common';
import { ActionsService } from '../actions/actions.service.js';
import { JobRegistry, type JobTool } from './job.js';
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmContentBlock,
  type LlmMessage,
  type LlmToolDefinition,
} from './llm-client.js';
import type { AgentRunResult, TranscriptEntry } from './transcript.js';

const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_MAX_TOKENS = 16_000;

export interface RunJobInput {
  jobKey: string;
  orgId: string;
  agentId: string;
  context: Record<string, unknown>;
}

@Injectable()
export class AgentRuntimeService {
  private readonly log = new Logger(AgentRuntimeService.name);

  constructor(
    private readonly actions: ActionsService,
    private readonly registry: JobRegistry,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
  ) {}

  async runJob(input: RunJobInput): Promise<AgentRunResult> {
    const job = this.registry.get(input.jobKey);
    const llmTools = job.tools.map(toLlmTool);
    const transcript: TranscriptEntry[] = [];
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };

    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: job.buildInitialMessage(input.context) }],
      },
    ];

    const maxIterations = job.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    for (let iter = 0; iter < maxIterations; iter++) {
      const response = await this.llm.chat({
        model: job.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        systemPrompt: job.systemPrompt,
        tools: llmTools,
        messages,
      });

      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      usage.cache_creation_input_tokens +=
        response.usage.cache_creation_input_tokens ?? 0;
      usage.cache_read_input_tokens +=
        response.usage.cache_read_input_tokens ?? 0;

      // Append reasoning + visible text to the transcript before any tool
      // dispatch, so a paused run still reflects what the agent said up
      // to that point.
      for (const block of response.content) {
        if (block.type === 'thinking' && block.thinking.length > 0) {
          transcript.push({ type: 'agent_thinking', text: block.thinking });
        } else if (block.type === 'text' && block.text.length > 0) {
          transcript.push({ type: 'agent_message', text: block.text });
        }
      }

      // Round-trip Claude's content back into the message history. The
      // tool_use blocks must be preserved verbatim so the next turn's
      // tool_result blocks reference the same IDs.
      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (b): b is Extract<LlmContentBlock, { type: 'tool_use' }> =>
          b.type === 'tool_use',
      );

      // No tool calls → Claude is done.
      if (toolUses.length === 0) {
        return { status: 'completed', transcript, usage };
      }

      // Dispatch each tool_use through Dejavas. Collect results; if any
      // are awaiting_approval, pause the whole run.
      const toolResultBlocks: LlmContentBlock[] = [];
      for (const toolUse of toolUses) {
        const jobTool = job.tools.find((t) => t.name === toolUse.name);
        if (!jobTool) {
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `error: unknown tool "${toolUse.name}"`,
            is_error: true,
          });
          continue;
        }

        const params = jobTool.paramMapper
          ? jobTool.paramMapper(toolUse.input)
          : toolUse.input;

        transcript.push({
          type: 'tool_call',
          tool_use_id: toolUse.id,
          job_tool_name: toolUse.name,
          dejavas_tool: jobTool.dejavasTool,
          params,
        });

        const result = await this.actions.execute({
          orgId: input.orgId,
          agentId: input.agentId,
          tool: jobTool.dejavasTool,
          params,
        });

        transcript.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          action_id: result.action_id,
          status: result.status,
          policy_decision: result.policy_decision,
          result: result.result,
        });

        if (result.status === 'awaiting_approval') {
          // Stop calling Claude. The action is in the approval queue;
          // a separate resume entry point (PR 3) will pick up the loop
          // when the approval lands.
          return {
            status: 'paused',
            transcript,
            paused_on: {
              action_id: result.action_id,
              tool_use_id: toolUse.id,
              dejavas_tool: jobTool.dejavasTool,
            },
            usage,
          };
        }

        // Feed the resolved outcome back to Claude. Failed/denied are
        // surfaced as is_error so the model knows to back off rather
        // than retry the same call.
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            status: result.status,
            policy: result.policy_decision,
            result: result.result ?? null,
          }),
          is_error: result.status === 'failed' || result.status === 'denied',
        });
      }

      messages.push({ role: 'user', content: toolResultBlocks });
    }

    return {
      status: 'failed',
      transcript,
      error: `agent did not finish within ${maxIterations} iterations`,
      usage,
    };
  }
}

function toLlmTool(t: JobTool): LlmToolDefinition {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  };
}
