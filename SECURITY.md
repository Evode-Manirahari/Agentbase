# Dejavas Security Brief

One-pager for security and IT reviewing a Dejavas pilot. Honest about what's in place and what isn't.

## Threat model

The pilot question is: *can we let an AI agent take a write action on a revenue system without giving it unsupervised write access?* Dejavas exists to make that question answerable as "yes, under these constraints."

The constraints we enforce:

1. Every action proposed by an agent is mediated by a policy decision before any external API call.
2. Risky writes (outbound email, high-value CRM updates, destructive operations) must require a human to approve in Slack or the dashboard before they execute.
3. Compromised agent credentials must be revocable in seconds.
4. Every decision and execution must be recorded in an audit log that the customer can export.

## What's in place

### Authentication & identity

- **Management API + dashboard** — Clerk session tokens verified server-side via `@clerk/backend`'s `verifyToken` with the configured Clerk secret key. In `NODE_ENV=production`, the API's `ClerkAuthGuard` and the Next dashboard middleware **refuse to boot** without `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` respectively. `DEJAVAS_ALLOW_UNAUTHENTICATED=1` is the only way to opt out, and it logs a boot warning.
- **Agent → API** — scoped `dvk_…` API keys. SHA-256-hashed at rest, never logged, revealed once at creation, idempotently revocable.
- **Slack → API** — every interactive payload HMAC-signed with the workspace signing secret; a 5-minute replay window is enforced.
- **Outbound webhooks** — each event HMAC-signed with the subscription secret so customer endpoints can verify origin.

### Tenant isolation

Every domain table — `agents`, `policies`, `approvals`, `actions`, `audit_log`, `connector_credentials`, `webhook_subscriptions` — carries `org_id` with `on delete cascade`. Service-layer queries scope by `org_id` on every read and every write; there are no "any-org" code paths in the policy or approval evaluation flow.

### Credentials & encryption

- **In transit** — TLS to every upstream API (HubSpot, Salesforce, Gmail, Outreach, Apollo, Slack, Clerk). Fly deploys terminate HTTPS on the edge.
- **At rest** — OAuth refresh tokens and dashboard-managed static connector credentials are encrypted with **AES-256-GCM** (v1 envelope, explicit algorithm pinning) using `CONNECTOR_CREDENTIALS_KEY` (32-byte key from environment). API keys are SHA-256 hashed, never reversed. Clerk session tokens never touch our storage.
- **Credential lifecycle** — credentials are org-scoped and override fallback env vars per org. OAuth access tokens refresh before connector dispatch when they're inside the expiry window. Credentials can be tested from the dashboard and disabled per-provider to block fallback inheritance.

### Approval & audit

- **Approvals** — DB-backed transactional decide endpoint. Idempotency-aware: replayed decisions return `409 Conflict` without changing state. Each approval carries a 24-hour TTL; a BullMQ-backed sweeper marks stale rows `expired` and the matching action `denied`. Slack approve/deny webhook is HMAC + replay-windowed; web decisions update the Slack card via `chat.update` so the two surfaces stay consistent.
- **Audit log** — every state transition is recorded: agent registered, agent revoked, policy installed, action proposed, action approved, action denied, action executed, action failed, approval expired. Each row stores actor type, actor id, event type, the action payload, and timestamp.
- **Audit export** — RFC 4180 CSV or JSON straight from the dashboard, capped at 10,000 rows by default with a 50,000 hard ceiling. CSV cells with formula-injection prefixes (`=`, `+`, `-`, `@`) are neutralized with a leading apostrophe so an `Open in Excel` won't execute scalar values. Filenames include an ISO timestamp.

### Deployment model

Pilots run on Dejavas-managed multi-tenant infrastructure (Fly.io: Postgres + Redis + API + dashboard). Single-tenant deployment, VPC peering, and customer-cloud delivery are on the roadmap — not built today.

## Subprocessors

| Subprocessor | Purpose | Data sent |
| --- | --- | --- |
| Clerk | Human authentication | Email, session metadata |
| Fly.io | Compute + managed Postgres + managed Redis | All product data |
| HubSpot, Salesforce, Gmail, Outreach, Apollo | GTM connector APIs | Only when the org enables the connector; only the payload the agent is sending |
| Slack | Approval cards | Action payload details needed for approval |
| Anthropic | Only when an org runs the bundled Claude-driven demo agent | Prompt + tool-use payload |

## Limitations — deliberately not done yet

- **Audit retention policy** — audit rows accumulate indefinitely. Customer-specified retention and export-and-purge are on the roadmap.
- **PII redaction in audit** — payloads store raw action params (including drafted email bodies). No automatic scrubbing today.
- **Single-tenant deploy / VPC / data residency** — not built. Pilots run on shared multi-tenant infra.
- **SOC 2** — not completed yet; targeted before SMB GA.
- **Penetration test** — not commissioned yet.
- **Quantitative uptime SLA** — pilots are best-effort.

## Vulnerability disclosure

Email **security@dejavas.ai** with reproduction steps. We don't run a paid bounty program yet but will credit reporters on request, and we treat disclosure under safe harbor terms (no legal action for good-faith research).

## Operating contacts

- Security & incident response — **security@dejavas.ai** (24-hour target during pilots; faster on request).
