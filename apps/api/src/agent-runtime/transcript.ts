// Transcript types emitted by the agent runtime.
//
// These describe what the LLM did and what each Dejavas tool call returned.
// The shape is deliberately decoupled from Anthropic's SDK types so the
// runtime's public surface doesn't leak the LLM provider — that lets us
// swap LLMs or mock the loop without touching consumers.

import type { ActionStatus, PolicyDecision } from '@dejavas/shared';

export type TranscriptEntry =
  | { type: 'agent_thinking'; text: string }
  | { type: 'agent_message'; text: string }
  | {
      type: 'tool_call';
      tool_use_id: string;
      job_tool_name: string;
      dejavas_tool: string;
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

export interface AgentRunResult {
  status: AgentRunStatus;
  transcript: TranscriptEntry[];
  // Set when status === 'paused'. The action that triggered the pause is
  // awaiting human approval. Resume happens in a later PR — the resume
  // entry point will look up the action and continue the loop with the
  // resolved tool_result.
  paused_on?: {
    action_id: string;
    tool_use_id: string;
    dejavas_tool: string;
  };
  // Set when status === 'failed'.
  error?: string;
  // Tokens spent across all LLM calls. Only populated when the LLM adapter
  // reports usage. Useful for the audit log and cost dashboard.
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | undefined;
    cache_read_input_tokens?: number | undefined;
  };
}
