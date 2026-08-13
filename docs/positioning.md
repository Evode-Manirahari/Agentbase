# Agentbase positioning

## Category

Agentbase is the **effect commit layer** for AI agents.

The agent-first internet is building two layers, and only one of them is
crowded:

- **Permission** — may this agent call this tool, with whose credentials?
- **Commitment** — the call was permitted; did it actually happen, exactly once?

Agentbase is the second one.

## One-line pitch

Commit an agent's irreversible actions exactly once wherever the provider
deduplicates, prove what happened, and survive a crash in the middle.

The condition is part of the pitch, not a footnote to it. Every surface that
copies this line copies the condition with it — see "The qualifier" below for
why saying it up front is what makes the rest credible.

## The problem

Between sending a request and reading its response, the effect may or may not
exist. Nothing on our side of the network closes that gap — not a transaction,
not a lock, not a retry policy. The provider either processed it or did not, and
the process may die before finding out.

Every agent framework in production today resolves that ambiguity by guessing.
Retry, and the customer is charged twice. Report failure, and the system has
lied about something that already happened. Both are wrong, and the second one
is worse because it is silent.

The failure is not theoretical and it is not rare. It is one crash, one timeout,
or one restart away, on every irreversible call an unattended agent makes.

## What Agentbase does

- **Reserves before dispatch.** The attempt is written `indeterminate` *before*
  the request leaves, so a crash at the worst moment leaves evidence rather than
  nothing.
- **Carries a provider idempotency key** on the wire wherever the provider
  honours one.
- **Refuses to guess.** An attempt that never settled stays `indeterminate`, is
  never auto-retried, and can only be closed by a human recording what they
  actually found at the provider.
- **Replays without re-sending.** Recorded receipts are returned with zero
  requests to any provider.
- **Grades by consequence, not by name.** Policy matches on what an action
  *does* — its effect class and whether it is reversible — so a command nobody
  anticipated is still gated.

## The claim

Ten retries across three crash points produce **exactly one** effect. Remove the
idempotency key and the same test produces eight.

Tested in `apps/api/src/actions/effect-dispatcher.test.ts`. Protocol in
[`effect-commit.md`](./effect-commit.md).

## The qualifier, which ships with the claim

**At-most-once holds only where the provider deduplicates.** Connectors declare
`key`, `natural`, or `none` per call; undeclared means `none`. Against a
provider that cannot dedupe, Agentbase's honesty is the product — it will tell
you it does not know rather than pretend.

Never pitch the guarantee unconditionally. The first competent engineer who
hears it will ask, and the qualifier is what makes the rest credible.

## Buyer

Teams running **unattended agents that touch irreversible things** — payments,
email sends, deploys, infrastructure, publishing, external writes.

The qualifying question is not "do you use AI agents?" It is:

> When your agent crashes mid-call, how do you currently find out whether the
> thing happened?

Teams with a real answer are not buyers. Teams that go quiet are.

## Differentiation

Permission gateways — [Executor](https://executor.sh/), MCPX, Docker's MCP
Gateway, and the MCP spec's own just-in-time authorization — answer whether a
call is allowed. That question is settled before anything leaves the machine,
and it is well served.

None of them makes a crash-safety, receipt, or replay claim.

**These stack.** A gateway can front this layer; this layer does not replace
one. Positioning against gateways is a mistake — the pitch is what happens after
they have done their job.

## Moat

- **The evidence ledger.** One row per attempt with the provider's own
  reference. Replacing Agentbase means abandoning the record of what your agents
  actually did.
- **Connector idempotency knowledge.** Which providers dedupe, on what key, for
  how long, is grubby per-provider truth that only accumulates by doing the
  work.
- **Agent-native interface.** The buyer is human; the daily caller is the agent.
  SDK and MCP access let agents commit through Agentbase directly while humans
  keep the quarantine exit.

## Product thesis

The bundled outbound, follow-up, reply-handler, and CRM-hygiene flows in
`apps/api/src/agent-runtime/` are a **frozen reference implementation** — proof
the layer works on a real agent, not the product. "Sales" is correct inside that
directory and its examples, and nowhere else.

Every irreversible agent action should pass through the same primitives:

- Effect classification by consequence.
- Policy decision.
- Approval routing for what cannot be undone.
- Reserve → dispatch → settle, with a receipt per attempt.
- Quarantine with a human exit.
- Replay without re-sending.

## Status

**Demand is unvalidated.** No customer has asked for this. The technical claim
is tested and the demo runs; neither is evidence that anyone will pay. Do not
describe pilots, users, or revenue that do not exist.

The next step is conversations with teams running unattended agents — not more
building. See the §11 tripwire in [`TODOS.md`](../TODOS.md).
