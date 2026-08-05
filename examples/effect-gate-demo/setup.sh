#!/usr/bin/env bash
# Wires the effect-gate demo: applies the effect-gate policy.yaml, registers
# a fresh agent, and prints the export line.
#
# Requires: jq, curl, the API running on localhost:3002, and Postgres+Redis.

set -euo pipefail

API="${AGENTBASE_BASE_URL:-http://localhost:3002}"

if ! curl -fsS "$API/health" >/dev/null 2>&1; then
  echo "✗ Agentbase API is not responding at $API"
  echo "  start it with: pnpm --filter '@agentbase/api' dev"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_YAML="$(cat "$SCRIPT_DIR/policy.yaml")"

echo "→ Installing effect-gate policy …"
curl -fsS -X PUT "$API/v1/policies/active" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg yaml "$POLICY_YAML" '{name: "effect-gate-demo", yaml: $yaml}')" \
  | jq -r '"  policy v\(.version) — \(.document.rules | length) rules"'

echo
echo "→ Registering the agent …"
REG=$(curl -fsS -X POST "$API/v1/agents" \
  -H 'content-type: application/json' \
  -d '{"name":"effect-gate-demo","description":"reference agent for the effect commit layer — shell commands graded by consequence"}')
AGENT_ID=$(echo "$REG" | jq -r .agent_id)
KEY=$(echo "$REG" | jq -r .api_key)
echo "  agent_id: $AGENT_ID"
echo "  key:      $(echo "$KEY" | cut -c1-12)…"

echo
echo "✓ Setup complete."
echo
echo "  Shell execution is controlled by the API process, not by this script."
echo "  Started without AGENTBASE_SHELL_ENABLED=1, commands are still classified"
echo "  and gated — allowed ones report shell_disabled instead of running, which"
echo "  is enough to see every gate decision. Start the API with"
echo "  AGENTBASE_SHELL_ENABLED=1 to actually execute them."
echo
if [ "$API" != "http://localhost:3002" ]; then
  echo "  export AGENTBASE_BASE_URL=$API"
fi
echo "  export AGENTBASE_API_KEY=$KEY"
echo "  pnpm --filter '@agentbase/effect-gate-demo' start"
echo
