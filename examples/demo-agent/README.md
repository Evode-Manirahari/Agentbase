# demo-agent

Reference agent that exercises five connectors through `@agentbase/sdk` in the
typical inbound-lead flow:

1. **Enrich the lead** via Apollo (`apollo.people.match`)
2. **Enrich the company** via Apollo (`apollo.organizations.match`)
3. **Search HubSpot** for an existing contact (`hubspot.contacts.search`)
4. **Create/update the contact, create a deal, associate both, and log a note**
   in HubSpot (`hubspot.leads.create_deal`)
5. **Patch the contact** through the upsert helper (`hubspot.contacts.upsert`)
6. **Draft a personalized email** in Gmail (`gmail.draft.create`)
7. **Enroll in an Outreach sequence** (`outreach.sequences.enroll`) — requires approval
8. **Update a high-value deal** (`hubspot.deals.update` with `amount: 75000`) — requires approval

Every step is mediated by Agentbase. The agent prints the policy decision + the
connector outcome for each step so you can see exactly where the secure action layer
intervenes.

## Two modes

### Hard-coded sequence (`src/index.ts`)

The order of operations is fixed. Best for a deterministic demo and works without any Anthropic credentials.

```bash
./examples/demo-agent/setup.sh
export AGENTBASE_API_KEY=agb_...        # printed by setup.sh
pnpm --filter '@agentbase/demo-agent' run start

# Or with a custom email:
pnpm --filter '@agentbase/demo-agent' exec tsx src/index.ts cto@globex.com
```

### Claude-driven (`src/claude.ts`)

Uses the Anthropic SDK with tool use — Claude decides what to call when. Each Anthropic tool wraps an Agentbase SDK call, so policy / approval / audit / connector mediation is identical to the hard-coded variant. Uses `claude-opus-4-7` with adaptive thinking + `effort: xhigh`.

```bash
./examples/demo-agent/setup.sh
export AGENTBASE_API_KEY=agb_...
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter '@agentbase/demo-agent' run start:claude

# Or with a custom email:
pnpm --filter '@agentbase/demo-agent' exec tsx src/claude.ts cto@globex.com
```

This run prints Claude's tool-use trace in real time — every tool call shows the same `✓ executed / ✗ failed / 🛂 awaiting_approval` icon as the hard-coded variant, plus the policy decision and reason. At the end Claude prints a brief summary of what happened. Token usage is reported for cost visibility.

Prereqs for either mode: API + web running, Postgres + Redis up (`docker compose -f infra/docker-compose.yml up -d`).

## What you'll see

Without any external credentials set, every connector returns
`failed / connector_not_configured` (the policy still routes correctly — the
demo's value is in showing the **decisions**, not the actual external writes).

```
🤖 demo-agent — processing inbound lead
   demo-lead@acme.com

→ Enrich the lead via Apollo
  apollo.people.match
  ✓ executed (12ms)
  policy: allow — "enrichment is read-only"
  ↳ connector: connector_not_configured — APOLLO_API_KEY is not set

→ Create HubSpot contact + deal workflow
  hubspot.leads.create_deal
  ✗ failed (12ms)
  policy: allow
  ↳ connector: connector_not_configured — HubSpot access token is not configured

→ Enroll the prospect in an Outreach sequence
  outreach.sequences.enroll
  🛂 awaiting_approval (8ms)
  policy: require_approval — "sequence enrollment touches real prospects"

→ Update high-value deal in HubSpot ($75k)
  hubspot.deals.update
  🛂 awaiting_approval (9ms)
  policy: require_approval — "high-value deal change"
```

Then visit http://localhost:3000/approvals to approve/deny the two pending
actions, or http://localhost:3000/audit to see the full event trail.

## Plugging in real credentials

Add any/all of these to `apps/api/.env`:

```
HUBSPOT_ACCESS_TOKEN=pat-na...
SALESFORCE_ACCESS_TOKEN=...
SALESFORCE_INSTANCE_URL=https://yourdomain.my.salesforce.com
GMAIL_ACCESS_TOKEN=ya29....
OUTREACH_ACCESS_TOKEN=...
APOLLO_API_KEY=...

# Slack (so approvals land in a channel)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APPROVALS_CHANNEL=C0123456789
```

The watcher restarts automatically. Re-run the demo and the connector calls
hit real systems; high-value steps land approval cards in Slack.

## Tweaking the demo policy

Edit `policy.yaml` and re-run `setup.sh` (it sends a fresh PUT, which versions
up the active policy). Or edit live in the dashboard at
http://localhost:3000/policies (live YAML+Zod validation).
