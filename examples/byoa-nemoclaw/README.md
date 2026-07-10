# byoa-nemoclaw — govern an agent running inside NVIDIA NemoClaw with Agentbase

**Bring your own [NVIDIA NemoClaw](https://www.nvidia.com/en-us/ai/nemoclaw/) deployment** — NVIDIA's open-source stack for running agents like OpenClaw, Hermes, or LangChain Deep Agents inside a hardened sandbox (NVIDIA OpenShell) — and route every real-world action the sandboxed agent takes (HubSpot, Salesforce, Gmail, Outreach, Apollo) through Agentbase's policy + identity + approval + audit layer.

NemoClaw manages MCP servers as part of its sandbox config, so — same as [`byoa-hermes`](../byoa-hermes) and [`byoa-openclaw`](../byoa-openclaw) — there is no SDK code to write. You register [`@agentbase/mcp-server`](../../packages/mcp-server) as an MCP server for the sandboxed agent, hand it one scoped `agb_…` key, and every connector call it makes is now gated.

> For the SDK-based path (LangChain / Vercel AI / Mastra / raw Anthropic) see [`../byoa-vercel-ai`](../byoa-vercel-ai). For the generic MCP-client path (Claude Desktop, Cursor) see [`../byoa-mcp`](../byoa-mcp). If you're running OpenClaw directly, without NemoClaw's sandbox, see [`../byoa-openclaw`](../byoa-openclaw) — this example is the same governed catalog, wired for whatever agent NemoClaw is running instead.

## Why two governance layers, not one

NemoClaw's OpenShell sandbox already locks down the *machine* perimeter around whatever agent it's running: which hosts the sandbox can reach (its network policy tiers), what the filesystem looks like, which model serves inference. That's a real and valuable boundary — but it answers a different question than the one Agentbase answers.

"Can this sandboxed process reach `api.hubapi.com` at all" and "should this specific call update deal #4471 to $210k" are not the same question, and NemoClaw's network policy tier only answers the first one. A tier that correctly allows egress to your CRM says nothing about whether the call the agent is about to make is one a human would sign off on. That's why the two layers stack instead of one replacing the other:

| Layer | Governs | Example decision |
|---|---|---|
| NemoClaw OpenShell | Network / filesystem / inference perimeter around the process | "This sandbox may reach `api.hubapi.com` and `gmail.googleapis.com`, nothing else." |
| Agentbase | Identity / policy / approval / audit around the business action | "This specific `hubspot.deals.update` call is over $25k — pause for a human." |

- **Identity** — the sandboxed agent acts as one scoped `agb_…` agent identity, independent of NemoClaw's own sandbox identity. Revoke the key and it can touch nothing, without touching the sandbox itself.
- **Policy** — every call hits `allow` / `require_approval` / `deny` from [`policy.yaml`](./policy.yaml), evaluated server-side, against the actual params of the actual call. Neither NemoClaw's network policy nor the sandboxed agent can see or edit it.
- **Approval** — sensitive actions (external email, deal changes over $25k, sequence enrollment) pause for a human ✓ in Slack before they execute — even though the sandbox already let the network call through.
- **Audit** — every decision and connector outcome lands in the immutable audit log, attributed to the sandboxed agent's identity, separate from NemoClaw's own sandbox logs.

> ⚠️ **Where the security boundary is.** NemoClaw's own MCP config supports client-side tool filtering, same as OpenClaw's and Hermes's. That's a *convenience* — it tidies the tool list the sandboxed agent sees. **It is not the gate**, and it's a different mechanism from NemoClaw's network policy tier. The real allow/deny/approval decisions live in Agentbase's `policy.yaml`, server-side. Express anything load-bearing there, not in a client-side filter or a network tier.

## The delusional-agent demo

Same scenario as [`byoa-openclaw`](../byoa-openclaw), run one layer deeper: the agent inside the NemoClaw sandbox is asked to "follow up with everyone who went quiet this quarter, use your judgement," decides a stale $82k deal needs to be marked `closedwon` to clean up the pipeline first, and drafts a mass email with a discount nobody approved.

NemoClaw's network policy tier does its job correctly here — it allows the sandbox to reach HubSpot and Gmail, because those are legitimate destinations for this agent. That correctness is exactly why a second layer matters: the sandbox has no opinion on whether *this* deal update or *this* send is reasonable, only on whether the destination is reachable. Under `policy.yaml`:

- `hubspot.deals.update` with `amount >= 25000` → **`require_approval`** — the sandbox let the call through; a human still signs off on the number.
- `gmail.send` → **`require_approval`** — drafts are fine, sends pause for a human.
- `outreach.sequences.enroll` → **`require_approval`** — no autonomous enrollment of real contacts.
- `*.delete` → **`deny`**, unconditionally.

[`src/verify.ts`](./src/verify.ts) replays the deal-update beat directly against the gate, without needing a live sandbox running.

## Prerequisites

1. **Agentbase running locally.** From the repo root:
   ```bash
   docker compose -f infra/docker-compose.full.yml up --build
   ```
   (Or the lighter path: `infra/docker-compose.yml up -d` + `pnpm --filter @agentbase/db db:push` + `pnpm --filter @agentbase/api dev`.) The gate listens on `http://localhost:3002`.
2. **NemoClaw sandbox provisioned**, running OpenClaw, Hermes, or a Deep Agent. See the [NemoClaw docs](https://docs.nvidia.com/nemoclaw/). Confirm with `nemoclaw --version`.
3. `jq` and `curl` for the setup script.

## 1. Mint a scoped identity + install the policy

```bash
./examples/byoa-nemoclaw/setup.sh
```

This applies [`policy.yaml`](./policy.yaml), registers a fresh `byoa-nemoclaw` agent, and prints the exact `nemoclaw mcp add …` command — pre-filled with the new `agb_…` key — to paste next.

## 2. Register Agentbase as an MCP server in the sandbox

First, confirm the sandbox's network policy tier allows egress to your Agentbase host (`nemoclaw doctor` — the baseline tier usually covers `localhost` in dev). Then either run the command `setup.sh` printed:

```bash
nemoclaw mcp add agentbase \
  --command pnpm \
  --args exec agentbase-mcp \
  --env AGENTBASE_API_KEY=agb_... \
  --env AGENTBASE_BASE_URL=http://localhost:3002
```

…or add the `agentbase` block from [`nemoclaw-mcp-config.yaml`](./nemoclaw-mcp-config.yaml) to your blueprint's `mcp_servers` config by hand, replacing the key. Because `pnpm exec agentbase-mcp` resolves the bin from this monorepo, run the sandbox with this repo reachable at the same path, or replace `command` with an absolute path to the `agentbase-mcp` executable.

Restart the sandboxed agent so it picks up the new MCP server.

## 3. Watch the gate fire

Give the sandboxed agent the delusional-agent prompt from above, or something narrower — either way, watch the audit log and Slack:

- `apollo.*`, `hubspot.contacts.upsert`, `gmail.draft.create` → **auto-execute**
- `gmail.send` → **pauses for a human ✓ in Slack** (`#critical-approvals`)
- `hubspot.deals.update` over $25k and `outreach.sequences.enroll` → **require approval**
- anything `*.delete` → **denied**, regardless of what the network policy tier allowed through

Every step is attributed to the `byoa-nemoclaw` identity in the audit log — separate from whatever NemoClaw itself logs about the sandbox.

## Verify the wiring before you trust it (optional)

To confirm the exact MCP server the sandboxed agent will spawn is reachable and the gate fires — without a live sandbox running — run the smoke test. It spawns `agentbase-mcp` with your key, lists the governed tools, and replays the deal-update beat of the delusional-agent demo so you can see the `awaiting_approval` shape:

```bash
AGENTBASE_API_KEY=agb_... pnpm --filter '@agentbase/byoa-nemoclaw' run verify
```

## Files

| File | What it is |
| --- | --- |
| [`setup.sh`](./setup.sh) | Installs the policy, registers the sandboxed agent, prints the `nemoclaw mcp add` command. |
| [`policy.yaml`](./policy.yaml) | The server-side gate. Tuned for a sandboxed autonomous agent: external sends and $25k+ deal writes require approval; deletes are denied. |
| [`nemoclaw-mcp-config.yaml`](./nemoclaw-mcp-config.yaml) | Annotated MCP server block for the NemoClaw blueprint or sandbox config. |
| [`src/verify.ts`](./src/verify.ts) | Optional smoke test that proves the MCP path the sandboxed agent uses actually wires up and gates. |
