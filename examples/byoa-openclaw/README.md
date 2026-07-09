# byoa-openclaw — govern OpenClaw with Agentbase

**Bring your own [OpenClaw](https://docs.openclaw.ai)** — the open-source, self-hosted autonomous agent that acts on instructions from WhatsApp, Telegram, Slack, or Signal — and route every real-world action it takes (HubSpot, Salesforce, Gmail, Outreach, Apollo) through Agentbase's policy + identity + approval + audit layer.

OpenClaw is MCP-aware (its own skill system is built on MCP), so there is no SDK code to write. You register [`@agentbase/mcp-server`](../../packages/mcp-server) as an MCP server in OpenClaw, hand it one scoped `agb_…` key, and every connector call the agent makes is now gated.

> For the SDK-based path (LangChain / Vercel AI / Mastra / raw Anthropic) see [`../byoa-vercel-ai`](../byoa-vercel-ai). For the generic MCP-client path (Claude Desktop, Cursor) see [`../byoa-mcp`](../byoa-mcp). For a self-improving CLI agent see [`../byoa-hermes`](../byoa-hermes). If you're running OpenClaw inside NVIDIA's hardened sandbox, see [`../byoa-nemoclaw`](../byoa-nemoclaw) for how the two governance layers stack.

## Why govern a chat-triggered agent in particular

OpenClaw takes action from whichever message lands in a connected chat — there is no developer watching a terminal, no code review on the instruction, and (by default) no human confirmation before it acts. It runs skills installed from ClawHub, a community skill marketplace, so provenance varies skill to skill. Independent safety research on OpenClaw has already documented real-world incidents where an ambiguous instruction turned into an action nobody actually wanted. That is exactly the failure mode you cannot govern by trusting the agent's prompt, its own confidence, or its tool list — the boundary has to live **outside** the agent:

- **Identity** — OpenClaw acts as one scoped `agb_…` agent identity. Revoke the key and it can touch nothing, regardless of which skill or chat message triggered the call.
- **Policy** — every call hits `allow` / `require_approval` / `deny` from [`policy.yaml`](./policy.yaml), evaluated server-side, against the actual params of the actual call. OpenClaw cannot see or edit it.
- **Approval** — sensitive actions (external email, deal changes over $10k, sequence enrollment) pause for a human ✓ in Slack before they execute.
- **Audit** — every decision and connector outcome lands in the immutable audit log, attributed to the OpenClaw identity.

**Scope note.** OpenClaw's native machine actions — shell commands, filesystem access, raw browser control — aren't an Agentbase connector today; this example only governs the revenue-stack surface OpenClaw reaches through Agentbase (HubSpot, Salesforce, Gmail, Outreach, Apollo), the same catalog [`byoa-hermes`](../byoa-hermes) governs. If you need the machine-level surface locked down too, that's what OpenClaw's own permission model — or NVIDIA's OpenShell sandbox in [`byoa-nemoclaw`](../byoa-nemoclaw) — is for. The two boundaries are complementary, not redundant.

> ⚠️ **Where the security boundary is.** OpenClaw's own `mcp` config supports client-side tool filtering (include/exclude lists in `openclaw.json`). That is a *convenience* — it tidies the agent's tool list. **It is not the gate.** The security boundary is Agentbase's server-side policy. Never rely on OpenClaw's own filter to keep a chat-triggered agent away from a dangerous action; express that as a `deny` / `require_approval` rule in `policy.yaml` instead.

## The delusional-agent demo

This is the scenario the bundled policy is tuned against. Someone messages OpenClaw on Telegram:

> "Follow up with everyone who went quiet this quarter, use your judgement."

Left to its own judgment, a sufficiently confident agent can talk itself into a lot from that one line — "everyone who went quiet" becomes the whole HubSpot database, a stale $82k deal gets marked `closedwon` to "clean up the pipeline" before the follow-up, and a discount nobody approved goes into a mass email draft to justify the re-engagement push. None of that requires a bug — it's the agent doing exactly what an unbounded, chat-triggered agent will eventually do with a vague instruction and no one watching the session.

Under `policy.yaml`, none of it executes unreviewed:

- `hubspot.deals.update` with `amount >= 10000` → **`require_approval`** — the pipeline-cleanup deal change pauses for a human, no matter how OpenClaw justified the number.
- `gmail.send` → **`require_approval`** — the mass email drafts fine (`gmail.draft.create` is `allow`), but nothing sends without a human reading it first.
- `outreach.sequences.enroll` → **`require_approval`** — "use your judgement" doesn't enroll real contacts in outbound on its own.
- `*.delete` → **`deny`**, unconditionally, if the agent decides the quiet contacts should be archived instead.

The gate doesn't evaluate whether OpenClaw's reasoning was sound — it only looks at the tool and params on the call in front of it. That's the point: a confident, wrong agent and a correct one hit the exact same policy. [`src/verify.ts`](./src/verify.ts) replays the deal-update beat of this scenario directly against the gate.

## Prerequisites

1. **Agentbase running locally.** From the repo root:
   ```bash
   docker compose -f infra/docker-compose.full.yml up --build
   ```
   (Or the lighter path: `infra/docker-compose.yml up -d` + `pnpm --filter @agentbase/db db:push` + `pnpm --filter @agentbase/api dev`.) The gate listens on `http://localhost:3002`.
2. **OpenClaw installed.** See the [OpenClaw docs](https://docs.openclaw.ai). Confirm with `openclaw --version`.
3. `jq` and `curl` for the setup script.

## 1. Mint a scoped identity + install the policy

```bash
./examples/byoa-openclaw/setup.sh
```

This applies [`policy.yaml`](./policy.yaml), registers a fresh `byoa-openclaw` agent, and prints the exact `openclaw mcp add …` command — pre-filled with the new `agb_…` key — to paste next.

## 2. Register Agentbase as an MCP server in OpenClaw

Either run the command `setup.sh` printed:

```bash
openclaw mcp add agentbase \
  --command pnpm \
  --args exec agentbase-mcp \
  --env AGENTBASE_API_KEY=agb_... \
  --env AGENTBASE_BASE_URL=http://localhost:3002
```

…or paste the `agentbase` block from [`openclaw-mcp-config.json`](./openclaw-mcp-config.json) into your `openclaw.json` / `.mcp.json` by hand, replacing the key. Because `pnpm exec agentbase-mcp` resolves the bin from this monorepo, run OpenClaw with this repo as its working directory, or replace `command` with an absolute path to the `agentbase-mcp` executable.

Then reload MCP servers:

```bash
openclaw mcp reload
```

The governed tools now appear alongside OpenClaw's other skills: `hubspot_contacts_upsert`, `salesforce_opportunity_create`, `gmail_send`, `outreach_sequences_enroll`, … (MCP requires underscores; the gate, policy file, and audit log keep the dotted form — `hubspot.contacts.upsert`).

## 3. Watch the gate fire

Message OpenClaw the delusional-agent prompt from above, or something narrower — either way, watch the audit log and Slack:

- `apollo.*`, `hubspot.contacts.upsert`, `gmail.draft.create` → **auto-execute**
- `gmail.send` → **pauses for a human ✓ in Slack** (`#critical-approvals`)
- `hubspot.deals.update` over $10k and `outreach.sequences.enroll` → **require approval**
- anything `*.delete` → **denied**, regardless of what OpenClaw decided

Every step is attributed to the `byoa-openclaw` identity in the audit log.

## Verify the wiring before you trust it (optional)

To confirm the exact MCP server OpenClaw will spawn is reachable and the gate fires — without involving OpenClaw — run the smoke test. It spawns `agentbase-mcp` with your key, lists the governed tools, and replays the deal-update beat of the delusional-agent demo so you can see the `awaiting_approval` shape:

```bash
AGENTBASE_API_KEY=agb_... pnpm --filter '@agentbase/byoa-openclaw' run verify
```

## Files

| File | What it is |
| --- | --- |
| [`setup.sh`](./setup.sh) | Installs the policy, registers the agent, prints the `openclaw mcp add` command. |
| [`policy.yaml`](./policy.yaml) | The server-side gate. Tuned for a chat-triggered agent: external sends and $10k+ deal writes require approval; deletes are denied. |
| [`openclaw-mcp-config.json`](./openclaw-mcp-config.json) | Paste-ready MCP server block for `openclaw.json` / `.mcp.json`. |
| [`src/verify.ts`](./src/verify.ts) | Optional smoke test that proves the MCP path OpenClaw uses actually wires up and gates. |
