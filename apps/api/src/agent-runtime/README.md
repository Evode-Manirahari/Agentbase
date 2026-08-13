# agent-runtime — FROZEN REFERENCE IMPLEMENTATION

**This directory is not the product.** It is the bundled AI SDR, kept as proof
that the commit layer works on a real agent doing real work.

The product is the layer this code calls into:

| Where | What |
| --- | --- |
| [`../actions/`](../actions) | The commit protocol — reserve before dispatch, receipts, quarantine, replay |
| [`../../../../packages/effects/`](../../../../packages/effects) | Classification by consequence — effect class + reversibility |
| [`../../../../docs/positioning.md`](../../../../docs/positioning.md) | What Agentbase sells, and what it deliberately does not |

## What lives here

Four jobs in [`jobs/`](./jobs) — `ai-sdr-outbound`, `ai-sdr-followup`,
`ai-reply-handler`, `ai-crm-hygiene` — plus the loop that runs them
(`agent-runtime.service.ts`), run persistence and resume (`agent-runs.service.ts`,
`agent-run.processor.ts`), the dashboard's launch surface
(`campaigns.controller.ts`), and reply polling (`emails.service.ts`).

Every tool call these jobs make goes through the same gate any third-party agent
hits via `@agentbase/sdk` or the MCP server. That is the whole point: when
`gmail.send` pauses for approval here, it is the same code path that pauses
`terraform destroy` in `examples/effect-gate-demo`. Nothing in this directory
gets a private door.

## Freeze policy

- **No new features.** Not new jobs, not new sequence logic, not new connectors
  wired only for this runtime.
- **Keep CI green.** Bug fixes, dependency bumps, and changes forced by the
  layer below are fine and expected.
- **Improving the SDR is not progress.** If a change makes this agent better at
  selling without making the commit layer better, it is the wrong change.

## Why this exists as a marker

This is the largest module in the API and among the least tested, which makes it
the easiest thing in the repo to mistake for the main event. It was the headline
product until the 2026-06 wedge pivot.

**Frozen does not mean detachable.** The API core imports this module today:

- `app.module.ts` registers `AgentRuntimeModule`
- `queue/queue.module.ts` and `queue/expiry.processor.ts` pull
  `AgentRunProcessor`, `EmailsService`, and `AgentRunsService`
- `approvals/approvals.service.ts` calls `AgentRunsService` to resume a run once
  an approval is decided

That last one runs on a live product path, not a demo path. So deleting this
directory is not a cleanup — approval resolution would have to stop notifying
run state first. (An earlier note in `TODOS.md` claimed
`examples/cross-stack-demo` was what pinned it here; that is no longer true —
the demo talks to the gate over HTTP through `@agentbase/sdk` and imports
nothing from this directory.)

Sales language — "SDR", "outbound", "prospect", "campaign" — is **correct inside
this directory and its examples, and nowhere else.**
`scripts/check-positioning.sh` allowlists this path for exactly that reason; a
retired tagline anywhere outside it fails CI.

See `TODOS.md` for deferred work and why most of it is blocked on demand
evidence rather than engineering.
