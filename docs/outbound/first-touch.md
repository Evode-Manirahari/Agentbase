# First-touch outbound

Cold message to send to a target on day one. Goal: one **yes/no** question that surfaces whether they have the blocked-pilot pain. If the answer is "no" or "we don't run an AI SDR," disqualify and move on — they're not the buyer for v1.

## Who to send to

The strategy doc spec'd this; tightening here:

| Field | Target |
|---|---|
| **Title** | VP RevOps, Head of Revenue Operations, Director of Revenue Systems, GTM Systems Lead, Salesforce Admin (in a RevOps function), AI Operations Lead |
| **Company size** | Series B–D B2B SaaS, 150–1,000 employees, 25–200 sellers |
| **Stack signals** | Salesforce or HubSpot, Gmail or Outlook, Slack, Outreach or Salesloft, Apollo or ZoomInfo or Clay, Okta, Vanta |
| **Trigger signal (priority)** | One of: their team posted about evaluating 11x / Artisan / Regie / Outreach AI / Salesforce Agentforce / HubSpot Breeze in the last 90 days; they hired an "AI Operations" or "AI Sales Engineer" role recently; they posted a job for "RevOps Manager" mentioning AI; their CRO mentioned AI productivity on an earnings call |
| **De-prioritize** | Pre-seed/seed companies (no security function to satisfy); pure-PLG companies with no SDR motion; companies whose only AI usage is summarization/research; agencies and consultancies (they're channels, not buyers — see below) |

## The 30-day list

120 hand-picked targets, split as the doc spec'd:

- 60 RevOps / Revenue Systems leaders (direct buyers)
- 20 RevOps consultancies (channel — they see broken workflows across multiple clients)
- 20 AI SDR / agent vendors (channel — they lose enterprise deals on governance and may bundle Dejavas as the unlock)
- 20 Security/IT leaders, only at companies where step 1 already showed AI adoption signals

Keep this list in a Notion table or a CSV in `docs/outbound/targets.csv`. Don't track 500 people you can't follow up with.

## The message

**Subject line A (default):**
> An AI SDR your security team can actually approve

**Subject line B (when the prospect's company has posted publicly about an AI SDR pilot):**
> The AI SDR pilot {{company}} mentioned — is it past draft-only yet?

**Body:**

```
Hey {{first_name}} —

I'm building Dejavas. It's an AI SDR that comes with the safety rails security needs to actually let it run in production.

Pattern I keep seeing: RevOps buys an AI SDR (11x / Artisan / Regie / one of the natives), runs a pilot, then security pulls the OAuth scopes the moment it tries to write to Salesforce or send a real email. The agent gets stuck in draft-only mode and the pilot dies on the vine.

Dejavas ships the agent with the approval gate baked in. Every risky write — gmail.send, deal updates over $10k, sequence enrollments — pauses for a human to approve in Slack before it touches a CRM record. Audit export and policy YAML for SOC 2.

I'm looking for 5 design partners. 60-day paid pilot ($5–10k), one workflow, you keep your existing CRM and we sit in front of one risky action.

One question: do you currently have an AI sales agent or workflow that's stuck in draft-only because security won't approve the write scopes?

— Evode
```

**Length target:** ~120 words. Anything longer gets skimmed.

## Why this message

- Names the **exact pain** in the subject ("security team can actually approve") instead of generic "AI agent governance"
- Names the **competitor cohort** by name (11x, Artisan, Regie) so the reader knows we understand the buying moment
- The "draft-only mode" phrase is the **diagnostic** — if the reader nods, they're a fit; if they don't recognize it, they're not
- One **yes/no qualifying question** at the end. No CTA to "hop on a call" yet — that ask comes in the follow-up after they answer

## Variants by buyer

### To an AI SDR vendor (channel)

Subject: **Are governance objections killing your enterprise deals?**

```
Hey {{first_name}} —

I'm building Dejavas — an AI SDR governance layer that AI sales agent vendors can embed so enterprise security stops blocking pilots.

Pattern I see: your product works fine in mid-market, but Series C+ deals stall at security review because RevOps can't get OAuth scopes approved.

I want to be the "yes, you can deploy this in prod" answer for {{company}}'s enterprise prospects. Embed Dejavas's approval gate + audit export, sell the bundle.

Is governance/security an objection coming up in any deals you're working right now?

— Evode
```

### To a RevOps consultancy (channel)

Subject: **Are your clients' AI SDR pilots dying at security review?**

```
Hey {{first_name}} —

Solo founder building Dejavas — an AI SDR a RevOps team can actually run in production because every risky CRM/email write pauses for human approval in Slack.

Curious if you're seeing this pattern in client work: RevOps buys an AI SDR, security blocks the scopes, pilot dies. I'm looking for 5 design partners and would happily pay a referral or a fee for the intro to the right RevOps team.

Are you working with any clients whose AI sales pilot stalled on security?

— Evode
```

## What "good" looks like in 30 days

- 40 first-touch sent
- 60 total touches (with follow-up — see [follow-up.md](./follow-up.md))
- 6 booked calls
- 2 verbal design-partner candidates by end of week 2

If you're under those numbers, the message isn't landing — change the subject line first, the body second, the targeting third.

## Tracking

Each send needs three fields in the tracker:

| Field | Why |
|---|---|
| `replied_yes` (boolean) | "Yes we have this pain" → priority follow-up |
| `replied_no` (boolean) | Disqualify and remove from sequence |
| `silent_after_2_touches` (boolean) | Move to long-term nurture, not the active list |

Stop guessing about open rates. The answer to the qualifying question is the only signal that matters.
