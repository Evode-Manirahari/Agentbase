#!/usr/bin/env bash
# Wires the demo: applies the policy in policy.yaml, registers a fresh agent,
# and prints the export line you need to actually run the agent.
#
# Requires: jq, curl, the API running on localhost:3002, and a Postgres+Redis.

set -euo pipefail

API="${DEJAVAS_BASE_URL:-http://localhost:3002}"

# Sanity check
if ! curl -fsS "$API/health" >/dev/null 2>&1; then
  echo "✗ Dejavas API is not responding at $API"
  echo "  start it with: pnpm --filter '@dejavas/api' dev"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_YAML="$(cat "$SCRIPT_DIR/policy.yaml")"

echo "→ Installing demo policy …"
curl -fsS -X PUT "$API/v1/policies/active" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg yaml "$POLICY_YAML" '{name: "demo-agent", yaml: $yaml}')" \
  | jq -r '"  policy v\(.version) — \(.document.rules | length) rules"'

echo
echo "→ Registering the agent …"
REG=$(curl -fsS -X POST "$API/v1/agents" \
  -H 'content-type: application/json' \
  -d '{"name":"demo-agent","description":"reference agent for the lead-processing flow"}')
AGENT_ID=$(echo "$REG" | jq -r .agent_id)
KEY=$(echo "$REG" | jq -r .api_key)
echo "  agent_id: $AGENT_ID"
echo "  key:      $(echo "$KEY" | cut -c1-12)…"

echo
echo "✓ Setup complete. Run the agent:"
echo
echo "  export DEJAVAS_API_KEY=$KEY"
echo "  pnpm --filter '@dejavas/demo-agent' exec tsx src/index.ts"
echo
