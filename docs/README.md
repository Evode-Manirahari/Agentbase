# Agentbase docs

Documentation for what Agentbase claims and how it holds. The repo's
[top-level README](../README.md) is the front door.

## What's here

| File | When you use it |
|---|---|
| [`positioning.md`](./positioning.md) | Source of truth: category, pitch, buyer, the two qualifiers, what exists, what does not, and what is not yet validated. CI enforces it via `scripts/check-positioning.sh`. |
| [`effect-commit.md`](./effect-commit.md) | The commit protocol the engine implements: reserve before dispatch, settle with the provider's reference, quarantine, replay. Read this before changing anything in `apps/api/src/actions/`. |
| [`demo/byoa-60s.md`](./demo/byoa-60s.md) | Sixty-second walkthrough of the frozen reference agent. Engine material, not the product. |

The product's own documentation lives next to the code:

- [`packages/booking-audit/README.md`](../packages/booking-audit/README.md): the audit, its checks, options and privacy notes.
- [`examples/voice-booking-repro/README.md`](../examples/voice-booking-repro/README.md): the reproduction and what it does and does not show.

## There is no sales playbook, on purpose

Earlier playbooks were written for positions that never met a customer, and
were removed. Writing a new script before a single conversation has happened
would be inventing objections nobody has raised.

The qualifying question:

> When a client tells you a caller was double-booked, or was told they were
> booked and was not, how do you find out which other calls it happened on?

Write the playbook after five builders have answered it.

## What this folder is NOT

- Not a marketing site. Hero copy lives in [`apps/marketing/`](../apps/marketing/).
- Not a build guide. Sequencing, the gate on stage two, and deferred work live in [`TODOS.md`](../TODOS.md).
- Not a place for prospect replies or call logs. The repo is public.
