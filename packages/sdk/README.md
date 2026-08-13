# @agentbase/sdk

The client for calling the [Agentbase](https://github.com/Evode-Manirahari/Agentbase) action gate from your own AI agent. Use it when you have an agent (Mastra, LangChain, Vercel AI SDK, raw Anthropic SDK, anything that can make HTTP calls) and you want each tool call to run through scoped permissions, policy, human approval, and audit before it touches Salesforce, HubSpot, Gmail, Outreach, Apollo, or your internal APIs.

> Agentbase is the effect commit layer for AI agents — it commits irreversible actions exactly once and survives a crash in the middle. This SDK is what makes that true for *your* agent.

## Install

```bash
pnpm add @agentbase/sdk
# or: npm i @agentbase/sdk · yarn add @agentbase/sdk
```

Node 22+. The SDK has no runtime dependencies beyond [`@agentbase/shared`](../shared) (a few Zod schemas).

## 60-second quickstart

1. Run Agentbase locally (see the [top-level README](../../README.md)): `docker compose -f infra/docker-compose.full.yml up --build`.
2. Open `http://localhost:3000/agents`, click **Register agent**, pick the **Sales Agent** profile, copy the `agb_…` API key (revealed once).
3. Point your agent at the gate:

```ts
import { AgentbaseClient } from '@agentbase/sdk';

const agentbase = new AgentbaseClient({
  apiKey: process.env.AGENTBASE_API_KEY!,           // agb_…
  baseUrl: process.env.AGENTBASE_BASE_URL,           // optional, defaults to http://localhost:3002
});

// Auto-execute: HubSpot upsert is allow-listed for Sales Agent
const upsert = await agentbase.execute({
  tool: 'hubspot.contacts.upsert',
  params: { email: 'cto@globex.com', firstname: 'Lina', lastname: 'Cho' },
});
console.log(upsert.status);  // → "executed"

// Pauses on policy: gmail.send hits the approval-before-external-email rule
const send = await agentbase.executeAndWait({
  tool: 'gmail.send',
  params: { to: 'cto@globex.com', subject: 'hi', body: '…' },
});
console.log(send.status);    // → "executed" (after Slack ✓) or "denied"
```

The same code path runs auto-executed tools, denied tools, and tools paused for human approval — your agent doesn't branch on policy, it just calls `executeAndWait`.

## API reference

### `new AgentbaseClient(options)`

```ts
interface AgentbaseClientOptions {
  apiKey: string;        // your agb_… key from /agents
  baseUrl?: string;      // default http://localhost:3002
  fetchImpl?: typeof fetch;  // for tests / non-Node runtimes
}
```

### `client.execute({ tool, params, idempotencyKey? })`

Dispatch one tool call. Returns synchronously with one of:

- `{ status: 'executed', action_id, result }` — auto-approved by policy, the connector ran, `result` is the connector's response.
- `{ status: 'awaiting_approval', action_id, policy_decision }` — a human needs to decide in Slack or the web inbox. Call `waitForApproval(action_id)` to block, or poll `get(action_id)` yourself.
- `{ status: 'denied', action_id, policy_decision }` — policy refused; the connector was never called. `policy_decision.reason` explains why.
- `{ status: 'failed', action_id }` — the connector errored after policy passed (network, 5xx from the CRM, etc.). Safe to retry with the same `idempotencyKey`.

Pass `idempotencyKey` (any unique string per logical action) so a retry on network errors doesn't double-send an email or create two HubSpot deals.

### `client.get(actionId)`

Fetch the current state of one action. Returns the same shape as `execute`. Throws `AgentbaseError` (status 404) if the action doesn't exist or isn't in your org.

### `client.waitForApproval(actionId, options?)`

Polls `get()` with exponential backoff until the action's status is terminal (`executed | denied | failed`). Resolves with the final response. Throws `AgentbaseError` on timeout or `AbortSignal` cancellation.

```ts
interface WaitForApprovalOptions {
  timeoutMs?: number;         // default 24h (matches server approval TTL)
  initialIntervalMs?: number; // default 1000ms
  maxIntervalMs?: number;     // default 15000ms
  onPoll?: (action) => void;  // observe each poll; throw to abort
  signal?: AbortSignal;       // cancel from the outside
}
```

### `client.executeAndWait(input, waitOptions?)`

`execute()` + automatic `waitForApproval()` if the gate paused. Recommended for any agent that doesn't need to release the worker while a human decides.

### `AgentbaseError`

Thrown on non-2xx responses and on timeouts. Inspect `err.status` (HTTP status, or `0` for timeouts/aborts) and `err.body` (the raw response JSON, or the last action snapshot).

## Patterns

**Long-running approvals.** If your agent runs in a serverless function with a 30s timeout, don't block on `executeAndWait` for an email-send. Instead: call `execute()`, persist the `action_id`, and have a separate worker poll `get()` later. Or: subscribe to webhooks (see `apps/api/src/webhooks/`).

**Retries.** Always pass `idempotencyKey`. The server dedupes against `(org, agent, key)` — a retry on the same key returns the original action without re-running the connector.

**Multi-tool agents.** Each tool call is independent. The gate doesn't enforce ordering — your agent does. Single-tool-per-turn is the safest pattern; the policy reasons about each call in isolation.

## See also

- [`examples/byoa-mastra/`](../../examples/byoa-mastra) — a real Mastra agent processing a lead through the gate
- [`examples/demo-agent/`](../../examples/demo-agent) — minimal hardcoded + Claude-driven examples
- [Agentbase architecture](../../README.md#what-works-today) — what the gate actually does
- [Security brief](../../SECURITY.md) — the threat model your security team will ask about
