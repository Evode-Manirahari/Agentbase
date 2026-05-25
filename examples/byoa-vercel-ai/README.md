# byoa-vercel-ai

**Bring your own agent**, powered by the [Vercel AI SDK](https://sdk.vercel.ai), governed by Agentbase.

This is the "drop-in" example for the new pitch — *Agentbase is the secure action layer for AI sales agents.* The agent here isn't ours. It's a stock Vercel AI SDK `generateText` loop with five tools. Each tool's `execute` function calls [`@agentbase/sdk`](../../packages/sdk) instead of hitting Apollo / HubSpot / Gmail directly, so every action runs through:

- scoped agent identity (the `agb_…` key)
- policy decision (allow / require_approval / deny)
- Slack approval card for sensitive actions
- immutable audit log

The Vercel AI SDK has no idea Agentbase exists. The agent code is just *yours*.

## What it does

Processes one inbound lead end-to-end:

1. `apollo.people.match` — enrich the contact *(auto-execute under the Sales Agent profile)*
2. `apollo.organizations.match` — enrich the company *(auto-execute)*
3. `hubspot.contacts.upsert` — create / update the CRM record *(auto-execute)*
4. `gmail.draft.create` — write a personalized outreach draft *(auto-execute)*
5. `gmail.send` — **pauses for a human ✓ in Slack** under the `approval-before-external-email` policy template

Claude (`claude-opus-4-7`) picks the order; the Agentbase gate decides each step.

## Run it

Prerequisite: Agentbase is running locally (see the [top-level README](../../README.md) — `docker compose -f infra/docker-compose.full.yml up --build` is the fastest path).

```bash
# 1. Register an agent in the dashboard and copy the agb_ key
open http://localhost:3000/agents

# 2. Set your environment
cp .env.example .env
# edit .env: AGENTBASE_API_KEY=agb_… ANTHROPIC_API_KEY=sk-ant-…

# 3. Run the agent against a lead
pnpm install
pnpm --filter @agentbase/byoa-vercel-ai start cto@globex.com
```

You'll see live output for each tool call (`[agentbase] gmail.send awaiting_approval` while a human decides), then the agent's final summary.

## What to read in the code

- [`src/index.ts`](./src/index.ts) — the entire example, ~120 lines.
  - `tools` block: five Vercel AI SDK tools, each wrapping one `agentbase.executeAndWait(...)` call. **This is the only Agentbase-specific code.**
  - `runThroughGate(...)` helper: handles `denied` / `failed` / `executed` uniformly so the model sees a clean shape.
  - `generateText({ … tools, maxSteps: 12 })`: stock Vercel AI SDK loop. Swap in your own agent here.

## The drop-in pattern

If you already have a Vercel AI SDK agent, adopting Agentbase is one change per tool:

```ts
// Before: your tool calls the vendor directly
sendEmail: tool({
  parameters: emailSchema,
  execute: async (params) => gmail.users.messages.send({ requestBody: params }),
}),

// After: the tool goes through the Agentbase gate
sendEmail: tool({
  parameters: emailSchema,
  execute: async (params) => {
    const res = await agentbase.executeAndWait({
      tool: 'gmail.send',
      params,
      idempotencyKey: stableKey(params),
    });
    return res.result;
  },
}),
```

Same idea works for [Mastra](https://mastra.ai) (`createTool({ execute: ... })`), [LangChain.js](https://js.langchain.com) (`new DynamicStructuredTool({ func: ... })`), or any framework that lets your tool definition own its `execute` function.

## See also

- [`packages/sdk/README.md`](../../packages/sdk/README.md) — SDK quickstart + API reference
- [`examples/demo-agent/`](../demo-agent) — minimal hardcoded + Claude-driven examples (no agent framework)
- [Agentbase architecture](../../README.md#what-works-today) — what the gate actually does
- [Security brief](../../SECURITY.md) — the threat model your buyer's security team will ask about
