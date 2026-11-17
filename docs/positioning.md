# Agentbase positioning

## Category

Agentbase is **booking integrity for voice agents**.

A voice agent that books appointments has two jobs: make the booking, and tell
the caller the truth about it. Platforms cover the conversation. QA tools cover
how the conversation went. Nothing covers the gap between the tool call and the
sentence the caller hears next:

- Did the booking happen once?
- Did it happen at all?
- Does anyone know?

## One-line pitch

Find the bookings your voice agent duplicated, never confirmed with the caller,
or never made. Where the outcome is unknown, it says so.

"It says so" is part of the pitch, not a footnote to it. See "The qualifiers"
below for why saying it up front is what makes the rest credible.

## The problem

When a booking tool call times out, fires twice, or never fires, the caller
still hears a sentence within a second. Today that sentence is a guess.
Builders find the damage later, by hand: duplicate appointment records, and
callers who were told "you're booked" with nothing in the calendar.

This is documented in public, by the people it happens to:

- A Retell builder, July 2026: the engine "emitted 5 identical
  `Book_Appointment` tool calls in the same turn," leaving one patient with
  seven appointment records across three times. The reply told him to add a
  lock on his own side.
  ([thread](https://community.retellai.com/t/book-appointment-tool-calls-fired-in-a-single-llm-turn-after-streaming-timeout-resulted-in-multiple-appointments-booked-for-one-requested-slot/3301))
- The Agentic AI Foundation's October 2026 failure analysis: "A timeout cannot
  safely be treated as proof that nothing happened." "Retrying without checking
  can produce two bookings." It names no product as the answer.
  ([post](https://aaif.io/blog/where-voice-agents-fail-in-production-part-2-tools-recovery-and-observability))
- Vapi's docs tell builders to point the tool at a proxy they control and to
  check the record before retrying.
  ([docs](https://docs.vapi.ai/tools/api-request/reliability))
- Retell's docs say to enable retries only if the endpoint is idempotent.
  ([docs](https://docs.retellai.com/build/single-multi-prompt/custom-function))

Forum posts are a symptom of the problem. They are not demand for this product.
See "Status".

## What ships today

`packages/booking-audit`: a read-only command-line audit of voice-platform call
logs. Retell first. It runs on the builder's machine, has zero runtime
dependencies, sends nothing anywhere, and redacts by default.

Four checks:

- **F1 Repeated booking.** The same booking sent more than once in one call.
- **F2 Booking the caller never confirmed.** A second, different booking made
  right after an attempt went wrong, with no caller speech in between.
- **F3 Unverified booking claim.** The agent said a booking was made and no
  confirmed result came before that sentence.
- **F4 Unknown booking outcome.** A booking was sent and the log does not show
  whether it was made.

`booking-audit demo` produces a real report from built-in, made-up calls in
about ten seconds, with no key and no network.

## What does not exist yet

**The fix.** One URL in front of a builder's existing booking webhook that
commits each booking intent once and answers confirmed, failed, or unknown, so
the agent never says "booked" on an unknown.

It is not built on purpose. It gets built when one outside builder runs the
audit on real calls, finds something, and asks how to stop it. Until then: no
proxy, no hosted service, no billing, no dashboard work. The gate is written
down in [`TODOS.md`](../TODOS.md).

## The engine underneath

The fix will be built on the commit protocol that already exists in `apps/api`
and is specified in [`effect-commit.md`](./effect-commit.md):

- **Reserve before dispatch.** The attempt is written `indeterminate` *before*
  the request leaves, so a crash at the worst moment leaves evidence.
- **Carry a provider idempotency key** on the wire wherever the provider
  honours one.
- **Refuse to guess.** An attempt that never settled stays `indeterminate`, is
  never auto-retried, and is closed only by a human recording what they found.
- **Replay without re-sending.**

Ten retries across three crash points produce one effect, wherever the provider
deduplicates. Remove the idempotency key and the same test produces eight.
Tested in `apps/api/src/actions/effect-dispatcher.test.ts`.

The engine is built and tested. It is not wired to any voice platform. In a
back-office agent an unknown outcome can wait in a queue. In a phone call the
agent has to speak now, and the engine's `indeterminate` state is the sentence
it says next. That is why voice is where this engine is a product and not
plumbing.

## The qualifiers, which ship with every claim

**1. The audit reads the call log and nothing else.** "Confirmed" means the log
says so. When the log cannot say, the audit reports `unknown` or "unverified
claim". It never reports "failed" or "missing" on a guess. A missing success
response does not prove an appointment is absent, and only the builder's
booking system can settle it. Every finding ends with what to check there.

**2. The engine's guarantee is conditional.** At-most-once holds only where the
provider deduplicates. Connectors declare `key`, `natural`, or `none` per call;
undeclared means `none`. Against a backend that cannot dedupe and cannot be
looked up, the engine holds the attempt as unknown rather than retrying it.

Never pitch either one without its condition. The first competent engineer who
hears it will ask.

## Buyer

**First payer (hypothesis):** an agency that maintains many low-code booking
installs (Retell or Vapi in front, n8n / Make / GoHighLevel / Cal.com behind)
for client businesses. They hit this at every client, have no database to add a
constraint to, and need checks that keep running.

**Free users and source of signal:** vertical voice startups with their own
backend. They can stop duplicates with one unique constraint. They will run the
audit, fix it themselves, and tell us what the audit got wrong.

**Not the buyer:** the dental office, the HVAC shop, or "teams running agents".

The qualifying question:

> When a client tells you a caller was double-booked, or was told they were
> booked and was not, how do you find out which other calls it happened on?

Teams with a real answer are not buyers. Teams that say "we wait for the next
complaint" are.

The test of the first-payer hypothesis: does an agency run the audit on more
than one client account?

## Differentiation

- **Voice platforms** (Retell, Vapi, LiveKit, Pipecat) orchestrate the call.
  Each fixes its own side and tells the builder to make the endpoint idempotent.
- **QA and observability** (Cekura, Hamming, Coval) test and monitor the
  conversation. These stack with an audit; they do not replace the booking
  system as the source of truth, and neither does this.
- **Automation tools** (n8n, Make, Zapier) are the pipes the booking travels
  through. They deliver at least once and do not know the outcome.
- **Agentbase** is about the booking itself: one intent, one appointment, and
  the truth when nobody knows.

## Moat (hypothesis, not yet earned)

- **How each booking backend behaves.** Which ones deduplicate, on what key,
  and which can be looked up after a timeout. Grubby per-backend truth that
  only accumulates by doing the work.
- **Neutral across platforms.** An agency runs more than one.
- **The shapes of failure.** Every real log the audit gets wrong makes it
  better at the next one.

## What was retired on 2026-11-16

The headline that described Agentbase as horizontal infrastructure for any AI
agent. Three versions of it (sales agents, safe actions for internal agents,
one commit layer under every kind of agent) produced zero users. Exactly-once sold as
general infrastructure is a feature that workflow engines, MCP gateways and the
model labs are absorbing, and the standalone attempts at it have almost no
users.

The engine is kept. The claim that it is the product is not.

The bundled outbound, follow-up, reply-handler and CRM-hygiene flows in
`apps/api/src/agent-runtime/` remain a **frozen reference implementation**. So
do the sales connectors, Slack approvals, the policy editor and the dashboard.

## Status

**Demand is unvalidated.** As of 2026-11-16 nobody outside the founder has run
the audit. It is tested against hand-built fixtures shaped like the Retell API
reference, not against a body of real call logs. It is not on npm. Do not
describe pilots, users, or revenue that do not exist.

The next step is one outside builder running it on their own calls. The stop
rule: if fewer than three have done so by 2026-12-14 after ten or more posts
where the bug is being reported, stage two does not get built and the question
becomes whether the bet or the channel is wrong.
