# Agentbase operator docs

Documentation for what Agentbase claims and how it holds. The repo's
[top-level README](../README.md) covers the engineering surface.

## What's here

| File | When you use it |
|---|---|
| [`positioning.md`](./positioning.md) | Source of truth: category, pitch, buyer, the conditional guarantee, and what is not yet validated. CI enforces it via `scripts/check-positioning.sh`. |
| [`effect-commit.md`](./effect-commit.md) | The protocol itself — reserve before dispatch, settle with the provider's reference, quarantine, replay. Read this before changing anything in `apps/api/src/actions/`. |
| [`demo/byoa-60s.md`](./demo/byoa-60s.md) | Sixty-second bring-your-own-agent walkthrough. |

## The GTM playbooks were removed

`outbound/first-touch.md`, `outbound/follow-up.md`,
`outbound/discovery-call-script.md`, and `demo/demo-script-6min.md` sold the
retired positioning — cold opens about stalled RevOps pilots, a six-scene
storyboard built on HubSpot and Gmail, a discovery script whose qualifying
questions were about CRM write scopes.

They were not stale wording around a good pitch. They were a different product's
pitch, and rewriting them before a single conversation has happened would be
inventing a script for objections nobody has raised yet.

The qualifying question that replaces all of it:

> When your agent crashes mid-call, how do you currently find out whether the
> thing happened?

Write the playbook after five people have answered it. Git history has the old
ones if the beachhead ever comes back.

## What this folder is NOT

- Not a marketing site. Hero copy lives in [`apps/marketing/`](../apps/marketing/).
- Not a build guide. Sequencing and deferred work live in [`TODOS.md`](../TODOS.md).
