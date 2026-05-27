# cross-stack-demo

The worked example for Agentbase's core differentiator: **one agent, one
policy file, one approval queue — across the entire revenue stack.**

`demo-agent` (the sibling example) shows the single-CRM flow. This one shows
what Salesforce-and-HubSpot competitors structurally can't: a control plane
that doesn't care which vendor's tool the agent is reaching for.

## What the agent does

A single sales-development agent processes one inbound lead and:

1. Enriches person + company via Apollo
2. **Mirrors the contact into HubSpot** (`hubspot.contacts.upsert`)
3. **Mirrors the same contact into Salesforce** (`salesforce.contact.create`)
4. Opens an $8k Salesforce opportunity — auto-allowed
5. Opens an $80k Salesforce opportunity — **gated** by the cross-stack rule
6. Drafts a personalized outreach email in Gmail
7. Bumps a HubSpot deal to $60k — **gated** by the same cross-stack rule

Steps 5 and 7 both trip the same policy line — `Amount >= 25000` —
**regardless of which CRM** the write hits. The approval lands in one queue
and routes to `#critical-approvals` either way. That's the cross-stack
control plane.

## The policy

`policy.yaml` is one file that governs both CRMs:

```yaml
- match: { tool: 'salesforce.opportunity.create', when: { fields.Amount: { gte: 25000 } } }
  effect: require_approval
  slack_channel: '#critical-approvals'

- match: { tool: 'hubspot.deals.update', when: { properties.amount: { gte: 25000 } } }
  effect: require_approval
  slack_channel: '#critical-approvals'
```

Salesforce alone, HubSpot alone, or both — the rule shape is the same. The
agent identity, the audit log, the approval inbox, and the Slack channel are
all shared. Switching CRMs costs the org one new connector line in
`policy.yaml`, not a new governance product.

## Two modes

### Hard-coded sequence (`src/index.ts`)

Fixed order — best for a deterministic demo. Works without Anthropic
credentials.

```bash
./examples/cross-stack-demo/setup.sh
export AGENTBASE_API_KEY=agb_...           # printed by setup.sh
pnpm --filter '@agentbase/cross-stack-demo' run start

# Or with a custom email:
pnpm --filter '@agentbase/cross-stack-demo' exec tsx src/index.ts cto@globex.com
```

### Claude-driven (`src/claude.ts`)

Claude chooses ordering via Anthropic tool use. Same mediation, same policy.

```bash
./examples/cross-stack-demo/setup.sh
export AGENTBASE_API_KEY=agb_...
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter '@agentbase/cross-stack-demo' run start:claude

# Or with a custom email:
pnpm --filter '@agentbase/cross-stack-demo' exec tsx src/claude.ts cto@globex.com
```

Prereqs for either mode: API + web running, Postgres + Redis up
(`docker compose -f infra/docker-compose.yml up -d`).

## What you'll see

Without external CRM credentials set, every connector returns
`failed / connector_not_configured` — but the policy decisions still print
correctly. The value of this demo is in the **decisions**, not the external
side effects. Watch for:

```
→ [salesforce] Open high-value Salesforce opportunity ($80k) — gated
  salesforce.opportunity.create
  🛂 awaiting_approval (XXms)
  policy: require_approval — "high-value Salesforce opportunity"

…

→ [hubspot] Bump HubSpot deal to $60k — gated
  hubspot.deals.update
  🛂 awaiting_approval (XXms)
  policy: require_approval — "high-value HubSpot deal change"
```

Two different vendors, one rule shape, one approval inbox.

## Why this matters for the pitch

Salesforce will ship governance for agents inside Salesforce. HubSpot will
ship governance for agents inside HubSpot. Neither will govern an agent
that reaches across both — that's an architectural conflict of interest.

Agentbase sits one layer above the connectors, so the policy is portable.
This demo is the smallest artifact that proves it.
