# demo-agent

Reference agent that exercises five connectors through `@dejavas/sdk` in the
typical inbound-lead flow:

1. **Enrich the lead** via Apollo (`apollo.people.match`)
2. **Enrich the company** via Apollo (`apollo.organizations.match`)
3. **Write the contact** to HubSpot (`hubspot.contacts.create`)
4. **Draft a personalized email** in Gmail (`gmail.draft.create`)
5. **Enroll in an Outreach sequence** (`outreach.sequences.enroll`) — requires approval
6. **Update a high-value deal** (`hubspot.deals.update` with `amount: 75000`) — requires approval

Every step is mediated by Dejavas. The agent prints the policy decision + the
connector outcome for each step so you can see exactly where the control plane
intervenes.

## Run it

Prereqs: API + web running, Postgres + Redis up (`docker compose -f infra/docker-compose.yml up -d`).

```bash
# Apply the demo policy and register the agent
./examples/demo-agent/setup.sh

# Run the agent (the export line is printed at the end of setup.sh)
export DEJAVAS_API_KEY=dvk_...
pnpm --filter '@dejavas/demo-agent' exec tsx src/index.ts

# Optionally pass a custom email
pnpm --filter '@dejavas/demo-agent' exec tsx src/index.ts cto@globex.com
```

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
