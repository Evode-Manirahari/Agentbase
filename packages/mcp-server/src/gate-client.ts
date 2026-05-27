import { AgentbaseClient, AgentbaseError } from '@agentbase/sdk';
import type { ExecuteActionResponse } from '@agentbase/shared';

export interface GateClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface GateClient {
  execute(input: {
    tool: string;
    params: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<ExecuteActionResponse>;
  get(actionId: string): Promise<ExecuteActionResponse>;
}

// Thin adapter over @agentbase/sdk that surfaces the structured response
// (executed | awaiting_approval | denied | failed) to the MCP layer
// without ever blocking on approval. Blocking would translate to an MCP
// tool call hanging for minutes while a human decides in Slack — a much
// worse UX than returning a pending status the agent can choose to poll.
export function createGateClient(opts: GateClientOptions): GateClient {
  const client = new AgentbaseClient({
    apiKey: opts.apiKey,
    ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });

  return {
    async execute(input) {
      return client.execute({
        tool: input.tool,
        params: input.params,
        ...(input.idempotencyKey !== undefined
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      });
    },
    async get(actionId) {
      return client.get(actionId);
    },
  };
}

export { AgentbaseError };
