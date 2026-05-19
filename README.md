# Dejavas

> An AI SDR you can run in production — because every risky action is approval-gated and audit-ready by default.

[![CI](https://github.com/Evode-Manirahari/Agentbase/actions/workflows/ci.yml/badge.svg)](https://github.com/Evode-Manirahari/Agentbase/actions/workflows/ci.yml)

> The product name is **Dejavas**. The repository is named **Agentbase**.

## What this is

RevOps teams are buying AI SDRs and watching them stall. The pattern is consistent: the agent works in demos, but the moment it tries to write to Salesforce, update a HubSpot deal, or send a real email, security pulls the OAuth scopes and the pilot dies in draft-only mode.

Dejavas ships the **agent and the safety rails together**:

- The agent is an AI SDR that enriches inbound leads (Apollo), upserts CRM contacts (HubSpot or Salesforce), drafts personalized outreach (Claude `claude-opus-4-7`), and sends — through the gate.
- The gate is the approval workflow, policy templates, audit export, and Slack-driven human-in-the-loop that PR-1-through-3 of this repo wired. Every tool call the agent makes runs through the same `ActionsService.execute` path an external customer would — so the safety story is true at the code level, not marketing.

The pitch:

> **An AI SDR a RevOps team can run in production today, because security can read the policy YAML, audit the export, and approve every risky write in Slack before it touches a CRM record.**

Buyer is RevOps / Revenue Systems leaders; security and IT are the required sign-off. Expansion jobs (AI CRM hygiene v1.1, AI deal-update agent v1.2) sit on the same runtime — adding a new "job" is data + prompts, not a new product.

## How the demo works

End-to-end in <2 minutes once the API is up:

1. Open `http://localhost:3000/campaigns`.
2. Pick the **AI SDR — outbound** job and an active agent identity.
3. Paste a lead email + optional notes. Click **Run**.
4. You're redirected to `/campaigns/[id]`, which polls live as Claude:
   - calls `apollo.people.match` and `apollo.organizations.match` (auto-execute)
   - calls `hubspot.contacts.upsert` (auto-execute)
   - calls `gmail.draft.create` (auto-execute)
   - calls `gmail.send` → **policy pauses the run** ([approval-before-external-email](#) template fires)
5. A Slack approval card lands in `#agent-approvals` with the full email body, recipient, and policy reason.
6. Approver clicks ✓. The action transitions to `executed`, the worker picks up the resume job, the loop continues, and the dashboard timeline updates to `completed` with a final summary from Claude.
7. Every state transition is in the audit log; **Download CSV** on `/audit` hands security the evidence.

The same loop runs on Salesforce + Gmail + Slack instead of HubSpot if that's the customer's stack — the SDR job uses Apollo + HubSpot today, but the runtime is connector-agnostic.

## Status

Early. The full demoable loop works end-to-end locally. Production auth now fails closed unless Clerk is configured or an explicit unauthenticated escape hatch is set; broader production hardening is still incomplete. No customers yet.

## What works today

The agent:

- **Agent runtime** — generic loop on the API (`apps/api/src/agent-runtime/`) that takes a `Job` config (system prompt + tool list + initial-message builder) and a context, calls Claude via the Anthropic SDK with adaptive thinking and `xhigh` effort, dispatches every tool call through the existing approval gate, and returns a transcript. Pauses cleanly on `awaiting_approval`; resumes when the approval lands. Single tool per turn via `disable_parallel_tool_use` so pause state stays simple.
- **AI SDR job (v1)** — the first job. Enrich the lead, upsert the CRM contact, draft a personalized email, send it. The send hits the `approval-before-external-email` template (auto-paused for human review). System prompt forces sequential tool calls and concise reasoning.
- **Async runs + resume** — `agent_runs` table persists conversation state. `POST /v1/campaigns/runs` enqueues a BullMQ job, returns the run id immediately. `GET /v1/campaigns/runs/:id` is polled by the dashboard. When a Slack approval (or the expiry sweeper) transitions the action out of `awaiting_approval`, `ApprovalsService` notifies `AgentRunsService` and a resume job continues the loop with the resolved tool_result.
- **Campaigns dashboard** — `/campaigns` form to paste a lead, redirect to `/campaigns/[id]` with live polling. Recent runs table on the index page. Transcript view tones agent_thinking / agent_message / tool_call / tool_result blocks by status (allow=green, require_approval=amber, deny/failed=rose).

The safety rails:

- **Approval workflow** — DB-backed pending queue, transactional decide endpoint, idempotency (409), 24h TTL, BullMQ-backed expiry sweeper on Redis
- **Slack approval cards** — interactive Approve / Deny buttons with the full action payload, signed webhook (HMAC + 5-min replay window), per-rule channel routing, two-way consistency (web decisions update the Slack card via `chat.update`)
- **Policy templates** — three one-click templates that cover the most common pilot questions: require approval before external email, require approval on CRM writes over $10k, and deny delete/export/bulk actions. Sit above the YAML editor so the RevOps buyer never has to write Rego on call one.
- **Audit log + export** — every state transition recorded with actor type/id, exportable as RFC 4180 CSV or JSON straight from the dashboard, so security teams can take evidence into SOC 2 reviews and questionnaires
- **Production auth refusal** — `ClerkAuthGuard` and the Next middleware both throw at boot if `NODE_ENV=production` and Clerk env vars aren't set; explicit `DEJAVAS_ALLOW_UNAUTHENTICATED=1` is the only way to opt out

The plumbing both sides share:

- **Identity & API keys** — register agents, assign permission profiles, issue scoped `dvk_…` tokens (sha256-hashed at rest), and revoke agents idempotently
- **Permission profiles** — Sales SDR, RevOps Admin, Support Agent, Read-only Analyst, and Custom — used to seed policy templates per agent role
- **Policy DSL** — YAML + Zod, rule-based effects (`allow` / `require_approval` / `deny`), tool glob matching, agent id/name/profile matching, dotted-path conditions with `eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`in`/`contains`/`exists`; the templates compile to this, and security can read it
- **GTM connectors** — Salesforce, HubSpot, Gmail, Outreach, and Apollo, all behind the same approval gate, with Zod-validated params and structured connector errors. Pilots ship on Salesforce + Gmail + Slack or HubSpot + Gmail + Slack; the rest are available if a customer asks.
- **Org-scoped connector credentials** — HubSpot, Salesforce, Gmail, and Outreach OAuth install/reconnect plus dashboard-managed static credentials override process env vars per org, are AES-256-GCM encrypted at rest, refresh access tokens before connector dispatch, show account/expiry metadata, can be tested from the dashboard, and can be disabled to block inherited env fallback
- **Web dashboard** (Next.js 15 + Tailwind v4) — Overview, Campaigns, Agents, Policies (templates + YAML editor), Approvals (web inbox alongside Slack), Actions, Connectors, Webhooks, Audit
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
DATABASE_URL=postgresql://dejavas:dejavas@localhost:5433/dejavas \
  pnpm --filter '@dejavas/db' exec drizzle-kit push --force

# Env
cp apps/api/.env.example apps/api/.env

# API on :3002
pnpm --filter '@dejavas/api' dev

# Web on :3000 (in another terminal)
pnpm --filter '@dejavas/web' dev
```

### Deploy to Fly.io

Two Fly apps (api + web) wired by setting `API_URL` on the web app to point at the api app's `.fly.dev` URL. Configs are in `infra/fly.api.toml` and `infra/fly.web.toml` — edit the `app =` placeholders, then:

```bash
# API
fly apps create dejavas-api-CHANGEME --config infra/fly.api.toml
fly postgres create --name dejavas-pg-CHANGEME --region iad
fly postgres attach dejavas-pg-CHANGEME --app dejavas-api-CHANGEME       # sets DATABASE_URL
fly redis create --name dejavas-redis-CHANGEME --region iad
fly secrets set REDIS_URL=redis://... --config infra/fly.api.toml
fly secrets set CONNECTOR_CREDENTIALS_KEY="base64:$(openssl rand -base64 32)" --config infra/fly.api.toml
fly secrets set API_PUBLIC_URL=https://dejavas-api-CHANGEME.fly.dev DASHBOARD_URL=https://dejavas-web-CHANGEME.fly.dev --config infra/fly.api.toml
fly deploy --config infra/fly.api.toml --remote-only

# Web (after the API is live)
fly apps create dejavas-web-CHANGEME --config infra/fly.web.toml
fly secrets set API_URL=https://dejavas-api-CHANGEME.fly.dev --config infra/fly.web.toml
fly deploy --config infra/fly.web.toml --remote-only
```

Both Fly configs use `auto_stop_machines = "stop"` so you only pay for active traffic, and `min_machines_running = 0` so idle apps cost ~0. The api's `[[http_service.checks]]` hits `/health` every 30s.

To plug in real connectors after deploy, connect HubSpot, Salesforce, Gmail, or Outreach from the dashboard, save static credentials in the Connectors page, or set fallback env vars with `fly secrets set` (HubSpot / Salesforce / Gmail / Outreach / Apollo / Slack tokens). Org-scoped credentials override fallback env vars. Each connector independently degrades to `connector_not_configured` when its tokens are absent or disabled for the org.

For connector OAuth, register the matching redirect URLs in each provider app:

```text
https://dejavas-api-CHANGEME.fly.dev/v1/connectors/hubspot/oauth/callback
https://dejavas-api-CHANGEME.fly.dev/v1/connectors/salesforce/oauth/callback
https://dejavas-api-CHANGEME.fly.dev/v1/connectors/gmail/oauth/callback
https://dejavas-api-CHANGEME.fly.dev/v1/connectors/outreach/oauth/callback
```

Then set the provider's `*_CLIENT_ID` and `*_CLIENT_SECRET` on the API app.

## Smoke-test the loop

```bash
# 1. Register an agent and capture the dvk_ key
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
  -d '{"decision":"approve","decided_by_email":"alice@dejavas.test"}'
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
└── sdk/                 @dejavas/sdk client (what agents import)

connectors/
├── hubspot/             HubspotConnector (CRM v3)
├── salesforce/          SalesforceConnector (REST v60)
├── gmail/               GmailConnector (Gmail v1; RFC 2822 + base64url)
├── outreach/            OutreachConnector (v2; JSON:API envelopes)
└── apollo/              ApolloConnector (v1; X-Api-Key auth)

examples/
└── demo-agent/          Reference agent that uses @dejavas/sdk

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
| Agent auth | sha256-hashed API keys (`dvk_…` prefix) |
| Human auth | Clerk JWT verification on the API + dashboard token forwarding |
| Build | pnpm workspaces + Turborepo |

## Development

```bash
pnpm lint                                     # ESLint for API + web
pnpm typecheck                                # whole monorepo
pnpm build                                    # production build
pnpm --filter '@dejavas/api' test             # API test suite
pnpm --filter '@dejavas/web' test:e2e         # dashboard Playwright tests
pnpm --filter '@dejavas/api' dev              # API on :3002 (watch + swc-register)
pnpm --filter '@dejavas/web' dev              # web on :3000
pnpm --filter '@dejavas/db' db:push           # apply schema (interactive)
pnpm --filter '@dejavas/db' db:studio         # Drizzle Studio
```

The test suite requires Postgres on `$DATABASE_URL` (default `postgresql://dejavas:dejavas@localhost:5433/dejavas`). Bring it up via `docker compose -f infra/docker-compose.yml up -d`.

## CI

GitHub Actions runs two quality gates on every push to `main` and every pull request:

- `.github/workflows/ci.yml` installs with the frozen lockfile, runs `pnpm lint`, `pnpm typecheck`, `pnpm build`, applies the Drizzle schema to Postgres, then runs the API test suite.
- `.github/workflows/e2e.yml` starts Postgres and Redis service containers, applies the schema, installs Chromium with Playwright system dependencies, then runs the dashboard E2E suite.

Both workflows use Node 22, pnpm 10, Postgres 16, Redis 7, and the same localhost ports used in local development.

## Configuration

`apps/api/.env`:

```bash
DATABASE_URL=postgresql://dejavas:dejavas@localhost:5433/dejavas
REDIS_URL=redis://localhost:6380
PORT=3002
CONNECTOR_CREDENTIALS_KEY=hex:64656a617661732d6c6f63616c2d646f636b65722d6b65792d33326279746521
API_PUBLIC_URL=http://localhost:3002
DASHBOARD_URL=http://localhost:3000

# Required for the AI SDR agent runtime. Without it, /v1/campaigns/runs
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

If you really need an unauthenticated production deploy (demos behind a VPN, security-test fixtures, etc.), opt in explicitly with `DEJAVAS_ALLOW_UNAUTHENTICATED=1`. The boot warning makes the mode visible in logs.

For Fly.io deployments:

```bash
# API app
fly secrets set CLERK_SECRET_KEY=... --config infra/fly.api.toml

# Web/dashboard app
fly secrets set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=... --config infra/fly.web.toml

# Optional escape hatch: explicitly unauthenticated production
fly secrets set DEJAVAS_ALLOW_UNAUTHENTICATED=1 --config infra/fly.api.toml
fly secrets set DEJAVAS_ALLOW_UNAUTHENTICATED=1 --config infra/fly.web.toml
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
