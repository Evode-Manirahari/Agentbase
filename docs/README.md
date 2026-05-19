# Dejavas operator docs

Playbooks for actually selling and demoing the product, not for building it. The repo's [top-level README](../README.md) covers the engineering surface; this folder is for the GTM motion the strategy doc spec'd.

## What's here

| File | When you use it |
|---|---|
| [`outbound/first-touch.md`](./outbound/first-touch.md) | Day-one cold message. Includes the 30-day target list criteria + the qualifying question. |
| [`outbound/follow-up.md`](./outbound/follow-up.md) | 3-touch follow-up cadence after the first send. Includes the break-up message. |
| [`outbound/discovery-call-script.md`](./outbound/discovery-call-script.md) | 20-minute first-call script. Six forcing questions; goal is one of three clear bucket answers by minute 20. |
| [`demo/demo-script-6min.md`](./demo/demo-script-6min.md) | Storyboard for the 6-minute recorded demo. Six scenes, exact voiceover, production notes. |

## How they fit together

```
Day 0    → first-touch.md       (40 sends, week 1)
Day 4    → follow-up.md (touch 2 + demo video link)
Day 7    → reply yes/no? if yes:
              → discovery-call-script.md
              → after the call: send security packet, scope pilot
Day 11   → follow-up.md (touch 3, break-up) — only if no reply yet
Day 14   → if pilot scoped: kickoff
Day 60   → pilot ends → expand or kill
```

## What this folder is NOT

- Not a marketing site. The hero copy on the live product page is in the [top-level README](../README.md) and [`apps/web/`](../apps/web/).
- Not a sales CRM. Track outreach in Notion/Linear/a spreadsheet — these files are stable templates, not a moving target list.
- Not a security packet. That's [`../SECURITY.md`](../SECURITY.md). Send it after the discovery call, when the prospect asks "what do I show my security team?"
- Not a runbook for the agent itself. That's the engineering surface — see the campaigns dashboard at `/campaigns`.

## When to update

- **first-touch.md, follow-up.md** — when the qualifying question stops working. Track which subject line and which body text led to replies; iterate after every 30 sends.
- **discovery-call-script.md** — after the first 5 real calls. The six forcing questions will need tightening once you've heard real answers.
- **demo-script-6min.md** — when a prospect's pushback during the demo reveals a missing scene, or when the product evolves (v1.1 CRM hygiene, v1.2 deal-update) and the demo needs a second flow.

Don't optimize these before they're tested. The first 30 sends + 5 calls are the only feedback that matters.
