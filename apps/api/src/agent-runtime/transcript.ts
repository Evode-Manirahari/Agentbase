// Transcript types emitted by the agent runtime.
//
// These describe what the LLM did and what each Agentbase tool call returned.
// The shape is deliberately decoupled from Anthropic's SDK types so the
// runtime's public surface doesn't leak the LLM provider — that lets us
// swap LLMs or mock the loop without touching consumers.

import type { ActionStatus, PolicyDecision } from '@agentbase/shared';

export type TranscriptEntry =
  | { type: 'agent_thinking'; text: string }
  | { type: 'agent_message'; text: string }
  | {
      type: 'tool_call';
      tool_use_id: string;
      job_tool_name: string;
      agentbase_tool: string;
      params: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      action_id: string;
      status: ActionStatus;
      policy_decision: PolicyDecision;
      result?: Record<string, unknown> | undefined;
    };

export type AgentRunStatus = 'completed' | 'paused' | 'failed';

export interface AgentRunUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  transcript: TranscriptEntry[];
  // Set when status === 'paused'. The action that triggered the pause
  // is awaiting human approval. The resume entry point looks up the
  // action and continues the loop with the resolved tool_result.
  paused_on?: {
    action_id: string;
    tool_use_id: string;
    agentbase_tool: string;
  };
  // Set when status === 'failed'.
  error?: string;
  // Tokens spent across all LLM calls. Useful for the audit log and cost
  // dashboard.
  usage?: AgentRunUsage;
}
