# Agentbase

> Scoped identity, approval, and audit for AI agents before they touch your APIs, CRM, email, and internal tools.

[![CI](https://github.com/Evode-Manirahari/Agentbase/actions/workflows/ci.yml/badge.svg)](https://github.com/Evode-Manirahari/Agentbase/actions/workflows/ci.yml)

Agentbase is the safe-action layer for internal AI agents.

> "Every SaaS company will become a GaaS [agentic-as-a-service] company, and every engineer will carry an annual token budget alongside their salary."
> — Jensen Huang, NVIDIA GTC Taipei 2026

When every company runs agents on a token budget, every one of those agents needs an identity, a permission boundary, and an audit trail. That layer is Agentbase.

The product direction source of truth lives in [docs/positioning.md](./docs/positioning.md).

## What this is

Teams are deploying AI agents against Salesforce, Gmail, Slack, Outreach, Apollo, internal APIs, and enrichment tools. The agents can research, enrich records, update systems of record, draft and send messages, create tasks, summarize activity, and run multi-step workflows. Security and IT block them before they can touch production systems because the agents lack scoped identity, approval rules, revocation, and audit trails.

Agentbase is the control plane those teams can trust:

- Give every agent an identity and scoped API key.
- Govern what it can do across CRM, email, internal APIs, Slack-adjacent approvals, and third-party tools.
- Route sensitive actions to humans before execution.
- Revoke compromised or over-scoped agents quickly.
- Monitor every attempted action with policy decisions, connector outcomes, and exportable audit trails.

The pitch:

> **Agentbase is Okta + Zapier + Datadog for AI agents: identity, governed execution, and observability across everything the agent touches.**

We sell first into the revenue/CRM beachhead — RevOps teams deploying an agent against Salesforce/HubSpot — then expand to any team running internal agents (ops, support, internal tooling). Security and IT are the required sign-off. Salesforce, HubSpot, Outreach, and Gmail can govern agents inside their own products; Agentbase governs agents across the full workflow.

The bundled outbound, follow-up, reply-handler, CRM hygiene, and lead-list flows are a frozen reference implementation — proof the gate works on a real agent. The product is not "an AI SDR." The product is the cross-stack action layer that lets any internal agent act safely.

## Why this becomes defensible

Agentbase's moat is becoming the trusted control plane for agent actions across the revenue stack:

- **Trust + compliance position** — RevOps and security teams need proof before letting agents touch CRM, email, and sales tools. Agentbase should become the approval and audit source of truth: every agent identity, permission, policy decision, approval, denial, connector result, revocation, and exportable audit event in one system security can inspect.
- **Cross-stack integration depth** — Salesforce, HubSpot, Gmail, Outreach, Slack, Apollo, and enrichment vendors each have their own permissions and logs. Agentbase governs the whole workflow across those tools instead of governing one app at a time.
- **Embedded switching cost** — once agent identities, scoped API keys, policies, approvals, logs, connector credentials, and audit exports live in Agentbase, replacing it means rebuilding the trust layer around every production agent workflow.
- **Agent-native interface** — the buyer is human, but the daily user is the agent. SDK and MCP access let agents call Agentbase directly while humans keep control over identity, policy, approvals, and audit.
- **Action history data** — as customers use Agentbase, action history becomes a compounding asset: which tools are risky, which policies work, which approvals are common, which agents need tighter scopes, and which guardrails security accepts.

## Bring your own agent

Agentbase governs *your* agent, not just ours. The bundled Revenue Agent jobs are reference implementations — proof the gate works on a real agent — but any TypeScript-side LLM tool-use loop can plug in with one import:

```ts
import { AgentbaseClient } from '@agentbase/sdk';

const agentbase = new AgentbaseClient({ apiKey: process.env.AGENTBASE_API_KEY! });

const res = await agentbase.executeAndWait({
  tool: 'gmail.send',
  params: { to: 'cto@globex.com', subject: '…', body: '…' },
});
// res.status === 'executed'  ← human approved in Slack
// res.status === 'denied'    ← policy refused
```

The same gate runs whether the call comes from `apps/api/src/agent-runtime/` (our agent) or from your own Vercel AI SDK / Mastra / LangChain agent calling `@agentbase/sdk`. Same scoped identity, same policy, same Slack approval card, same audit row in `/audit`.

Two integration surfaces — code-level (SDK) and protocol-level (MCP):

- [`packages/sdk/README.md`](./packages/sdk/README.md) — code-level integration. Import `@agentbase/sdk` in your agent loop (LangChain / Vercel AI / Mastra / raw Anthropic) and call the gate over HTTP.
- [`packages/mcp-server/README.md`](./packages/mcp-server/README.md) — protocol-level integration. Run `agentbase-mcp` over stdio and any MCP-aware client (Claude Desktop, Cursor, Codex) gets every tool call routed through the gate. No agent code changes.
- [`examples/byoa-vercel-ai/`](./examples/byoa-vercel-ai) — real ~120-line example: Vercel AI SDK agent with five tools, each going through the gate via the SDK. End-to-end lead-processing flow with one auto-executed step, one Slack-approval step, and a denial path.
- [`examples/byoa-mcp/`](./examples/byoa-mcp) — smoke test for the MCP path plus a paste-and-edit Claude Desktop config.
- [`examples/byoa-hermes/`](./examples/byoa-hermes) — govern a [Hermes Agent](https://hermes-agent.nousresearch.com) (Nous Research's self-improving CLI agent) via MCP: a `setup.sh` that mints the scoped key + `hermes mcp add` command, a policy tuned for an autonomous agent, and a verify smoke test.
- [`examples/byoa-openclaw/`](./examples/byoa-openclaw) — govern [OpenClaw](https://docs.openclaw.ai) (the open-source, chat-triggered autonomous agent) via MCP: tighter deal-value thresholds than byoa-hermes, tuned for an agent with no human watching the session.
- [`examples/byoa-nemoclaw/`](./examples/byoa-nemoclaw) — govern an agent running inside [NVIDIA NemoClaw](https://www.nvidia.com/en-us/ai/nemoclaw/)'s sandbox via MCP: shows Agentbase's business-action policy stacking under NemoClaw's own network/filesystem sandbox, not replacing it.
- [`examples/demo-agent/`](./examples/demo-agent) — minimal hardcoded and raw-Anthropic variants if you don't want a framework.

## How the demo works

End-to-end in <2 minutes once the API is up:

1. Open `http://localhost:3000/campaigns`.
2. Pick the **Revenue Agent — outbound** job and an active agent identity.
3. Paste lead emails + optional notes. Click **Start governed run**.
4. You're redirected to `/campaigns/batch/[id]`, which polls live as Claude:
   - calls `apollo.people.match` and `apollo.organizations.match` (auto-execute)
   - calls `hubspot.contacts.upsert` (auto-execute)
   - calls `gmail.draft.create` (auto-execute)
   - calls `gmail.send` → **policy pauses the run** ([approval-before-external-email](#) template fires)
5. A Slack approval card lands in `#agent-approvals` with the full email body, recipient, and policy reason.
6. Approver clicks ✓. The action transitions to `executed`, the worker picks up the resume job, the loop continues, and the dashboard timeline updates to `completed` with a final summary from Claude.
7. Every state transition is in the audit log; **Download CSV** on `/audit` hands security the evidence.

The same control loop applies to Salesforce + Gmail + Slack, HubSpot + Gmail + Slack, Outreach sequencing, Apollo enrichment, and future revenue-stack connectors. The current outbound job is one workflow on top of a generic runtime and connector gate.

## Status

Early. The full demoable loop works end-to-end locally. Production auth now fails closed unless Clerk is configured or an explicit unauthenticated escape hatch is set; broader production hardening is still incomplete. No customers yet.

## What works today

The effect commit layer — [`docs/effect-commit.md`](./docs/effect-commit.md):

A permissions gateway answers *"may this agent call this tool?"* — settled before anything leaves the machine. This layer answers the question that comes after: **the call was permitted and a human approved it, so how do we commit it exactly once, prove what happened, and survive a crash in between?**

- **Effect classification** (`packages/effects`) — a shell command is graded by consequence (`read` / `workspace_write` / `vcs_write` / `deploy` / `publish` / `infra_write` / `egress` / `external_comms` / `unknown`) plus an independent `reversible` flag. Fails closed: `$(…)`, backticks, `eval`, `curl … | sh`, and unrecognised programs all grade `unknown`, never safe.
- **Policy by consequence** — rules match on `effect_class` and `reversible`, so one rule gates every irreversible effect regardless of which tool produces it. The list of things that publish is exactly the list nobody can keep current by hand. A missing assessment is a non-match, never a wildcard.
- **Commit protocol** — the attempt is written `indeterminate` **before** the request leaves, so a crash there leaves evidence rather than nothing. A provider idempotency key goes on the wire where the provider honours one. `effect_receipts` records one row per attempt carrying the provider's own reference.
- **Quarantine with an exit** — an attempt whose outcome was never learned stays `indeterminate` and is never auto-retried. Retry is *refused* for a provider that cannot deduplicate, and past the 24h key window even for one that can. `GET /v1/effects/indeterminate` is the operator queue; `POST /v1/effects/:id/resolve` records what a human found.
- **Replay** — `AGENTBASE_REPLAY=1` makes the dispatcher incapable of reaching a provider; recorded receipts are returned instead. A process-level switch, not a per-call flag, because a guarantee that depends on every caller remembering a parameter is not one.

The claim is binary and tested by fault injection (`apps/api/src/actions/effect-dispatcher.test.ts`): **ten retries across three crash points produce exactly one effect**, and replay reaches no provider at all. Remove the idempotency key from the wire and the first becomes `expected: 1, actual: 8`.

Run it: [`examples/effect-gate-demo`](./examples/effect-gate-demo) — five ordinary commands, a four-rule policy naming none of them, two allowed, two held for a human, one denied.

The governed runtime:

- **Agent runtime** — generic loop on the API (`apps/api/src/agent-runtime/`) that takes a `Job` config (system prompt + tool list + initial-message builder) and a context, calls Claude via the Anthropic SDK with adaptive thinking and `xhigh` effort, dispatches every tool call through the same `ActionsService.execute` path an external agent would use, and returns a transcript. Pauses cleanly on `awaiting_approval`; resumes when the approval lands. Single tool per turn via `disable_parallel_tool_use` so pause state stays simple.
- **Revenue-agent jobs** — outbound lead handling, follow-up, reply handling, and CRM hygiene prove that one runtime can govern research, enrichment, CRM writes, task creation, and email sending. Adding a new workflow is data + prompts, not a new product.
- **Async runs + resume** — `agent_runs` table persists conversation state. `POST /v1/campaigns/runs` enqueues a BullMQ job, returns the run id immediately. `GET /v1/campaigns/runs/:id` is polled by the dashboard. When a Slack approval (or the expiry sweeper) transitions the action out of `awaiting_approval`, `ApprovalsService` notifies `AgentRunsService` and a resume job continues the loop with the resolved tool_result.
- **Runs dashboard** — `/campaigns` launches governed runs, including batches from lead lists. Recent runs table on the index page. Transcript view tones agent_thinking / agent_message / tool_call / tool_result blocks by status (allow=green, require_approval=amber, deny/failed=rose).

The safe-action layer:

- **Approval workflow** — DB-backed pending queue, transactional decide endpoint, idempotency (409), 24h TTL, BullMQ-backed expiry sweeper on Redis
- **Slack approval cards** — interactive Approve / Deny buttons with the full action payload, signed webhook (HMAC + 5-min replay window), per-rule channel routing, two-way consistency (web decisions update the Slack card via `chat.update`)
- **Policy templates** — three one-click templates that cover the most common pilot questions: require approval before external email, require approval on CRM writes over $10k, and deny delete/export/bulk actions. Sit above the YAML editor so the RevOps buyer never has to write Rego on call one.
- **Audit log + export** — every state transition recorded with actor type/id, exportable as RFC 4180 CSV or JSON straight from the dashboard, so security teams can take evidence into SOC 2 reviews and questionnaires
- **Production auth refusal** — `ClerkAuthGuard` and the Next middleware both throw at boot if `NODE_ENV=production` and Clerk env vars aren't set; explicit `AGENTBASE_ALLOW_UNAUTHENTICATED=1` is the only way to opt out

The plumbing both sides share:

- **Identity & API keys** — register agents, assign permission profiles, issue scoped `agb_…` tokens (sha256-hashed at rest), and revoke agents idempotently
- **Permission profiles** — Sales Agent, RevOps Admin, Support Agent, Read-only Analyst, and Custom — used to seed policy templates per agent role
- **Policy DSL** — YAML + Zod, rule-based effects (`allow` / `require_approval` / `deny`), tool glob matching, agent id/name/profile matching, dotted-path conditions with `eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`in`/`contains`/`exists`; the templates compile to this, and security can read it
- **Connectors** — Salesforce, HubSpot, Gmail, Outreach, and Apollo, all behind the same safe-action layer, with Zod-validated params and structured connector errors. Pilots ship on Salesforce + Gmail + Slack or HubSpot + Gmail + Slack; the rest are available if a customer asks.
- **Org-scoped connector credentials** — HubSpot, Salesforce, Gmail, and Outreach OAuth install/reconnect plus dashboard-managed static credentials override process env vars per org, are AES-256-GCM encrypted at rest, refresh access tokens before connector dispatch, show account/expiry metadata, can be tested from the dashboard, and can be disabled to block inherited env fallback
- **Web dashboard** (Next.js 15 + Tailwind v4) — Overview, Runs, Agents, Policies (templates + YAML editor), Approvals (web inbox alongside Slack), Actions, Connectors, Webhooks, Audit
- **CI + tests** — GitHub Actions gates lint, typecheck, production build, the API test suite, and Playwright dashboard E2E including connector credential/OAuth-state and permission-profile coverage

## Quick start

### Demo mode — single command

Requires Docker.

```bash
git clone https://github.com/Evode-Manirahari/Agentbase
cd Agentbase
docker compose -f infra/docker-compose.full.yml up --build
```

Brings up Postgres + Redis + the schema migration + API on :3002 + web on :3000 with health checks. Open http://localhost:3000.

To use real connectors, set the relevant env vars in your shell before `docker compose up` (or uncomment the lines in `infra/docker-compose.full.yml`):

```bash
HUBSPOT_CLIENT_ID=... HUBSPOT_CLIENT_SECRET=... SLACK_BOT_TOKEN=xoxb-... \
  docker compose -f infra/docker-compose.full.yml up --build
```

### Dev mode — hot reload

Requires Docker, Node 22+, pnpm 10+.

```bash
pnpm install

# Postgres + Redis
docker compose -f infra/docker-compose.yml up -d

# Apply schema
DATABASE_URL=postgresql://agentbase:agentbase@localhost:5433/agentbase \
  pnpm --filter '@agentbase/db' exec drizzle-kit push --force

# Env
cp apps/api/.env.example apps/api/.env

# API on :3002
pnpm --filter '@agentbase/api' dev

# Web on :3000 (in another terminal)
pnpm --filter '@agentbase/web' dev
```

### Use Supabase as the database (optional)

Supabase works as a drop-in replacement for self-hosted Postgres — point `DATABASE_URL` at it and everything else is unchanged:

- **Schema push / migrations:** use the **direct connection** string (port `5432`, `db.<ref>.supabase.co`).
- **API at runtime:** use the **transaction pooler** string (port `6543`, `*.pooler.supabase.com`). `createDb` auto-detects the pooler and disables postgres-js prepared statements (Supavisor doesn't support them); direct connections keep them.
- Supabase replaces **Postgres only** — Redis (BullMQ queues) and the API itself still need hosting (Fly below). Free-tier projects pause after ~1 week idle; restore before demos or upgrade once a pilot starts.

```bash
# one-time schema push (direct connection)
DATABASE_URL='postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres' \
  pnpm --filter '@agentbase/db' exec drizzle-kit push --force

# API runtime (transaction pooler)
fly secrets set DATABASE_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres' --config infra/fly.api.toml
```

### Deploy to Fly.io

Two Fly apps (api + web) wired by setting `API_URL` on the web app to point at the api app's `.fly.dev` URL. Configs are in `infra/fly.api.toml` and `infra/fly.web.toml` — edit the `app =` placeholders, then:

```bash
# API
fly apps create agentbase-api-CHANGEME --config infra/fly.api.toml
fly postgres create --name agentbase-pg-CHANGEME --region iad
fly postgres attach agentbase-pg-CHANGEME --app agentbase-api-CHANGEME   # sets DATABASE_URL
fly redis create --name agentbase-redis-CHANGEME --region iad
fly secrets set REDIS_URL=redis://... --config infra/fly.api.toml
fly secrets set CONNECTOR_CREDENTIALS_KEY="base64:$(openssl rand -base64 32)" --config infra/fly.api.toml
fly secrets set API_PUBLIC_URL=https://agentbase-api-CHANGEME.fly.dev DASHBOARD_URL=https://agentbase-web-CHANGEME.fly.dev --config infra/fly.api.toml
fly deploy --config infra/fly.api.toml --remote-only

# Web (after the API is live)
fly apps create agentbase-web-CHANGEME --config infra/fly.web.toml
fly secrets set API_URL=https://agentbase-api-CHANGEME.fly.dev --config infra/fly.web.toml
fly deploy --config infra/fly.web.toml --remote-only
```

Both Fly configs use `auto_stop_machines = "stop"` so you only pay for active traffic, and `min_machines_running = 0` so idle apps cost ~0. The api's `[[http_service.checks]]` hits `/health` every 30s.

To plug in real connectors after deploy, connect HubSpot, Salesforce, Gmail, or Outreach from the dashboard, save static credentials in the Connectors page, or set fallback env vars with `fly secrets set` (HubSpot / Salesforce / Gmail / Outreach / Apollo / Slack tokens). Org-scoped credentials override fallback env vars. Each connector independently degrades to `connector_not_configured` when its tokens are absent or disabled for the org.

For connector OAuth, register the matching redirect URLs in each provider app:

```text
https://agentbase-api-CHANGEME.fly.dev/v1/connectors/hubspot/oauth/callback
https://agentbase-api-CHANGEME.fly.dev/v1/connectors/salesforce/oauth/callback
https://agentbase-api-CHANGEME.fly.dev/v1/connectors/gmail/oauth/callback
https://agentbase-api-CHANGEME.fly.dev/v1/connectors/outreach/oauth/callback
```

Then set the provider's `*_CLIENT_ID` and `*_CLIENT_SECRET` on the API app.

## Smoke-test the loop

```bash
# 1. Register an agent and capture the agb_ key
REG=$(curl -s -X POST localhost:3002/v1/agents \
  -H 'content-type: application/json' \
  -d '{"name":"demo-agent"}')
KEY=$(echo "$REG" | jq -r .api_key)

# 2. Set a policy
curl -s -X PUT localhost:3002/v1/policies/active \
  -H 'content-type: application/json' \
  -d '{"name":"demo","yaml":"version: 1\ndefault: deny\nrules:\n  - match: { tool: hubspot.contacts.* }\n    effect: allow\n  - match:\n      tool: hubspot.leads.create_deal\n      when: { deal.amount: { gt: 10000 } }\n    effect: require_approval\n    slack_channel: \"#critical-approvals\"\n  - match: { tool: hubspot.leads.create_deal }\n    effect: allow\n"}'

# 3. Execute an action (high-value lead workflow: should pause for approval)
curl -s -X POST localhost:3002/v1/actions/execute \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"tool":"hubspot.leads.create_deal","params":{"contact":{"email":"demo-lead@example.com","company":"Example"},"deal":{"dealname":"Example inbound pilot","amount":50000},"note":{"body":"Inbound lead processed by demo-agent."}}}'
# → status: awaiting_approval (matches require_approval rule)

# 4. List pending approvals
curl -s localhost:3002/v1/approvals | jq

# 5. Decide via web (or POST directly)
APPROVAL=$(curl -s localhost:3002/v1/approvals | jq -r '.items[0].approval_id')
curl -s -X POST "localhost:3002/v1/approvals/$APPROVAL/decision" \
  -H 'content-type: application/json' \
  -d '{"decision":"approve","decided_by_email":"alice@agentbase.test"}'
# → action transitions to executed (or failed/connector_not_configured if no HubSpot token set)
```

## Architecture

```
apps/
├── api/                 NestJS-on-Fastify (TypeScript, ESM)
│   └── src/
│       ├── agents/      register / list / profile updates / revoke
│       ├── actions/     POST /v1/actions/execute (the SDK proxy)
│       ├── approvals/   list / decide / Slack-card lifecycle
│       ├── policy/      YAML/Zod engine + active-policy lifecycle + agent profile matching
│       ├── connectors/  connector registry + provider dispatch
│       ├── slack/       approval cards + interactive webhook
│       ├── queue/       BullMQ expiry sweeper (every 60s)
│       ├── audit/       immutable log
│       ├── auth/        API-key guard + key generation
│       ├── connectors/  connector registry + org-scoped credential store
│       └── db/          DI for Drizzle client
└── web/                 Next.js 15 dashboard (App Router, Tailwind v4)
    └── src/app/
        ├── page.tsx       Overview
        ├── agents/        register + permission profiles + revoke
        ├── policies/      live YAML editor
        ├── approvals/     web inbox
        ├── actions/       full action history
        ├── connectors/    org credential management
        ├── webhooks/      webhook subscriptions
        └── audit/         event log

packages/
├── db/                  Drizzle schema + client (orgs/users/agents/keys/policies/actions/approvals/connectors/audit_log)
├── shared/              Zod schemas + types (used by API, SDK, web)
├── sdk/                 @agentbase/sdk client — code-level integration for your agent
└── mcp-server/          @agentbase/mcp-server — protocol-level integration (stdio MCP server)

connectors/
├── hubspot/             HubspotConnector (CRM v3)
├── salesforce/          SalesforceConnector (REST v60)
├── gmail/               GmailConnector (Gmail v1; RFC 2822 + base64url)
├── outreach/            OutreachConnector (v2; JSON:API envelopes)
└── apollo/              ApolloConnector (v1; X-Api-Key auth)

examples/
├── demo-agent/          Reference agent that uses @agentbase/sdk
├── byoa-vercel-ai/      Bring-your-own-agent example wired via the SDK
├── byoa-mcp/            Bring-your-own-agent example wired via MCP (Claude Desktop, Cursor, etc.)
├── byoa-hermes/         Govern a Hermes Agent (Nous Research) via MCP — scoped key, policy, verify
├── byoa-openclaw/       Govern OpenClaw (chat-triggered autonomous agent) via MCP — tighter thresholds, same catalog
├── byoa-nemoclaw/       Govern an agent inside NVIDIA NemoClaw's sandbox — business-action policy stacked under the network sandbox
└── cross-stack-demo/    One agent + one policy file governed across HubSpot + Salesforce + Gmail + Slack

infra/
└── docker-compose.yml   Postgres + Redis for local dev
```

## Tech stack

| Layer | Choice |
|---|---|
| API | NestJS 10 on Fastify, TypeScript, ESM |
| DB | Postgres 16 (Drizzle ORM, postgres-js driver) |
| Queue | BullMQ on Redis 7 |
| Frontend | Next.js 15 + React 19 + Tailwind v4 |
| Validation | Zod (shared API ↔ SDK ↔ web) |
| Tests | `node:test` via @swc-node/register |
| Agent auth | sha256-hashed API keys (`agb_…` prefix) |
| Human auth | Clerk JWT verification on the API + dashboard token forwarding |
| Build | pnpm workspaces + Turborepo |

## Development

```bash
pnpm lint                                     # ESLint for API + web
pnpm typecheck                                # whole monorepo
pnpm build                                    # production build
pnpm --filter '@agentbase/api' test             # API test suite
pnpm --filter '@agentbase/web' test:e2e         # dashboard Playwright tests
pnpm --filter '@agentbase/api' dev              # API on :3002 (watch + swc-register)
pnpm --filter '@agentbase/web' dev              # web on :3000
pnpm --filter '@agentbase/db' db:push           # apply schema (interactive)
pnpm --filter '@agentbase/db' db:studio         # Drizzle Studio
```

The test suite requires Postgres on `$DATABASE_URL` (default `postgresql://agentbase:agentbase@localhost:5433/agentbase`). Bring it up via `docker compose -f infra/docker-compose.yml up -d`.

## CI

GitHub Actions runs two quality gates on every push to `main` and every pull request:

- `.github/workflows/ci.yml` installs with the frozen lockfile, runs `pnpm lint`, `pnpm typecheck`, `pnpm build`, applies the Drizzle schema to Postgres, then runs the API test suite.
- `.github/workflows/e2e.yml` starts Postgres and Redis service containers, applies the schema, installs Chromium with Playwright system dependencies, then runs the dashboard E2E suite.

Both workflows use Node 22, pnpm 10, Postgres 16, Redis 7, and the same localhost ports used in local development.

## Configuration

`apps/api/.env`:

```bash
DATABASE_URL=postgresql://agentbase:agentbase@localhost:5433/agentbase
REDIS_URL=redis://localhost:6380
PORT=3002
CONNECTOR_CREDENTIALS_KEY=hex:64656a617661732d6c6f63616c2d646f636b65722d6b65792d33326279746521
API_PUBLIC_URL=http://localhost:3002
DASHBOARD_URL=http://localhost:3000

# Required for the governed revenue-agent runtime. Without it, /v1/campaigns/runs
# enqueues a run but the worker fails the run with a clear error. The
# rest of the platform (policy editor, approvals, audit, connectors)
# works without this key.
ANTHROPIC_API_KEY=sk-ant-...

# Optional — wires real Slack approval cards
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APPROVALS_CHANNEL=C0123456789

# Optional connector OAuth apps. Register matching local callbacks:
# http://localhost:3002/v1/connectors/hubspot/oauth/callback
# http://localhost:3002/v1/connectors/salesforce/oauth/callback
# http://localhost:3002/v1/connectors/gmail/oauth/callback
# http://localhost:3002/v1/connectors/outreach/oauth/callback
HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_SCOPES=crm.objects.contacts.read crm.objects.contacts.write crm.objects.deals.read crm.objects.deals.write
HUBSPOT_REDIRECT_URI=
SALESFORCE_CLIENT_ID=
SALESFORCE_CLIENT_SECRET=
SALESFORCE_SCOPES=api refresh_token
SALESFORCE_REDIRECT_URI=
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_SCOPES=https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.readonly
GMAIL_REDIRECT_URI=
OUTREACH_CLIENT_ID=
OUTREACH_CLIENT_SECRET=
OUTREACH_SCOPES=prospects.all sequenceStates.all tasks.all sequences.read mailboxes.read
OUTREACH_REDIRECT_URI=

# Optional fallback credentials. Dashboard-saved org credentials override these.
HUBSPOT_ACCESS_TOKEN=pat-...

# Optional — wires real Salesforce writes on effect:allow
SALESFORCE_ACCESS_TOKEN=
SALESFORCE_INSTANCE_URL=https://yourdomain.my.salesforce.com

# Optional — wires real Gmail send/draft on effect:allow
GMAIL_ACCESS_TOKEN=                # static bearer fallback; dashboard OAuth is preferred
GMAIL_USER_ID=                     # default 'me'

# Optional — wires real Outreach prospect/sequence/task writes on effect:allow
OUTREACH_ACCESS_TOKEN=             # static bearer fallback; dashboard OAuth is preferred

# Optional — wires real Apollo people/organization match + people search
APOLLO_API_KEY=                    # static API key (X-Api-Key header)
```

Without `SLACK_*` set, approval cards are silently skipped and `/v1/slack/interactive` returns 503. Without dashboard-saved credentials or fallback env vars, connector `effect: allow` actions complete with `status: failed` + `error.code: connector_not_configured`. In production, `CONNECTOR_CREDENTIALS_KEY` is required before storing dashboard-managed connector credentials.

`apps/web/.env.local`:

```bash
API_URL=http://localhost:3002
```

### Production auth (required before any pilot)

In `NODE_ENV=production`, both the API and the dashboard **refuse to boot** if Clerk env vars are missing:

- API needs `CLERK_SECRET_KEY` — `ClerkAuthGuard` throws `UnauthenticatedProductionError` at construction.
- Dashboard needs `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` — the Next middleware throws on module load.

If you really need an unauthenticated production deploy (demos behind a VPN, security-test fixtures, etc.), opt in explicitly with `AGENTBASE_ALLOW_UNAUTHENTICATED=1`. The legacy env var name is retained for compatibility; the boot warning makes the mode visible in logs.

For Fly.io deployments:

```bash
# API app
fly secrets set CLERK_SECRET_KEY=... --config infra/fly.api.toml

# Web/dashboard app
fly secrets set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=... --config infra/fly.web.toml

# Optional escape hatch: explicitly unauthenticated production
fly secrets set AGENTBASE_ALLOW_UNAUTHENTICATED=1 --config infra/fly.api.toml
fly secrets set AGENTBASE_ALLOW_UNAUTHENTICATED=1 --config infra/fly.web.toml
```

For local dev (`NODE_ENV !== 'production'`), Clerk env vars are still optional and the dev-passthrough mode is the default — the dashboard, API, and SDK behave as today.

## Security

A one-page brief for security and IT reviewing a pilot lives in [SECURITY.md](./SECURITY.md). It covers Clerk JWT enforcement, AES-256-GCM credential encryption, per-org tenant isolation, audit logging + export, the current subprocessor list, and what's deliberately not done yet (retention policy, SOC 2, single-tenant deploy, PII redaction, pen test).

## What's deliberately NOT done yet

- **Broader Web E2E tests** — route smoke, connector credential mutation, OAuth env-state, permission profile flows, and dev auth-state coverage exist; approval decisions, action runner flows, and real OAuth redirect browser tests should be added next.
- **More connectors** — five wired (HubSpot, Salesforce, Gmail, Outreach, Apollo). Clearbit, ZoomInfo, Salesloft, LinkedIn Sales Navigator are obvious next adds.
- **Retry / backoff** on connector failures — a transient HubSpot 503 marks the action `failed`; could enqueue and retry via BullMQ.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
