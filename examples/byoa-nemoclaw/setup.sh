#!/usr/bin/env bash
# Governs an agent running inside NVIDIA NemoClaw's sandbox with Agentbase.
# Applies policy.yaml, registers a fresh scoped agent identity, and prints the
# exact `nemoclaw mcp add …` command — pre-filled with the new agb_ key — to
# wire Agentbase into the sandbox.
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

echo "→ Installing NemoClaw governance policy …"
curl -fsS -X PUT "$API/v1/policies/active" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg yaml "$POLICY_YAML" '{name: "byoa-nemoclaw", yaml: $yaml}')" \
  | jq -r '"  policy v\(.version) — \(.document.rules | length) rules"'

echo
echo "→ Registering the sandboxed agent identity …"
REG=$(curl -fsS -X POST "$API/v1/agents" \
  -H 'content-type: application/json' \
  -d '{"name":"byoa-nemoclaw","description":"Agent running inside NVIDIA NemoClaw, governed by Agentbase via MCP"}')
AGENT_ID=$(echo "$REG" | jq -r .agent_id)
KEY=$(echo "$REG" | jq -r .api_key)
echo "  agent_id: $AGENT_ID"
echo "  key:      $(echo "$KEY" | cut -c1-12)…"

echo
echo "✓ Setup complete."
echo
echo "1. Confirm the sandbox's network policy tier allows egress to $API"
echo "   (run: nemoclaw doctor — the baseline tier usually covers localhost in dev)."
echo
echo "2. Register Agentbase as an MCP server inside the sandbox:"
echo
echo "   nemoclaw mcp add agentbase \\"
echo "     --command pnpm \\"
echo "     --args exec agentbase-mcp \\"
echo "     --env AGENTBASE_API_KEY=$KEY \\"
echo "     --env AGENTBASE_BASE_URL=$API"
echo
echo "   (or add the agentbase block from nemoclaw-mcp-config.yaml to your"
echo "   blueprint's mcp_servers config with this key)"
echo
echo "3. Restart the sandboxed agent so it picks up the new MCP server."
echo
echo "4. (optional) Verify the gate fires before trusting it:"
echo
echo "   AGENTBASE_API_KEY=$KEY pnpm --filter '@agentbase/byoa-nemoclaw' run verify"
echo
