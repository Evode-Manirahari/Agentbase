# TODOS

Deferred work captured during reviews. Each item has enough context to pick up cold.

## Approach B — Agent self-serve onboarding + RBAC

- **What:** Let an agent self-onboard with no human in the loop — a bootstrap path past
  `ClerkAuthGuard` on `POST /v1/agents` so an agent can discover via MCP, create a scoped
  identity, enroll credentials, and make its first governed call; then a human approves/pays.
  Ship RBAC (role-based permissions) as a first-class primitive.
- **Why:** This is what makes the pivot "software agents want" (agent as first-class user), and
  RBAC is Daniel's explicit ask before he rolls Agentbase out to his ops team (the $1k/mo
  customer who pushed for it).
- **Pros:** Defensible; converts Daniel's expansion; delivers the real agent-first front door.
- **Cons:** Net-new auth surface; opens the abuse/funding question (what stops a rogue agent
  self-registering?) — must be answered before public launch. ~30 days.
- **Context:** Design doc Approach B —
  `~/.gstack/projects/Evode-Manirahari-Agentbase/evodemanirahari-unknown-design-20260605-131324.md`.
  Today registration is behind `ClerkAuthGuard` (`apps/api/src/agents/agents.controller.ts`),
  so a human mints the `agb_` key (`apps/api/src/auth/api-key.ts`).
- **Depends on / blocked by:** Abuse/security model for unauthenticated registration must be
  designed first.

## Semantic CRM command surface (action layer for B)

- **What:** A small set of CRM business verbs (e.g. `crm.follow_up_stale_deals`,
  `crm.update_after_call`) composed over the existing connectors + gate, exposed via the MCP
  catalog.
- **Why:** Agents call one semantic command more reliably than chaining low-level CRUD
  (`GET /contacts` → `PATCH /deals` → `POST /notes`); the verb is also the natural unit to scope,
  approve, and audit. Makes the gate pleasant to adopt.
- **Pros:** Cleaner agent surface; each verb is a governable unit.
- **Cons:** Risk of becoming a per-SaaS verb-content treadmill (the "build for all SaaS" trap).
- **Context:** Deferred from Approach A in the eng-review Step 0 scope challenge. Design doc
  "Product Surface: Semantic Commands" section. Existing low-level catalog:
  `packages/mcp-server/src/catalog.ts`.
- **Guardrail:** Start with Maya's actual workflows only. Do NOT build a catalog. Not the
  positioning headline — trust stays the headline.
- **Depends on / blocked by:** Best sequenced with Approach B.

## P3 — Mark agent-runtime/ as a frozen reference

- **What:** Add a one-line marker at the top of `apps/api/src/agent-runtime/` (module README or
  entry file comment) stating it is a frozen reference implementation (the bundled AI SDR) that
  proves the gate, NOT the product. Freeze policy: no new features, just keep CI green.
- **Why:** It's the largest module (14 source files) and least-tested, and the wedge pivot demoted
  it from headline to proof artifact. A marker stops future sessions (human or agent) from
  treating the SDR as the product and from investing in it.
- **Pros:** Clarifies the story for new readers; prevents wasted investment.
- **Cons:** None; documentation-only.
- **Context:** Repo analysis 2026-06-05 (finding 2); decision was "keep as reference, freeze it"
  (not extract to examples/, to avoid breaking the cross-stack demo that imports it).
- **Depends on / blocked by:** None.
