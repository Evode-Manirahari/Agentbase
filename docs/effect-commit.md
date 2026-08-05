# The effect commit layer

Agent retries and crashes must not duplicate irreversible production effects.

That is a reliability claim, not a permissions claim, and it is the layer this
document describes.

## What this is not

A permissions gateway answers **"may this agent call this tool, and with whose
credentials?"** — settled before anything leaves the machine. That question is
well served: [Executor](https://executor.sh/), MCPX, and Docker's MCP Gateway
all answer it, and the MCP spec itself now standardises URL Elicitation for
just-in-time authorization.

Agentbase answers the question that comes **after** the permission is granted:

> The call was permitted and a human approved it. How do we commit it exactly
> once, prove what happened, survive a crash at any point in between, and keep
> it from happening again during replay?

These stack. A gateway can front this layer; this layer does not replace one.

## The window that cannot be closed

Between sending a request and reading its response, the effect may or may not
exist. Nothing on our side of the network closes that gap — not a transaction,
not a lock, not a retry policy. The provider either processed it or did not, and
our process may die before finding out.

So the protocol does not pretend to be atomic. It is honest and recoverable
instead.

### 1. Reserve before dispatch

The action row — and with it the unique `(org, agent, idempotency_key)` index —
is claimed **before** any external call. A concurrent request carrying the same
key loses at the database and never reaches the connector. Claiming it
afterwards deduplicates the *record* of a send, not the send.

### 2. Bind approval to the request, not the row

A human approved `delete branch release/v2`, not "whatever row `8f3c` holds by
the time we get there." Every action stores a `request_hash` — sha256 over the
canonical `(tool, params)` pair — and dispatch refuses if what is about to go out
does not match what was approved.

### 3. Write the attempt down before it happens

Each dispatch opens a row in `effect_receipts` with outcome `indeterminate`
**before** the request leaves. That is the honest description of the state being
entered: a request is about to exist in the world and its fate is unknown.

If the process dies there, the row survives saying exactly that. Writing it
afterwards would mean a crash leaves no evidence an effect was ever attempted —
which is how an agent's retry silently sends the second email.

### 4. Never upgrade an unknown to a known

An attempt only leaves `indeterminate` when a provider response is in hand, or
when a human resolves it. Settling it `failed` on a thrown exception would assert
that nothing happened, and that assertion is not ours to make.

An action whose dispatch state is `unknown` is **never auto-retried**, and — see
below — is not manually retryable either unless the provider can dedupe.

### 5. Keep the provider's own word for it

`effect_receipts.provider_ref` holds the provider's identifier for what
happened: a Stripe charge id, a GitHub ref sha, a Terraform apply id. That is the
difference between "we logged a success" and evidence someone else can check.

**On "append-only":** a row is *inserted once per attempt* and *settled once*.
The settlement fields are mutable exactly once — the transition out of
`indeterminate` is a conditional update that only fires while the row is still
indeterminate. So attempts are never merged, overwritten, or deleted, and a late
provider response cannot overrule a verdict a human already recorded. That is a
weaker statement than a true append-only log, and it is the accurate one.

## The guarantee is conditional, and says so

**At-most-once holds when the provider can collapse our retry into the original
request.** Where it cannot, the protocol degrades to quarantine — which is still
far better than a blind retry, but it is a different promise and should not be
sold as the same one.

Connectors declare this per tool:

| Mode | Meaning | Retry after an unknown outcome |
|---|---|---|
| `key` | Provider honours an idempotency key we supply (Stripe) | Safe |
| `natural` | Idempotent by construction — deleting a named resource | Safe |
| `none` | Neither; a retry may create a second effect | **Refused** |

A connector that does not declare a mode is treated as `none`. Defaulting the
optimistic way would silently convert every unaudited connector into a
duplicate-effect risk.

The mode in force is recorded **on each attempt**, not looked up later, because
a connector's declaration can change and the question an incident asks is *what
was true when this ran?*

### The retry button is guarded

`reconcileStaleDispatches` marks a never-settled dispatch `failed` with
`dispatch_state = 'unknown'`. "Failed" there means *we do not know*, not
*nothing happened* — so retrying it is how one deployment becomes two.

`POST /v1/actions/:id/retry` refuses when the dispatch state is `unknown` and the
connector reports `none`. The way forward is not a force flag; it is to establish
what actually happened:

```http
POST /v1/effects/:receiptId/resolve
{ "outcome": "committed", "provider_ref": "sha-1", "note": "confirmed in the GitHub UI" }
```

## The policy that does not go stale

Shipped as the first one-click template, **"Require approval for anything that
cannot be undone"**:

```yaml
- match: { tool: '*', effect_class: unknown }   # deny
- match: { tool: '*', effect_class: read }      # allow
- match: { tool: '*', reversible: false }       # require_approval
- match: { tool: '*', effect_class: workspace_write, reversible: true }  # allow
```

It names no tool. An enumerated policy is out of date the moment an agent
learns a command nobody listed, and the list of things that publish is exactly
the list nobody can keep current by hand.

**The `unknown` rule must come first.** An `unknown` effect carries
`reversible: false`, so behind the irreversible rule it would match *that* and
queue for approval — and a person is the wrong destination. `curl … | sh` shows
an approver a URL, not the script it is about to execute. They cannot read it
either, so routing it to a human manufactures the appearance of review while
providing none. Refuse it and make the agent submit something legible.

## What the reviewer sees

The assessment is recorded on the action at decision time
(`actions.effect_assessment`) and carried into the audit payloads — then shown
on **both** approval surfaces, so a reviewer gets the same picture wherever
they happen to look:

```text
*Effect*  `publish` — *irreversible*
⚠️ Publishes a package to a public registry. This cannot be undone.
```

Recorded rather than recomputed on read, deliberately. An incident asks "why
was this allowed?", and the honest answer depends on what the classifier said
**when the policy ran** — not on what it would say today after a rule change or
a connector update. Recomputing would describe the current classifier's opinion
of an old action and look authoritative doing it.

Null stays null for connectors that cannot classify, which is most of them. A
reviewer seeing no assessment is correct; a reviewer seeing an invented default
is misled.

## Ending a quarantine

An indeterminate state with no exit is a leak, not a safety property.

| Endpoint | Purpose |
|---|---|
| `GET /v1/effects/indeterminate` | The operator queue, including the idempotency key that was on the wire so it can be searched for provider-side |
| `GET /v1/effects/actions/:actionId` | Full attempt history — the evidence trail |
| `POST /v1/effects/:receiptId/resolve` | Record what a human found |

Resolving is deliberately **not** a retry. It says "I looked, and here is what is
true." The effect is not re-attempted, because if it already landed, attempting
it again is the exact failure this layer exists to prevent. Two operators
resolving the same attempt produce one verdict and one conflict, and the
resolution is audited with the name of the human who made it.

## Replay

`AGENTBASE_REPLAY=1` makes the dispatcher **incapable** of reaching a provider.
Recorded receipts are returned instead.

This is a hard mode switch rather than a per-call flag on purpose: the guarantee
is "no live effect can occur in this process," and a guarantee that depends on
every caller remembering a parameter is not one.

Replay never serves an `indeterminate` attempt as though it succeeded — that
would manufacture evidence for something that may never have happened. It returns
`no_receipt` and does not go and ask.

## The test that makes it binary

The protocol is measured against a provider double that counts the effects
**that actually exist on its side**, not the calls we think we made:

```text
✔ ten retries across every crash point produce at most one effect
✔ replay returns the recorded receipt and reaches no provider at all
```

Crash points exercised: before the provider sees the request, after it commits
but before we hear, and clean.

The assertion is load-bearing rather than decorative — removing the idempotency
key from the wire and re-running yields:

```text
not ok - ten retries across every crash point produce at most one effect
    expected: 1
    actual: 8
```

Run it:

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm --filter @agentbase/db db:push
cd apps/api && pnpm exec node --import @swc-node/register/esm-register \
  --test src/actions/effect-dispatcher.test.ts
```

## Schema

| Object | Purpose |
|---|---|
| `actions.request_hash` | What a human approved |
| `effect_receipts.idempotency_key_sent` | The key actually put on the wire — dedupes *our* requests to *them*, distinct from the caller's key to us |
| `actions.dispatch_state` | `not_dispatched` / `in_flight` / `settled` / `unknown` |
| `effect_receipts` | Append-only, one row per attempt |
| `effect_receipts.idempotency_mode` | The retry guarantee in force at the time |
| `attempt_outcome` | `committed` / `failed` / `indeterminate` |

## Known limits

- **Mediated interception only.** This layer sees calls that pass through it. It
  is not a syscall boundary and will not contain a process determined to go
  around it. Use OS sandboxing for containment.
- **`natural` is a declaration, not a proof.** A connector asserting `natural`
  for an operation that is not idempotent will produce duplicates, and nothing
  here detects that. Audit connectors before trusting the mode.
- **Provider-side dedupe windows expire.** Stripe's idempotency keys last 24
  hours. A retry after the window is a new request regardless of what we send —
  so `retry()` refuses a `key`-mode retry of an unknown dispatch older than 24h
  and sends the operator to resolve the receipt instead.
- **A connector that never answers is bounded, not resolved.** Dispatch times
  out after 60s (`AGENTBASE_DISPATCH_TIMEOUT_MS`). The attempt stays
  `indeterminate`, because a timeout tells us nothing about whether the provider
  acted — it frees the caller, it does not establish an outcome.
- **Replay fidelity is bounded by what was recorded.** An effect dispatched
  before this layer existed has no receipt, and replay will correctly refuse to
  invent one.
