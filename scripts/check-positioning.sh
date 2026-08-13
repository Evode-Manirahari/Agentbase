#!/usr/bin/env bash
# Positioning guard. Fails CI if a retired tagline creeps back into platform
# surfaces, and asserts the agent-readable llms.txt front door exists and carries
# its key markers.
#
# Canonical positioning lives in docs/positioning.md:
#   "the effect commit layer for AI agents"
#
# Two generations of retired pitch are guarded here. "AI sales agents" was
# retired in 2026-05; "safe-action layer / scoped identity, approval, and audit"
# was retired when the product became the effect commit layer, and it is the more
# dangerous of the two because it describes a real feature of the system. The
# product HAS identity and approval — it is not what it SELLS, because permission
# gateways serve that question and do not make a crash-safety claim.
#
# Allowlisted: the SDR reference demo (docs/demo), this script, build output, and
# deps. The bundled AI SDR demo is a frozen reference where "sales" is correct on
# purpose.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0

# --- 1. Retired tagline must not appear on platform surfaces -----------------
# Phrases specific to the old positioning. Bare "sales" is intentionally NOT
# banned (Sales Agent permission profile, sales_sdr demo profile are legit).
BANNED=(
  "secure action layer"
  "AI sales agents"
  "for AI sales agent"
  "safe-action layer"
  "cross-stack governance"
  "revenue agent"
  "Okta + Zapier + Datadog"
)

# Allowlist = the frozen AI SDR reference implementation, where "sales" is the
# demo's own framing on purpose: the bundled agent jobs, the worked examples, and
# the GTM playbooks for the revenue/CRM beachhead. Everything else is a platform
# surface and must carry the current positioning.
EXCLUDES=(
  ":(exclude)docs/demo/**"
  ":(exclude)examples/**"
  ":(exclude)apps/api/src/agent-runtime/**"
  ":(exclude)apps/web/src/app/campaigns/**"
  ":(exclude)scripts/check-positioning.sh"
  ":(exclude)CHANGELOG.md"
  ":(exclude)TODOS.md"
)

for phrase in "${BANNED[@]}"; do
  # git grep respects .gitignore (skips node_modules, dist, .next) and pathspecs.
  if matches=$(git grep -nI -i -e "$phrase" -- . "${EXCLUDES[@]}" 2>/dev/null); then
    echo "✗ Retired positioning phrase \"$phrase\" found:"
    echo "$matches" | sed 's/^/    /'
    fail=1
  fi
done

# --- 2. Agent-readable front door must exist and carry its markers -----------
LLMS="apps/marketing/public/llms.txt"
if [ ! -s "$LLMS" ]; then
  echo "✗ $LLMS is missing or empty — the agent-first discovery front door is broken."
  fail=1
else
  for marker in "effect commit layer" "exactly once" "agb_" "human provisions" ; do
    if ! grep -qi "$marker" "$LLMS"; then
      echo "✗ $LLMS is missing expected marker: \"$marker\""
      fail=1
    fi
  done
fi

if [ "$fail" -eq 0 ]; then
  echo "✓ positioning guard passed (no retired tagline; llms.txt present + correct)"
fi
exit "$fail"
