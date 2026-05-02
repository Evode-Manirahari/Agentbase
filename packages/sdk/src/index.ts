import {
  ExecuteActionRequest,
  ExecuteActionResponse,
  type ExecuteActionResponse as ExecuteActionResponseT,
} from '@dejavas/shared';

export interface DejavasClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class DejavasError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'DejavasError';
  }
}

export class DejavasClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DejavasClientOptions) {
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
      throw new DejavasError(
        `Dejavas action failed (${res.status})`,
        res.status,
        json,
      );
    }
    return ExecuteActionResponse.parse(json);
  }
}
