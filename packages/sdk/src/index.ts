import {
  ExecuteActionRequest,
  ExecuteActionResponse,
  type ActionStatus,
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

export interface WaitForApprovalOptions {
  // Total time we'll wait before giving up. Default matches the
  // server's 24h approval TTL so a long-pending approval doesn't get
  // aborted by the SDK.
  timeoutMs?: number;
  // Time between polls. Start small to feel responsive when a human
  // approves quickly; grow up to maxIntervalMs so we don't hammer the
  // API when an approval sits for hours.
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  // Called on every poll so callers can log progress / cancel via
  // AbortController. Throw from this callback to abort the wait.
  onPoll?: (action: ExecuteActionResponseT) => void;
  signal?: AbortSignal;
}

const TERMINAL: ReadonlySet<ActionStatus> = new Set([
  'executed',
  'denied',
  'failed',
]);

export class AgentbaseClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AgentbaseClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'http://localhost:3002').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // Dispatch one tool call through the Agentbase action gate.
  //
  // Returns synchronously with one of:
  //   { status: 'executed', result }            — auto-approved, connector ran
  //   { status: 'denied',   policy_decision }   — policy denied the call
  //   { status: 'awaiting_approval', action_id} — human approval pending; call
  //                                               waitForApproval(action_id)
  //                                               to block until decided.
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

  // Fetch the current state of a single action by id. Org-scoped on the
  // server — your API key can only see actions in your own org.
  async get(actionId: string): Promise<ExecuteActionResponseT> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/actions/${encodeURIComponent(actionId)}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${this.apiKey}` },
      },
    );
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
      throw new AgentbaseError(
        `Agentbase get action failed (${res.status})`,
        res.status,
        json,
      );
    }
    return ExecuteActionResponse.parse(json);
  }

  // Poll an awaiting_approval action until the human decides, the policy TTL
  // expires the request, or our local timeout hits. Backs off exponentially
  // between polls. Resolves with the final ExecuteActionResponse (status will
  // be one of executed | denied | failed). Throws AgentbaseError on timeout
  // or if the caller's AbortSignal fires.
  async waitForApproval(
    actionId: string,
    opts: WaitForApprovalOptions = {},
  ): Promise<ExecuteActionResponseT> {
    const timeoutMs = opts.timeoutMs ?? 24 * 60 * 60 * 1000;
    const initial = opts.initialIntervalMs ?? 1000;
    const max = opts.maxIntervalMs ?? 15_000;
    const start = Date.now();
    let interval = initial;

    while (true) {
      if (opts.signal?.aborted) {
        throw new AgentbaseError('waitForApproval aborted', 0, null);
      }
      const action = await this.get(actionId);
      opts.onPoll?.(action);
      if (TERMINAL.has(action.status)) {
        return action;
      }
      const elapsed = Date.now() - start;
      if (elapsed >= timeoutMs) {
        throw new AgentbaseError(
          `waitForApproval timed out after ${elapsed}ms (action still ${action.status})`,
          0,
          action,
        );
      }
      const remaining = timeoutMs - elapsed;
      const sleepMs = Math.min(interval, remaining, max);
      await sleep(sleepMs, opts.signal);
      interval = Math.min(interval * 2, max);
    }
  }

  // Convenience: execute + auto-wait if the gate paused for approval.
  // Use this when the calling agent is happy to block on a human decision.
  async executeAndWait(
    input: {
      tool: string;
      params: Record<string, unknown>;
      idempotencyKey?: string;
    },
    waitOpts?: WaitForApprovalOptions,
  ): Promise<ExecuteActionResponseT> {
    const res = await this.execute(input);
    if (res.status !== 'awaiting_approval') return res;
    return this.waitForApproval(res.action_id, waitOpts);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AgentbaseError('aborted during sleep', 0, null));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AgentbaseError('aborted during sleep', 0, null));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
