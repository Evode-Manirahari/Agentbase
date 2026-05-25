# Bring-your-own-agent — 60-second demo storyboard

A short screen recording you can drop into outbound touch #2, the dashboard, the website hero, and the discovery-call deck. The point is to make one claim land: *"Agentbase governs your agent, not just ours."*

## Constraints

- **60 seconds, hard cap.** Buyers don't watch longer videos on first touch.
- **No talking head.** Just terminal + dashboard + Slack, screen-only.
- **One claim per scene.** If a frame is doing two jobs, cut one.
- **No voice-over.** Captions and on-screen text. Plays muted in LinkedIn, sales emails, and decks.

## Before you press record

- Reset to a clean demo state: `pnpm --filter @agentbase/api db:push --force`, no existing actions in `/audit`.
- Two browser tabs: `localhost:3000/agents` and Slack `#agent-approvals`.
- One terminal, font size 18+ so it reads on a phone preview.
- Tab title bars trimmed (no random `localhost:3000 — Mozilla Firefox`).
- Mouse-trail / cursor-highlight extension on so the viewer can follow clicks.

## Scenes

| # | t | Frame | On-screen text / caption | Action |
|---|---|---|---|---|
| 1 | 0:00–0:06 | `/agents` dashboard | **"Agentbase: the secure action layer for AI sales agents."** | Cursor lands on the Register agent button. Click. |
| 2 | 0:06–0:12 | "Register agent" modal | **"One identity, scoped permissions, revocable."** | Type `My agent`. Select **Sales Agent** profile. Click Create. Copy the `agb_…` key with a flourish. |
| 3 | 0:12–0:18 | Terminal — `cat examples/byoa-vercel-ai/src/index.ts \| head -40` | **"Your agent. Vercel AI SDK. ~120 lines."** | Scroll the file so the `tools` block (5 tool definitions) is on screen. |
| 4 | 0:18–0:24 | Terminal — same file | **"Every tool call → `agentbase.executeAndWait`."** | Highlight one `execute: async (params) => runThroughGate('gmail.send', params)` line. |
| 5 | 0:24–0:34 | Terminal — running | **"Run it." → `pnpm --filter @agentbase/byoa-vercel-ai start`** | Lines stream: `[agentbase] apollo.people.match executed`, `hubspot.contacts.upsert executed`, `gmail.draft.create executed`, then `gmail.send awaiting_approval`. |
| 6 | 0:34–0:42 | Slack `#agent-approvals` | **"Policy paused the send. Slack ✓."** | Slack approval card animates in with the email body, recipient, and the policy reason. Click ✓ Approve. |
| 7 | 0:42–0:50 | Terminal | **"Same agent, resumed."** | The agent's terminal output shows `gmail.send executed`, then the final Claude summary lines. |
| 8 | 0:50–0:58 | `/audit` page | **"Every step recorded. Download CSV. Send to security."** | The audit log shows all five actions in order with their status pills and decision reasons. Cursor lands on Download CSV. |
| 9 | 0:58–1:00 | Title card | **"Agentbase. Bring your agent. Ship it."** + URL | 2-second hold. |

## Captions / copy reference

- Hero claim: *Agentbase: the secure action layer for AI sales agents.*
- Tooling claim: *Your agent. Vercel AI SDK. ~120 lines.*
- Policy claim: *Policy paused the send. Slack ✓.*
- Resume claim: *Same agent, resumed.*
- Audit claim: *Every step recorded. Download CSV. Send to security.*

## What this proves

In 60 seconds the viewer sees three things they cannot get from a single-vendor agent governance product (Agentforce, Breeze, Outreach controls):

1. **It's their agent.** The Vercel AI SDK code is the same code they'd write without Agentbase. One import + one call wrapper.
2. **Security is real.** Slack approval, policy reason, audit CSV — all in the same flow.
3. **Cross-stack.** Apollo → HubSpot → Gmail → Slack in one run. The same loop holds for Salesforce + Outreach.

## Distribution checklist

- [ ] Recorded with [tella.tv](https://tella.tv) / [Loom](https://loom.com) / OBS — pick whichever your team standardizes on
- [ ] Hosted on the Agentbase site / Loom / YouTube (unlisted) with a clean short URL
- [ ] Caption file (.vtt) attached for LinkedIn auto-play
- [ ] 9:16 vertical cut for X / LinkedIn / TikTok if you're using paid distribution
- [ ] Linked from:
  - Outbound touch #2 ([`docs/outbound/follow-up.md`](../outbound/follow-up.md))
  - Top-level README hero
  - [`docs/positioning.md`](../positioning.md) (link to recording under "Bring your own agent")
  - Discovery-call script (the 5-minute "show me" beat)
