import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ActionStatus, PolicyDecision } from '@dejavas/shared';
import { ActionsService } from '../actions/actions.service.js';
import { JobRegistry, type Job, type JobTool } from './job.js';
import {
  LLM_CLIENT,
  type LlmClient,
  type LlmContentBlock,
  type LlmMessage,
  type LlmToolDefinition,
} from './llm-client.js';
import type {
  AgentRunResult,
  AgentRunUsage,
  TranscriptEntry,
} from './transcript.js';

const DEFAULT_MAX_ITERATIONS = 12;
const DEFAULT_MAX_TOKENS = 16_000;

export interface RunJobInput {
  jobKey: string;
  orgId: string;
  agentId: string;
  context: Record<string, unknown>;
}

// Internal result shape: same as AgentRunResult plus the conversation
// messages so the processor can persist them for future resumes. The
// HTTP layer trims `messages` off before responding.
export interface AgentRunInternalResult extends AgentRunResult {
  messages: LlmMessage[];
}

export interface ResumeRunInput {
  jobKey: string;
  orgId: string;
  agentId: string;
  // Saved state from the paused run.
  savedMessages: LlmMessage[];
  savedTranscript: TranscriptEntry[];
  savedUsage: AgentRunUsage;
  // The action that was paused, now resolved. The action's stored
  // ActionStatus will be executed / failed / denied (expired approvals
  // are recorded as denied — see queue/expiry.processor.ts).
  resolvedAction: {
    tool_use_id: string;
    action_id: string;
    status: ActionStatus;
    policy_decision: PolicyDecision;
    result?: Record<string, unknown> | undefined;
  };
}

@Injectable()
export class AgentRuntimeService {
  private readonly log = new Logger(AgentRuntimeService.name);

  constructor(
    private readonly actions: ActionsService,
    private readonly registry: JobRegistry,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
  ) {}

  async runJob(input: RunJobInput): Promise<AgentRunInternalResult> {
    const job = this.registry.get(input.jobKey);
    const transcript: TranscriptEntry[] = [];
    const usage: AgentRunUsage = {
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
    return this.loop({
      job,
      orgId: input.orgId,
      agentId: input.agentId,
      messages,
      transcript,
      usage,
    });
  }

  async resumeRun(input: ResumeRunInput): Promise<AgentRunInternalResult> {
    const job = this.registry.get(input.jobKey);
    const messages: LlmMessage[] = input.savedMessages.map((m) => ({
      role: m.role,
      content: [...m.content],
    }));
    const transcript: TranscriptEntry[] = [...input.savedTranscript];
    const usage: AgentRunUsage = { ...input.savedUsage };

    // Build the tool_result block for the action that was paused. The
    // resolved status (executed / failed / denied / expired) gets fed
    // back to Claude so it can react — typically by acknowledging and
    // moving on, since the human already decided.
    const resolvedBlock: LlmContentBlock = {
      type: 'tool_result',
      tool_use_id: input.resolvedAction.tool_use_id,
      content: JSON.stringify({
        status: input.resolvedAction.status,
        policy: input.resolvedAction.policy_decision,
        result: input.resolvedAction.result ?? null,
      }),
      is_error:
        input.resolvedAction.status === 'failed' ||
        input.resolvedAction.status === 'denied',
    };
    messages.push({ role: 'user', content: [resolvedBlock] });

    // Also overwrite the awaiting_approval entry in the transcript with
    // the resolved status so the timeline reflects the final outcome.
    const lastIdx = transcript.length - 1;
    if (
      lastIdx >= 0 &&
      transcript[lastIdx]?.type === 'tool_result' &&
      transcript[lastIdx]?.tool_use_id === input.resolvedAction.tool_use_id
    ) {
      transcript[lastIdx] = {
        type: 'tool_result',
        tool_use_id: input.resolvedAction.tool_use_id,
        action_id: input.resolvedAction.action_id,
        status: input.resolvedAction.status,
        policy_decision: input.resolvedAction.policy_decision,
        result: input.resolvedAction.result,
      };
    }

    return this.loop({
      job,
      orgId: input.orgId,
      agentId: input.agentId,
      messages,
      transcript,
      usage,
    });
  }

  private async loop(args: {
    job: Job;
    orgId: string;
    agentId: string;
    messages: LlmMessage[];
    transcript: TranscriptEntry[];
    usage: AgentRunUsage;
  }): Promise<AgentRunInternalResult> {
    const { job, orgId, agentId } = args;
    const { messages, transcript, usage } = args;
    const llmTools = job.tools.map(toLlmTool);
    const maxIterations = job.maxIterations ?? DEFAULT_MAX_ITERATIONS;

    for (let iter = 0; iter < maxIterations; iter++) {
      const response = await this.llm.chat({
        model: job.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        systemPrompt: job.systemPrompt,
        tools: llmTools,
        messages,
        // Single tool per turn keeps pause state simple — at most one
        // pending action to resolve before resume can continue.
        disableParallelToolUse: true,
      });

      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      usage.cache_creation_input_tokens! +=
        response.usage.cache_creation_input_tokens ?? 0;
      usage.cache_read_input_tokens! +=
        response.usage.cache_read_input_tokens ?? 0;

      for (const block of response.content) {
        if (block.type === 'thinking' && block.thinking.length > 0) {
          transcript.push({ type: 'agent_thinking', text: block.thinking });
        } else if (block.type === 'text' && block.text.length > 0) {
          transcript.push({ type: 'agent_message', text: block.text });
        }
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (b): b is Extract<LlmContentBlock, { type: 'tool_use' }> =>
          b.type === 'tool_use',
      );

      if (toolUses.length === 0) {
        return { status: 'completed', transcript, usage, messages };
      }

      // With disable_parallel_tool_use, Claude emits at most one tool per
      // turn. If somehow it emits more (server-side ignores the hint?)
      // we fail loud rather than try to recover — the resume protocol
      // assumes ≤1 pending tool_use.
      if (toolUses.length > 1) {
        return {
          status: 'failed',
          transcript,
          error:
            'agent emitted multiple tool calls in a single turn; runtime requires sequential calls',
          usage,
          messages,
        };
      }

      const toolUse = toolUses[0]!;
      const jobTool = job.tools.find((t) => t.name === toolUse.name);
      if (!jobTool) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `error: unknown tool "${toolUse.name}"`,
              is_error: true,
            },
          ],
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
        orgId,
        agentId,
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
        return {
          status: 'paused',
          transcript,
          paused_on: {
            action_id: result.action_id,
            tool_use_id: toolUse.id,
            dejavas_tool: jobTool.dejavasTool,
          },
          usage,
          messages,
        };
      }

      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({
              status: result.status,
              policy: result.policy_decision,
              result: result.result ?? null,
            }),
            is_error:
              result.status === 'failed' || result.status === 'denied',
          },
        ],
      });
    }

    return {
      status: 'failed',
      transcript,
      error: `agent did not finish within ${maxIterations} iterations`,
      usage,
      messages,
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
