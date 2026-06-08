# byoa-hermes — govern a Hermes Agent with Agentbase

**Bring your own [Hermes Agent](https://hermes-agent.nousresearch.com)** — the self-improving CLI agent from Nous Research — and route every real-world action it takes (HubSpot, Salesforce, Gmail, Outreach, Apollo) through Agentbase's policy + identity + approval + audit layer.

Hermes is MCP-aware, so there is no SDK code to write. You register [`@agentbase/mcp-server`](../../packages/mcp-server) as an MCP server in Hermes, hand it one scoped `agb_…` key, and every connector call the agent makes is now gated.

> For the SDK-based path (LangChain / Vercel AI / Mastra / raw Anthropic) see [`../byoa-vercel-ai`](../byoa-vercel-ai). For the generic MCP-client path (Claude Desktop, Cursor) see [`../byoa-mcp`](../byoa-mcp). This example is the same MCP front door, wired specifically for Hermes.

## Why govern a self-improving agent in particular

Hermes *creates and rewrites its own skills during use* and carries memory across sessions. That is exactly the agent you cannot govern by trusting its prompt or its own tool list — its behavior is not fixed at deploy time. So the boundary has to live **outside** the agent:

- **Identity** — Hermes acts as one scoped `agb_…` agent identity. Revoke the key and it can touch nothing, regardless of what skills it taught itself.
- **Policy** — every call hits `allow` / `require_approval` / `deny` from [`policy.yaml`](./policy.yaml), evaluated server-side. Hermes cannot see or edit it.
- **Approval** — sensitive actions (external email, high-value deal writes, sequence enrollment) pause for a human ✓ in Slack before they execute.
- **Audit** — every decision and connector outcome lands in the immutable audit log, attributed to the Hermes identity.

> ⚠️ **Where the security boundary is.** Hermes's own MCP config supports client-side tool filtering (`tools.include` / `tools.exclude`). That is a *convenience* — it tidies the agent's tool list. **It is not the gate.** The security boundary is Agentbase's server-side policy. Never rely on the Hermes-side filter to keep a self-improving agent away from a dangerous action; express that as a `deny` / `require_approval` rule in `policy.yaml` instead.

## Prerequisites

1. **Agentbase running locally.** From the repo root:
   ```bash
   docker compose -f infra/docker-compose.full.yml up --build
   ```
   (Or the lighter path: `infra/docker-compose.yml up -d` + `pnpm --filter @agentbase/db db:push` + `pnpm --filter @agentbase/api dev`.) The gate listens on `http://localhost:3002`.
2. **Hermes Agent installed.** See the [Hermes install guide](https://hermes-agent.nousresearch.com/docs/). Confirm with `hermes --version`.
3. `jq` and `curl` for the setup script.

## 1. Mint a scoped identity + install the policy

```bash
./examples/byoa-hermes/setup.sh
```

This applies [`policy.yaml`](./policy.yaml), registers a fresh `byoa-hermes` agent, and prints the exact `hermes mcp add …` command — pre-filled with the new `agb_…` key — to paste next.

## 2. Register Agentbase as an MCP server in Hermes

Either run the command `setup.sh` printed:

```bash
hermes mcp add agentbase \
  --command pnpm \
  --args exec agentbase-mcp \
  --env AGENTBASE_API_KEY=agb_... \
  --env AGENTBASE_BASE_URL=http://localhost:3002
```

…or add it to your Hermes config (`mcp_servers:`) by hand — see [`hermes-mcp-config.yaml`](./hermes-mcp-config.yaml) for the full annotated block. Because `pnpm exec agentbase-mcp` resolves the bin from this monorepo, run Hermes with this repo as the working directory, or replace the command with an absolute path to the server.

Then reload MCP inside a Hermes session:

```
/reload-mcp
```

The governed tools now appear under the `agentbase` server: `hubspot_contacts_upsert`, `salesforce_opportunity_create`, `gmail_send`, `outreach_sequences_enroll`, … (MCP requires underscores; the gate, policy file, and audit log keep the dotted form — `hubspot.contacts.upsert`).

## 3. Watch the gate fire

Ask Hermes to run an inbound lead — for example:

> "Enrich cto@globex.com with Apollo, upsert them into HubSpot, draft a personalized intro email, then send it and enroll them in our outbound sequence."

Under the bundled policy you'll see:

- `apollo.*`, `hubspot.contacts.upsert`, `gmail.draft.create` → **auto-execute**
- `gmail.send` → **pauses for a human ✓ in Slack** (`approval-before-external-email`)
- `hubspot.deals.update` over $50k and `outreach.sequences.enroll` → **require approval**
- anything `*.delete` → **denied**, regardless of what Hermes decided

Every step is attributed to the `byoa-hermes` identity in the audit log.

## Verify the wiring before you trust it (optional)

To confirm the exact MCP server Hermes will spawn is reachable and the gate fires — without involving Hermes — run the smoke test. It spawns `agentbase-mcp` with your key, lists the governed tools, and calls one gated tool so you can see the `awaiting_approval` shape:

```bash
AGENTBASE_API_KEY=agb_... pnpm --filter '@agentbase/byoa-hermes' run verify
```

## Files

| File | What it is |
| --- | --- |
| [`setup.sh`](./setup.sh) | Installs the policy, registers the agent, prints the `hermes mcp add` command. |
| [`policy.yaml`](./policy.yaml) | The server-side gate. Tuned for a self-improving agent: external sends and high-value writes require approval; deletes are denied. |
| [`hermes-mcp-config.yaml`](./hermes-mcp-config.yaml) | Annotated `mcp_servers:` block to paste into Hermes config by hand. |
| [`src/verify.ts`](./src/verify.ts) | Optional smoke test — proves the MCP path Hermes uses actually wires up and gates. |
