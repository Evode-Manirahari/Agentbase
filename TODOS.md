# TODOS

Sequencing and deferred work. Each item has enough context to pick up cold.

> **Demand status, verified 2026-11-16: Agentbase has ZERO users and ZERO customers.**
> Nobody outside the founder has run anything in this repo. There is no billing code.
> Earlier revisions of this file cited "Daniel" and "Maya" as customers; both were personas
> invented during a 2026-06-05 office-hours exercise. Do not cite them, or any customer, as
> evidence for prioritisation until a named human has actually run the audit or paid.

## Direction (2026-11-16): booking integrity for voice agents

The horizontal "commit layer for every agent" headline is retired. The product is the
booking audit; the commit engine is what a fix will be built on. Design doc:
`~/.gstack/projects/Evode-Manirahari-Agentbase/evodemanirahari-main-design-20261116-102154.md`.

## NOW — get the audit in front of one outside builder

Shipped on `feat/booking-audit` (2026-11-16): `packages/booking-audit` (Retell, four checks,
HTML report, `demo` command), `examples/voice-booking-repro`, repositioned docs and landing page.

- [ ] **Run it on real Retell data.** Everything is tested against hand-built fixtures shaped
      like the API reference. It has never read a real call log. Make a throwaway booking agent,
      place 20+ real calls including forced duplicates and a forced timeout, and audit them.
      Fix what breaks before anyone else sees it. Blocks: nothing. Needs: a Retell account.
- [ ] **Send the six messages** (the assignment in the design doc). Reply in the live Retell
      duplicate-booking thread and message five more people who reported a booking bug in the
      last 90 days, asking to test the audit on a real export. Log every reply, one file per
      person, in `~/.gstack/projects/Evode-Manirahari-Agentbase/outreach/`. NOT in this repo: it
      is public.
- [ ] **Publish to npm.** `.github/workflows/publish-booking-audit.yml` publishes on a
      `booking-audit-v*` tag. Before the first tag: confirm the package name is one you own
      (the `@agentbase` scope has not been checked) and add the `NPM_TOKEN` secret. Then replace
      every "not on npm yet" with the `npx` line and drop that marker from
      `scripts/check-positioning.sh`.
- [ ] **Vapi adapter.** Same normalized model (`packages/booking-audit/src/types.ts`), new
      `normalize-vapi.ts`. Take field names from Vapi's official API reference at build time.
      The shape seen during research came from a third-party page and is not trusted.
- [ ] **Deploy the landing page.** `apps/marketing` builds; it has never been deployed.

Success criteria and stop rule (from the design doc):

- By 2026-11-30: posted where the bug is reported in 5+ threads or communities; 3+ outside
  builders have run the audit on real calls and said so.
- By 2026-12-14: at least one agency ran it on more than one client account (the first-payer
  test).
- **Stop rule:** fewer than 3 outside runs by 2026-12-14 after 10+ posts means stage two does
  not get built. The next question is whether the bet or the channel is wrong.

## GATED — stage two: the commit endpoint (do NOT build yet)

- **What:** one URL in front of a builder's existing booking webhook. Retell and Vapi adapters,
  a booking-intent key, confirmed / failed / unknown replies the agent can speak, a callback
  queue for unknowns, per-call receipts. Built on `apps/api/src/actions/` (reserve, dispatch,
  settle, quarantine, resolve).
- **Gate:** ONE outside builder runs the audit on real calls, finds something, and asks how to
  stop it. An explicit ask, not a like. Build it for that builder's stack, as a design partner.
- **Until then:** no proxy, no hosted service, no billing, no dashboard work.
- **Why gated:** it asks strangers to route live bookings through a solo developer's service.
  Three positionings were built before a user existed. This one waits for the user.
- **Open design questions for when it unlocks:** unify the audit's intent key
  (`packages/booking-audit/src/canonical.ts`) with the API's request hash; what a lookup
  finding nothing should mean (the reproduction keeps it unknown); per-backend dedupe modes
  for Cal.com, GoHighLevel, Google Calendar.

