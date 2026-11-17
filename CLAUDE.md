# Agentbase

**Booking integrity for voice agents.** Find the bookings a voice agent
duplicated, never confirmed with the caller, or never made, and say so when the
outcome is unknown.

- The product today is `packages/booking-audit`: a read-only CLI over
  voice-platform call logs (Retell first). It runs locally, has zero runtime
  dependencies, and redacts by default.
- The commit engine (`apps/api`, protocol in `docs/effect-commit.md`) is what
  will prevent the failures the audit finds. It is NOT wired to voice platforms.
  Do not build the commit endpoint, hosting, billing, or dashboard features
  until one outside builder has run the audit on real calls and asked how to
  stop the findings. The gate is in `TODOS.md`.
- Canonical positioning lives in `docs/positioning.md` (enforced by
  `scripts/check-positioning.sh` in CI, which bans every retired headline).

Two honesty rules. Never break either in code comments, docs, or copy:

1. The audit reads the call log only. When it cannot see an outcome it reports
   `unknown` or "unverified claim", never "failed" or "missing". Never upgrade
   an unknown to a known.
2. The engine's guarantee is CONDITIONAL: at-most-once holds only where the
   provider deduplicates. Never state it unconditionally.

Never describe users, pilots, or revenue that do not exist. Sample call data is
synthetic and must be labeled as made up wherever it appears.

- TypeScript pnpm/turbo monorepo: `packages/booking-audit` (the product),
  `apps/api` (NestJS + Fastify, the engine), `apps/web`, `apps/marketing`
  (Next.js), `packages/` (sdk, mcp-server, shared, db, effects), `connectors/`.
- Audit tests: `pnpm --filter @agentbase/booking-audit test`. No services
  needed. They run on `tsx`, because `@swc-node/register` fails to load on
  Node 24 and the other packages' test scripts still use it (CI is on Node 22).
- API tests: `pnpm test` in `apps/api` (node:test). Integration tests need
  Postgres on 5433 + Redis on 6380 via
  `docker compose -f infra/docker-compose.yml up -d`, schema via
  `pnpm --filter @agentbase/db db:push`.
- Frozen, no new features: `apps/api/src/agent-runtime/` (the bundled AI SDR),
  the sales connectors, Slack approvals, the policy editor, and the dashboard.
- Never commit call logs or audit output. `.booking-audit-cache/`,
  `booking-audit-report/` and `booking-audit-demo/` are gitignored because the
  repo is public and the cache holds raw transcripts.
- Deferred work and sequencing live in `TODOS.md`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
