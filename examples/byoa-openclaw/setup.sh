#!/usr/bin/env bash
# Governs OpenClaw with Agentbase. Applies policy.yaml, registers a fresh
# scoped agent identity, and prints the exact `openclaw mcp add …` command —
# pre-filled with the new agb_ key — to wire Agentbase into OpenClaw.
#
# Requires: jq, curl, the API running on localhost:3002, and a Postgres+Redis.

set -euo pipefail

API="${AGENTBASE_BASE_URL:-http://localhost:3002}"

# Sanity check
if ! curl -fsS "$API/health" >/dev/null 2>&1; then
  echo "✗ Agentbase API is not responding at $API"
  echo "  start it with: pnpm --filter '@agentbase/api' dev"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_YAML="$(cat "$SCRIPT_DIR/policy.yaml")"

echo "→ Installing OpenClaw governance policy …"
curl -fsS -X PUT "$API/v1/policies/active" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg yaml "$POLICY_YAML" '{name: "byoa-openclaw", yaml: $yaml}')" \
  | jq -r '"  policy v\(.version) — \(.document.rules | length) rules"'

echo
echo "→ Registering the OpenClaw agent identity …"
REG=$(curl -fsS -X POST "$API/v1/agents" \
  -H 'content-type: application/json' \
  -d '{"name":"byoa-openclaw","description":"OpenClaw agent governed by Agentbase via MCP"}')
AGENT_ID=$(echo "$REG" | jq -r .agent_id)
KEY=$(echo "$REG" | jq -r .api_key)
echo "  agent_id: $AGENT_ID"
echo "  key:      $(echo "$KEY" | cut -c1-12)…"

echo
echo "✓ Setup complete."
echo
echo "1. Register Agentbase as an MCP server in OpenClaw:"
echo
echo "   openclaw mcp add agentbase \\"
echo "     --command pnpm \\"
echo "     --args exec agentbase-mcp \\"
echo "     --env AGENTBASE_API_KEY=$KEY \\"
echo "     --env AGENTBASE_BASE_URL=$API"
echo
echo "   (or paste the agentbase block from openclaw-mcp-config.json with this"
echo "   key into your openclaw.json / .mcp.json — see the README)"
echo
echo "2. Reload MCP servers:   openclaw mcp reload"
echo
echo "3. (optional) Verify the gate fires before trusting it:"
echo
echo "   AGENTBASE_API_KEY=$KEY pnpm --filter '@agentbase/byoa-openclaw' run verify"
echo