## Known limits of the audit (v0.1)

- **F5, the same booking across two calls,** is not checked. A caller who rings back and gets
  booked again is invisible to a per-call audit.
- **Claim detection is English-only pattern matching.** Target: 9 of 10 F3 flags judged correct
  by a builder on their own calls. If real data misses that, add an optional
  bring-your-own-key model pass. Do not add it speculatively.
- **F2 misses a fallback that happens after an agent-only turn.** It needs "no caller speech
  between", so an agent that says "one moment" and then books a different slot is not flagged.
- **Other packages' test scripts use `@swc-node/register`, which fails to load on Node 24.**
  CI is on Node 22 so it is green there. `packages/booking-audit` uses `tsx` and works on both.
  Migrating the rest is a small, separate change.

## PARKED with the horizontal positioning

The three items below were written for the retired positioning. They stay parked, and none of
them unparks on the new product's gate.

## Approach B — Agent self-serve onboarding + RBAC

- **What:** Let an agent self-onboard with no human in the loop — a bootstrap path past
  `ClerkAuthGuard` on `POST /v1/agents` so an agent can discover via MCP, create a scoped
  identity, enroll credentials, and make its first governed call; then a human approves/pays.
  Ship RBAC (role-based permissions) as a first-class primitive.
- **Why:** This is what makes the pivot "software agents want" (agent as first-class user).
  RBAC is a hypothesised requirement, not a request from anyone — no user has asked for it.
- **Pros:** Delivers the agent-first front door if the hypothesis holds.
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
- **Guardrail:** Start with one real user's actual workflows — and there is no such user
  yet, so this stays blocked. Do NOT build a catalog. Not the positioning headline —
  trust stays the headline.
- **Depends on / blocked by:** Best sequenced with Approach B.

## PARKED — "Customization runtime for the agent era" (do NOT build)

- **What:** The thesis that companies will need a runtime layer to adapt agent behavior
  (filter options, validate actions, inject business context) without waiting on the SaaS
  vendor. Per the Codex-revised framing (office-hours 2026-06-09): not a separate product —
  a possible **future of Agentbase's policy engine** (context-aware policy over agent actions).
- **Why parked:** Zero demand evidence toward us. The one real specimen — Preeti Singh
  (S&P Global), Salesforce Trailblazer, Dec 2023: CPQ Favorite Lookup couldn't filter by the
  quote's `Sales_Org__c`; Salesforce said "technically not possible"; her team shipped a
  validation-rule workaround by Apr 2024 — is 2.5 years cold, already worked around, has no
  agents in it, and was never an ask directed at us. "A fair abstraction, but it is not a quote."
- **Revisit triggers (the only ways this unparks):**
  - **n=1** — a real prospect engages (scheduled call or explicit "show me"): permits a
    context-conditions demo ONLY (conditions on existing gate actions — no new action types,
    no UI-override layer, no per-tenant runtime).
  - **n=3** — three or more real, paying-track customers ask **unprompted** for
    record/department/deal-stage-dependent approvals or validation: the thesis graduates to
    the policy-engine roadmap.
  - First paying customer or a deliberate pivot decision also reopens the discussion.
- **Context:** Office-hours design doc 2026-06-09 (APPROVED, adversarial review 9/10) —
  `~/.gstack/projects/Evode-Manirahari-Agentbase/evodemanirahari-p1-trust-primitive-coverage-design-20260609-124748.md`.
- **Depends on / blocked by:** Demand validation for the existing wedge (Stripe link + live
  outreach; zero-reply rule dated 2026-06-19). Nothing customization-runtime-shaped ships
  before the triggers above.

## DONE — Mark agent-runtime/ as a frozen reference

Shipped: `apps/api/src/agent-runtime/README.md` plus a header comment on
`agent-runtime.module.ts`. Freeze policy is written down there — no new
features, keep CI green, and improving the SDR is not progress.
