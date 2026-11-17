#!/usr/bin/env bash
# Positioning guard. Fails CI if a retired tagline creeps back into platform
# surfaces, and asserts the agent-readable llms.txt front door exists and carries
# its key markers.
#
# Canonical positioning lives in docs/positioning.md:
#   "booking integrity for voice agents"
#
# Three generations of retired pitch are guarded here. "AI sales agents" was
# retired in 2026-05. "safe-action layer / scoped identity, approval, and audit"
# was retired next. The third, retired 2026-11-16, sold the commit engine as
# horizontal infrastructure for every AI agent. It is the most dangerous of the
# three because the engine is real and tested: the product HAS a commit engine.
# It is not what it SELLS, because exactly-once as general infrastructure is a
# feature other layers are absorbing, and it found no users. "The effect commit
# layer" is still the correct name of the PROTOCOL (docs/effect-commit.md); what
# is banned is naming it as the product for all agents.
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
# Matched as extended regexes (-E), so a phrase cannot slip through on its
# separator alone: "revenue-agent" in dashboard copy passed a literal
# "revenue agent" check for exactly that reason. Escape regex metacharacters.
BANNED=(
  "secure action layer"
  "AI sales agents"
  "for AI sales agent"
  "safe-action layer"
  "cross-stack governance"
  "revenue[ -]agent"
  "Okta \+ Zapier \+ Datadog"
  "commit layer for (all |any )?(AI )?agents"
)

# Allowlist = the frozen AI SDR reference implementation, where "sales" is the
# demo's own framing on purpose: the bundled agent jobs, the worked examples, and
# the GTM playbooks for the revenue/CRM beachhead. Everything else is a platform
# surface and must carry the current positioning.
EXCLUDES=(
  ":(exclude)docs/demo/**"
  ":(exclude)examples/**"
  ":(exclude)apps/api/src/agent-runtime/**"
  ":(exclude)scripts/check-positioning.sh"
  ":(exclude)CHANGELOG.md"
  ":(exclude)TODOS.md"
)

for phrase in "${BANNED[@]}"; do
  # git grep respects .gitignore (skips node_modules, dist, .next) and pathspecs.
  if matches=$(git grep -nI -i -E -e "$phrase" -- . "${EXCLUDES[@]}" 2>/dev/null); then
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
  for marker in "booking integrity" "booking-audit" "read-only" "unverified" "not on npm yet" ; do
    if ! grep -qi "$marker" "$LLMS"; then
      echo "✗ $LLMS is missing expected marker: \"$marker\""
      fail=1
    fi
  done
fi

# --- 3. The exactly-once claim never ships without its condition -------------
# At-most-once holds ONLY where the provider deduplicates (connectors declare
# key/natural/none; undeclared means none). A surface that states the claim and
# omits the condition is an overclaim, and it is the one thing in this repo an
# engineer evaluating us will test first. Any file asserting the claim must also
# carry the condition somewhere in the same file.
CLAIM_SURFACES=(
  "docs/positioning.md"
  "README.md"
  "CLAUDE.md"
  "package.json"
  "apps/marketing/public/llms.txt"
  "apps/marketing/src/app/layout.tsx"
  "apps/marketing/src/app/page.tsx"
  "apps/web/src/app/layout.tsx"
  "apps/web/src/app/page.tsx"
  "packages/sdk/README.md"
  "packages/mcp-server/README.md"
  "packages/booking-audit/README.md"
  "examples/voice-booking-repro/README.md"
)

# An AFFIRMATIVE qualifier, not merely the substring "dedup". A bare claim in a
# file that happens to mention deduplication elsewhere — including a sentence
# saying the provider CANNOT dedupe — must still fail, or the check reports a
# false pass on exactly the overclaim it exists to catch.
QUALIFIER_RE='(wherever|where|only where) the provider (deduplicates|dedupes)'

for f in "${CLAIM_SURFACES[@]}"; do
  [ -f "$f" ] || continue
  # Collapse all whitespace first: both the claim and its qualifier wrap across
  # lines in prose and in JSX, so a line-oriented grep misses them.
  flat=$(tr -s '[:space:]' ' ' < "$f")
  if printf '%s' "$flat" | grep -qi "exactly once" \
    && ! printf '%s' "$flat" | grep -qiE "$QUALIFIER_RE"; then
    echo "✗ $f states the exactly-once claim without the provider-deduplication condition."
    echo "    At-most-once holds only where the provider dedupes. Say so on the same surface,"
    echo "    in the affirmative — e.g. \"exactly once wherever the provider deduplicates\"."
    fail=1
  fi
done

# --- 4. The audit never claims more than a call log can show -----------------
# The audit reads the call log only. A surface that describes it must say so,
# and must name the "unknown" outcome, or it is selling a certainty the tool
# does not have. This is the audit's version of the qualifier above.
AUDIT_SURFACES=(
  "docs/positioning.md"
  "README.md"
  "packages/booking-audit/README.md"
  "apps/marketing/public/llms.txt"
  "apps/marketing/src/app/page.tsx"
)
for f in "${AUDIT_SURFACES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "✗ $f is missing — it is a surface that describes the booking audit."
    fail=1
    continue
  fi
  flat=$(tr -s '[:space:]' ' ' < "$f")
  if ! printf '%s' "$flat" | grep -qiE "reads the call log (and nothing else|only)"; then
    echo "✗ $f describes the booking audit without saying it reads the call log only."
    fail=1
  fi
  if ! printf '%s' "$flat" | grep -qi "unknown"; then
    echo "✗ $f describes the booking audit without the unknown outcome."
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "✓ positioning guard passed (no retired tagline; llms.txt correct; no unconditional exactly-once claim; audit claims carry their limit)"
fi
exit "$fail"
