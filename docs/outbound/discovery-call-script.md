# Discovery call script (20 minutes)

For the first call with a qualified RevOps prospect who said "yes, we have this blocked-agent pain" on the outbound touch.

## Goal of the call

Get one of three answers by the end of 20 minutes:

1. **Strong yes:** "I want to be a paid design partner. What's the price and start date?"
2. **Conditional yes:** "I want this, but I need to bring in [security person / CRO / IT] before I can commit. Can you do that call this week?"
3. **Not yet:** "We don't have the right workflow blocked today. Come back when X happens."

You don't need a "no" — silence is a no. What you can't survive is leaving the call without knowing which of the three bucket they're in.

## Before the call (5 minutes prep)

- Look up the company size, stack, recent funding, and any public posts about AI from anyone there in the last 90 days
- Have the 6-minute demo video ready to share in chat
- Have a Notion or Linear doc open titled "{{company}} — {{date}}" for note-taking

## Structure (~20 minutes)

| Minutes | Phase | What you're doing |
|---|---|---|
| 0–2 | Open | One sentence on you; immediate handoff to them |
| 2–10 | Diagnose | Six forcing questions; mostly listening |
| 10–14 | Confirm fit | Restate their pain; show the 60-second slice of the demo that addresses it |
| 14–18 | Position the pilot | Price, scope, timeline; ask for the commit |
| 18–20 | Close | Confirm next step + date; capture security/IT contact |

## 0–2: Open

> "Quick context: solo founder, building Agentbase — the secure action layer for AI sales agents across CRM, email, and sales tools. I've got six questions that should take about ten minutes, then I'll show you a 60-second slice of the demo, and then we can talk about whether a pilot makes sense. Sound good?"

That's it. Don't pitch yet. They said yes to the call because they're already curious — the call is for **you to qualify them**, not for them to qualify you.

## 2–10: Six forcing questions

Ask all six. Take notes. Resist the urge to pitch in between.

### Q1 — Demand reality

> "Walk me through what's actually happening. What agent or workflow do you have today that's blocked from production writes?"

Listen for: a specific product name (11x, Artisan, Regie, Agentforce, HubSpot Breeze, custom-built), a specific stuck workflow (outbound email, CRM updates, sequence enrollment, lead routing, deal summaries). Vague answers like "we're exploring AI" = not a buyer.

### Q2 — Status quo

> "What's the workaround right now? How is the team operating in the gap?"

Listen for:
- "Draft-only mode" — strongest signal
- "We export to CSV and someone copies things over manually"
- "We have a service account that one person uses on behalf of the agent" — security loves to hear this is happening (they don't); strong fit
- "We just turned it off" — strong fit
- "Salesforce validation rules handle it" — weak fit; they think they've solved it

### Q3 — Desperate specificity

> "What's the **first** action you would never let an AI agent do without a human approving it?"

This is the most important question on the call. Their answer is your **expansion roadmap**. The exact phrasing of their answer should appear word-for-word in your product later.

### Q4 — Narrowest wedge

> "If I could unblock exactly one workflow in 60 days — not the whole AI strategy, just one specific action — which one would actually move the needle for your team this quarter?"

Listen for: a specific tool name + a specific risk threshold. "Outbound email above some volume threshold" / "deal stage updates over $25k" / "any external customer-facing message". If they can't answer in concrete terms, the pain is theoretical.

### Q5 — Observation

> "Who blocked it? What did they say specifically?"

You're looking for the security/IT objection in their own words. This becomes your security-brief response. If they don't know who blocked it or what was said, the deal will stall later — flag it.

### Q6 — Future-fit

> "If we ran a 60-day pilot and at the end the agent was successfully sending email and updating CRM with human approval on the risky writes, what would you do with that?"

Listen for:
- "I'd expand it to the whole team" → strong fit
- "I'd bring it to the CRO for budget" → fit, will need a CRO call
- "I'd need to take it through procurement / legal / security review again" → fit, but slow
- "I'd evaluate it against [other vendor]" → weak fit; you're a checkbox, not the answer

## 10–14: Confirm fit + show the slice

Restate their pain in your words:

> "OK — so today {{paraphrased Q1}}, the workaround is {{Q2}}, and the action you'd never auto-approve is {{Q3}}. The pilot for you would be: we put Agentbase in front of {{Q4}}, your agent proposes it, our policy decides risk, your {{security/RevOps person}} approves the risky ones in Slack, action executes, audit log captures everything for {{Q5's person}}. Did I get that right?"

Wait for their nod or correction. Then play the 60-second demo slice that matches their exact workflow. Don't show the whole 6 minutes — show the part that mirrors their answer.

## 14–18: Position the pilot

```
"What I'm offering: $7,500 paid design partner pilot, 60 days,
one workflow — the one you just named. You keep your existing
{{Salesforce/HubSpot/Gmail/Outreach}} and existing agent if you have one; we sit
in front of the risky actions. End of 60 days, you either expand
or you don't. No annual commit, no procurement gauntlet.

Two questions:

  1. If we line up scope this week, can you start within 14 days?
  2. Who else needs to be in the room before you can say yes?"
```

Question 2 is the **single most important question** of the call. Their answer tells you the actual sales cycle.

## 18–20: Close + next step

Send the prospect away from the call with:

- A **specific date** for the next touchpoint (call with security, kickoff date, follow-up)
- A **named person** on their side (the security contact, the CRO, whoever Q2 surfaced)
- A **deliverable** from you (the security packet, a scoped pilot agreement, a custom demo slice for their stack)

If you can't name those three things by minute 20, the call didn't actually qualify them. End politely, no follow-up scheduled, and add them to nurture.

## After the call (10 minutes)

In the Notion/Linear doc:

| Field | Capture |
|---|---|
| **Blocked workflow** | Exact phrasing from Q1 |
| **First-never-auto action** | Exact phrasing from Q3 (this is your roadmap) |
| **Wedge action** | Exact phrasing from Q4 |
| **Security/IT contact name + email** | From the 18-min close |
| **Next step + date** | Locked in |
| **Estimated close probability** | High / medium / low — be honest |
| **What would kill this deal** | One sentence |

If you do 8–10 calls and only 1–2 land in "high probability," the wedge isn't the right wedge — see [../README.md](../../README.md) status section and the strategy doc kill criteria.

## What NOT to do on the call

- Don't demo the dashboard tour (Agents/Policies/Connectors/etc.). Show the governed action path only.
- Don't pitch identity / API keys / policy DSL features before the pain is clear. They are the trust mechanism, not the cold-open buying trigger.
- Use "Okta + Zapier + Datadog for AI sales agents" only after they understand the category: identity, governed execution, and observability.
- Don't promise features that aren't shipped. The shipped wedge is governed revenue-agent actions across HubSpot/Salesforce/Gmail/Outreach/Apollo with approval, revocation, and audit.
- Don't talk pricing in vague terms. $7,500 is the number; the only flexibility is "$1,500/month for 3 months on a department card" if procurement is the blocker.
