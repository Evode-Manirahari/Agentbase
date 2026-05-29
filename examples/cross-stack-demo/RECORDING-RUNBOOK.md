# Cross-stack demo — Loom recording runbook

Single-take 6-8 minute recording showing **two integration surfaces, one
control plane**. SDK path first, MCP path second, same audit log proving
both hit the same gate.

This file is a recording aid, not part of the codebase. Delete after
recording if it gets in the way.

---

## Pre-flight checklist (everything's already done in the session that
## generated this runbook; re-verify if it's been more than ~15 minutes)

```bash
# 1. Docker running with Postgres + Redis
docker compose -f ~/Agentbase/infra/docker-compose.yml ps
# Expect: agentbase-postgres + agentbase-redis both "Up (healthy)"

# 2. Agentbase API responding
curl -fsS http://localhost:3002/health
# Expect: {"status":"ok","db":true,...}

# 3. Cross-stack policy + demo agent installed
PGPASSWORD=agentbase psql -h localhost -p 5433 -U agentbase -d agentbase \
  -c "SELECT version, name FROM policies WHERE is_active=true ORDER BY version DESC LIMIT 1;"
# Expect: cross-stack-demo policy at v2+

# 4. DB clean (no leftover action/approval/audit rows)
PGPASSWORD=agentbase psql -h localhost -p 5433 -U agentbase -d agentbase \
  -c "SELECT 'actions:' AS t, COUNT(*) FROM actions UNION ALL SELECT 'approvals:', COUNT(*) FROM approvals UNION ALL SELECT 'audit_log:', COUNT(*) FROM audit_log;"
# Expect: all zero

# 5. Claude Desktop MCP config installed
cat "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
# Expect: mcpServers.agentbase pointing at the @agentbase/mcp-server filter
```

**Open before hitting record:**

- Terminal #1 — at `~/Agentbase` (for the SDK run)
- Terminal #2 — at `~/Agentbase` (optional — for live `tail` of `/tmp/agentbase-api.log` if you want)
- Browser tab — `http://localhost:3000` (dashboard)
- Browser tab — `http://localhost:3000/approvals`
- Browser tab — `http://localhost:3000/audit`
- Editor tab — `examples/cross-stack-demo/policy.yaml` (open to the `>= 25000` rule lines)
- **Claude Desktop** — quit and relaunch once after this runbook is created so the new MCP config loads. After relaunch, click the 🔌 / tools icon and confirm `agentbase` is listed with ~37 tools.

**Reset between practice takes:**

```bash
PGPASSWORD=agentbase psql -h localhost -p 5433 -U agentbase -d agentbase \
  -c "DELETE FROM audit_log; DELETE FROM approvals; DELETE FROM actions;"
```

---

## Recording flow

### Scene 1 — Hook (≈15s)

Camera on: editor showing `examples/cross-stack-demo/policy.yaml` open
to the `>= 25000` rules.

> "Agentbase is the secure action layer for AI sales agents. One policy,
> every connector, two ways to plug your agent in. This is the policy.
> Two rules — one for HubSpot, one for Salesforce — same threshold,
> same approval channel. That's the cross-stack part."

Point cursor at the `hubspot.deals.update` rule, then the
`salesforce.opportunity.create` rule.

### Scene 2 — SDK path (≈90s)

Switch to Terminal #1.

```bash
cd ~/Agentbase
export AGENTBASE_API_KEY=agb_9fpSfq-VIXrL26tt5OTcIrWY3LZ88YSxDym9l7VHb3A
pnpm --filter '@agentbase/cross-stack-demo' exec tsx src/index.ts
```

> "One agent identity runs an 8-step lead-processing flow through our
> SDK. Watch for the two `awaiting_approval` lines."

Let the output scroll. **Pause and point at:**

- The `🛂 awaiting_approval (XXms)` line on **Salesforce $80k opp** — call out the policy reason: *"high-value Salesforce opportunity"*.
- The `🛂 awaiting_approval (XXms)` line on **HubSpot $60k deal** — same approval rule shape, different vendor.

