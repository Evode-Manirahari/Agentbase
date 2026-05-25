import {
  ExecuteActionRequest,
  ExecuteActionResponse,
  type ExecuteActionResponse as ExecuteActionResponseT,
} from '@agentbase/shared';

export interface AgentbaseClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class AgentbaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'AgentbaseError';
  }
}

export class AgentbaseClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AgentbaseClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:3002').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async execute(input: {
    tool: string;
    params: Record<string, unknown>;
    idempotencyKey?: string;
  }): Promise<ExecuteActionResponseT> {
    const body = ExecuteActionRequest.parse({
      tool: input.tool,
      params: input.params,
      idempotency_key: input.idempotencyKey,
    });

    const res = await this.fetchImpl(`${this.baseUrl}/v1/actions/execute`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
      throw new AgentbaseError(
        `Agentbase action failed (${res.status})`,
        res.status,
        json,
      );
    }
    return ExecuteActionResponse.parse(json);
  }
}
