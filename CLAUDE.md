# Agentbase

The safe-action layer for internal AI agents. Every business command your agents
run is scoped, approved, and audited. Canonical positioning lives in
`docs/positioning.md` (enforced by `scripts/check-positioning.sh` in CI).

- TypeScript pnpm/turbo monorepo: `apps/api` (NestJS + Fastify), `apps/marketing`
  (Next.js), `packages/` (sdk, mcp-server, shared, db), `connectors/`.
- Tests: `pnpm test` in `apps/api` (node:test). Integration tests need Postgres
  on 5433 + Redis on 6380 via `docker compose -f infra/docker-compose.yml up -d`,
  schema via `pnpm --filter @agentbase/db db:push`.
- `apps/api/src/agent-runtime/` is a frozen reference implementation (the bundled
  AI SDR that proves the gate). No new features there.
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