> "Two writes, two different CRMs, both stopped by the same rule. Both
> queued in the same approval inbox."

### Scene 3 — Dashboard (≈45s)

Switch to browser. **http://localhost:3000/approvals**

> "Two approvals pending. Different vendors, one queue."

Point at the HubSpot row, then the Salesforce row. Notice both reference
the same agent identity.

Switch to **http://localhost:3000/audit**

> "Every gate decision lands in the audit log. Allow, require_approval,
> deny — all here. Security pulls this CSV for review."

### Scene 4 — Pivot to MCP (≈15s)

Switch back to editor showing `examples/byoa-mcp/claude-desktop-config.json`.

> "That was our SDK — code-level integration. Now the same gate, through
> MCP. This is how Claude Desktop talks to us. One config, no agent code."

Highlight the `mcpServers.agentbase` block.

### Scene 5 — Claude Desktop MCP demo (≈90-120s)

Switch to Claude Desktop. Confirm the tools icon shows `agentbase` server
connected. Click it briefly to show the ~37 tools listed.

> "Claude doesn't know what Agentbase is. It sees ~37 tools across
> HubSpot, Salesforce, Gmail, Outreach, and Apollo — and every call
> goes through us."

In a new Claude Desktop conversation, paste:

```
Use the agentbase tools to do two things for Globex:
1. Upsert Lina Cho (cto@globex.com, CTO) into HubSpot.
2. Create a $50,000 Salesforce opportunity called "Globex Q3 expansion"
   for that contact's company.
Report each tool's action_id and policy decision.
```

Watch Claude call:

- `hubspot.contacts.upsert` → MCP → gate → `policy: allow` → response: `{status: "failed", ... connector_not_configured}` (the gate allowed it; the connector itself isn't credentialed, which is expected — emphasize that the **policy decision** is the point).
- `salesforce.opportunity.create` with Amount=50000 → MCP → gate → **`policy: require_approval`** → response: `{status: "awaiting_approval", action_id, poll_tool: "agentbase.get_action_status", note: "Human approval required..."}`

> "Notice what just happened. Claude got the action_id back immediately
> — we didn't block its tool call for 4 minutes while someone in Slack
> decides. That's a deliberate UX call. The agent can move on or poll."

### Scene 6 — Same gate, both paths (≈30s)

Switch to **http://localhost:3000/approvals** in browser.

> "Refresh. Three approvals pending now — two from our SDK, one from
> Claude Desktop via MCP. Same queue."

Switch to **http://localhost:3000/audit**.

> "Audit log shows both surfaces. Same policy file. Same approval
> queue. Same audit trail. Two integration surfaces, one control plane."

End on the audit log view.

---

## What to cut if running long

- Scene 1 (the policy preview) → can compress to 10s if needed
- Scene 2 → keep all 8 steps visible; the cross-stack moment is the
  whole point
- Scene 6 → can be 20s if Scene 5 ran long

## What absolutely cannot be cut

- The two `🛂 awaiting_approval` lines in Scene 2 — that's the SDK cross-stack proof
- Claude calling `salesforce.opportunity.create` and getting back `awaiting_approval` — that's the MCP cross-stack proof
- The final `/audit` view showing both — that's the punchline

## After recording

Reset state and tear down so the dev environment is back to a clean
state:

```bash
# Reset DB rows
PGPASSWORD=agentbase psql -h localhost -p 5433 -U agentbase -d agentbase \
  -c "DELETE FROM audit_log; DELETE FROM approvals; DELETE FROM actions;"

# Optional: stop the API process (the dev session backgrounded it)
pkill -f 'node --import @swc-node/register/esm-register --watch src/main.ts' || true

# Optional: stop Docker
docker compose -f ~/Agentbase/infra/docker-compose.yml down
```

Remove this file when done:

```bash
rm ~/Agentbase/examples/cross-stack-demo/RECORDING-RUNBOOK.md
```
