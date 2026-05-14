# Dejavas

> Secure action layer for AI sales agents. Identity, scoped permissions, approval routing, and audit trails — across the revenue stack.

[![CI](https://github.com/Evode-Manirahari/Agentbase/actions/workflows/ci.yml/badge.svg)](https://github.com/Evode-Manirahari/Agentbase/actions/workflows/ci.yml)

> The product name is **Dejavas**. The repository is named **Agentbase**.

## What this is

Sales teams are deploying AI agents into Salesforce, HubSpot, Gmail, Slack, and enrichment tools — and security teams are blocking them before they can touch revenue systems.

Agents can research accounts, enrich leads, update CRM fields, draft emails, create tasks, and summarize deal activity. But they need scoped permissions, approval rules, revocation, and audit trails before enterprises will let them act.

Dejavas is a cross-stack control plane that gives every agent an identity, governs what it can do, routes sensitive actions to humans for approval, and monitors everything across the sales stack. We sell first to RevOps teams deploying agents, with security and IT as the required sign-off.

Salesforce, HubSpot, and Outreach will govern agents inside their own products. Dejavas governs agents *across the full revenue workflow*.

In short: **Okta + Zapier + Datadog for AI sales agents.**

## Status

Early. The full demoable loop works end-to-end locally; nothing is hardened for production. No customers yet.

## What works today

- **Identity & API keys** — register agents, scoped `dvk_…` tokens (sha256-hashed at rest), idempotent revocation
- **Policy DSL (YAML + Zod)** — rule-based effects (`allow` / `require_approval` / `deny`), tool glob matching, dotted-path conditions, 9 operators (`eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`in`/`contains`/`exists`)
- **Connector dispatch** — five connectors out of the box: HubSpot CRM v3 (contacts + deals), Salesforce REST v60 (Account + Opportunity + Contact), Gmail v1 (send + draft + messages.get), Outreach v2 (prospects + sequence enrollment + tasks), and Apollo v1 (people.match + organizations.match + people.search), all with structured errors and Zod-validated params
- **Org-scoped connector credentials** — dashboard-managed credentials override process env vars per org, are AES-256-GCM encrypted at rest, and can be disabled to block inherited env fallback
- **Approval workflow** — DB-backed pending queue, transactional decide endpoint, idempotency (409), 24h TTL, BullMQ-backed expiry sweeper on Redis
- **Slack approval cards** — interactive buttons, signed webhook (HMAC + 5-min replay window), per-rule channel routing, two-way consistency (web decisions update the Slack card via `chat.update`)
- **Audit log** — every state transition recorded with actor type/id
- **Web dashboard** (Next.js 15 + Tailwind v4) — Overview, Agents (register / type-to-confirm revoke / reveal-key-once banner), Policies (live YAML+Zod editor), Approvals (web inbox with approve/deny), Actions, Connectors, Webhooks, Audit
- **Tests** — 261 API tests passing across 52 suites, plus Playwright coverage for dashboard routes

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
HUBSPOT_ACCESS_TOKEN=pat-... SLACK_BOT_TOKEN=xoxb-... \
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
fly secrets set CONNECTOR_CREDENTIALS_KEY="$(openssl rand -base64 32)" --config infra/fly.api.toml
fly deploy --config infra/fly.api.toml --remote-only

# Web (after the API is live)
fly apps create dejavas-web-CHANGEME --config infra/fly.web.toml
fly secrets set API_URL=https://dejavas-api-CHANGEME.fly.dev --config infra/fly.web.toml
fly deploy --config infra/fly.web.toml --remote-only
```

Both Fly configs use `auto_stop_machines = "stop"` so you only pay for active traffic, and `min_machines_running = 0` so idle apps cost ~0. The api's `[[http_service.checks]]` hits `/health` every 30s.

To plug in real connectors after deploy, either save credentials in the dashboard's Connectors page or set fallback env vars with `fly secrets set` (HubSpot / Salesforce / Gmail / Outreach / Apollo / Slack tokens). Org-scoped credentials override fallback env vars. Each connector independently degrades to `connector_not_configured` when its tokens are absent or disabled for the org.

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
  -d '{"name":"demo","yaml":"version: 1\ndefault: deny\nrules:\n  - match: { tool: hubspot.contacts.update }\n    effect: allow\n  - match:\n      tool: hubspot.deals.update\n      when: { amount: { gt: 10000 } }\n    effect: require_approval\n    slack_channel: \"#critical-approvals\"\n"}'

# 3. Execute an action (small deal: should auto-deny under default-deny)
curl -s -X POST localhost:3002/v1/actions/execute \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"tool":"hubspot.deals.update","params":{"dealId":"d1","amount":50000}}'
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
│       ├── agents/      register / list / revoke
│       ├── actions/     POST /v1/actions/execute (the SDK proxy)
│       ├── approvals/   list / decide / Slack-card lifecycle
│       ├── policy/      YAML/Zod engine + active-policy lifecycle
│       ├── connectors/  ConnectorRegistry (HubSpot wired)
│       ├── slack/       approval cards + interactive webhook
│       ├── queue/       BullMQ expiry sweeper (every 60s)
│       ├── audit/       immutable log
│       ├── auth/        API-key guard + key generation
│       ├── connectors/  connector registry + org-scoped credential store
│       └── db/          DI for Drizzle client
└── web/                 Next.js 15 dashboard (App Router, Tailwind v4)
    └── src/app/
        ├── page.tsx       Overview
        ├── agents/        register + revoke
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
pnpm typecheck                                # whole monorepo
pnpm --filter '@dejavas/api' test             # 261 tests, ~5s
pnpm --filter '@dejavas/api' dev              # API on :3002 (watch + swc-register)
pnpm --filter '@dejavas/web' dev              # web on :3000
pnpm --filter '@dejavas/db' db:push           # apply schema (interactive)
pnpm --filter '@dejavas/db' db:studio         # Drizzle Studio
```

The test suite requires Postgres on `$DATABASE_URL` (default `postgresql://dejavas:dejavas@localhost:5433/dejavas`). Bring it up via `docker compose -f infra/docker-compose.yml up -d`.

## Configuration

`apps/api/.env`:

```bash
DATABASE_URL=postgresql://dejavas:dejavas@localhost:5433/dejavas
REDIS_URL=redis://localhost:6380
PORT=3002
CONNECTOR_CREDENTIALS_KEY=change-me-32-byte-minimum-local-dev-key

# Optional — wires real Slack approval cards
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APPROVALS_CHANNEL=C0123456789

# Optional fallback credentials. Dashboard-saved org credentials override these.
# Wires real HubSpot writes on effect:allow
HUBSPOT_ACCESS_TOKEN=pat-...

# Optional — wires real Salesforce writes on effect:allow
SALESFORCE_ACCESS_TOKEN=
SALESFORCE_INSTANCE_URL=https://yourdomain.my.salesforce.com

# Optional — wires real Gmail send/draft on effect:allow
GMAIL_ACCESS_TOKEN=                # OAuth bearer (refresh-token flow not yet wired)
GMAIL_USER_ID=                     # default 'me'

# Optional — wires real Outreach prospect/sequence/task writes on effect:allow
OUTREACH_ACCESS_TOKEN=             # OAuth bearer (refresh-token flow not yet wired)

# Optional — wires real Apollo people/organization match + people search
APOLLO_API_KEY=                    # static API key (X-Api-Key header)
```

Without `SLACK_*` set, approval cards are silently skipped and `/v1/slack/interactive` returns 503. Without dashboard-saved credentials or fallback env vars, connector `effect: allow` actions complete with `status: failed` + `error.code: connector_not_configured`. In production, `CONNECTOR_CREDENTIALS_KEY` is required before storing dashboard-managed connector credentials.

`apps/web/.env.local`:

```bash
API_URL=http://localhost:3002
```

## What's deliberately NOT done yet

- **Web Clerk integration** — backend now verifies Clerk session tokens via @clerk/backend on every management endpoint, but the Next.js dashboard still hits the API without one. Set `CLERK_SECRET_KEY` (and the frontend bits — ClerkProvider + middleware + token forwarding in `apps/web/src/lib/api.ts`) before any non-localhost deploy. With `CLERK_SECRET_KEY` unset, the guard logs a warning at boot and lets every request through — that's what local dev uses.
- **Full OAuth installation flow** — org-scoped static credentials work, but real multi-tenant SaaS still needs OAuth connect/reconnect screens and token refresh.
- **Broader Web E2E tests** — route smoke coverage exists; form mutation and auth-state browser tests should be added next.
- **OAuth refresh-token flow** — Gmail and Outreach both take a static access token currently; production needs the refresh-token loop on both.
- **More connectors** — five wired (HubSpot, Salesforce, Gmail, Outreach, Apollo). Clearbit, ZoomInfo, Salesloft, LinkedIn Sales Navigator are obvious next adds.
- **Retry / backoff** on connector failures — a transient HubSpot 503 marks the action `failed`; could enqueue and retry via BullMQ.

## License

TBD.
