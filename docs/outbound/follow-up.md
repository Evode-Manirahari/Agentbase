# Follow-up sequence

Three touches max after the first-touch (see [first-touch.md](./first-touch.md)). Stop after touch 3 if there's no reply; move them to long-term nurture, not the active list. Time is a finite resource at 15hr/week.

## Cadence

| Touch | When | Goal |
|---|---|---|
| **#1 First-touch** | Day 0 | Get a yes/no on the qualifying question |
| **#2 Sharpen the pain** | Day 4 | Name the diagnostic phrase more precisely; offer the 6-min demo video |
| **#3 Break-up** | Day 11 | Last touch; give them an easy out and a clear future signal to come back |

Stop. If they engage on touch 2 or 3, treat them as a fresh prospect and book a call. If they don't, they're not the buyer for v1 — don't burn cycles.

## Touch 2 — Sharpen the pain

Send 4 days after touch 1, only if no reply.

**Subject (reply to the original thread):** `Re: Letting sales agents touch CRM?`

```
Following up on the earlier note.

The sharpest fit I keep seeing is teams where one specific thing is true:

  "We have an AI sales agent or RevOps workflow, but it cannot take
   production actions because security/IT won't approve the write scopes."

If that's happening at {{company}}, I'd love 20 minutes. I've got a
6-minute demo video that shows the loop end-to-end — agent enriches
the lead, proposes the CRM/email action, pauses for human approval in
Slack when policy requires it, executes after approval, audit log
captures everything.

Want me to send it?

— Evode
```

**Why this version works**

- Restates the diagnostic phrase from touch 1, in quotes, so the reader can self-qualify
- Offers a **6-minute video** instead of a meeting — lower friction, builds trust
- Single ask: do you want the video? — even easier yes than the original yes/no

## Touch 3 — Break-up

Send 11 days after touch 1, only if still no reply.

**Subject:** `Closing the loop`

```
{{first_name}} — closing the loop on this one. I'll stop following up.

If you ever do end up with an AI sales agent blocked from production
actions because security won't budge on scopes, send me a one-line reply and I'll
come back to this thread.

No worries either way — appreciate the time.

— Evode
```

**Why this works**

- Removes pressure → some people only reply once they're sure you'll go away
- Gives them a precise **trigger condition** ("if you ever do end up with X") so they have a future reason to remember you
- One line to reply → minimum activation energy

The break-up sometimes gets a "wait, actually we're hitting this now" reply. Don't be cute about it; that's the goal.

## What to do on a yes/no reply

### "Yes, we have this pain"

Reply within 2 hours during business hours. Two sentences max:

```
Great — what's the blocked action? CRM write, outbound email,
sequence enrollment, something else?

Happy to send the demo video first, or hop on a 20-min call this
week — whichever's easier.
```

If they respond with the blocked action, you've earned the call. Book it. The discovery script is in [discovery-call-script.md](./discovery-call-script.md).

### "Not us / no pain"

Two outcomes:

1. **They explain why** ("we've solved this with native HubSpot controls" / "we don't run AI agents") → thank them, mark disqualified, move on. Don't argue.
2. **They explain their adjacent pain** ("we built an enrichment or CRM-update agent that's stuck") → that **is** the buyer; reply with the qualifying question for the adjacent workflow.

### "Send me more info / I need to think about it"

Reply with the 6-minute demo video link and a calendar link. Don't write paragraphs.

```
Sure — 6-minute demo here: {{video_url}}
Calendar: {{calendly_url}}
```

If they don't book in 5 days, that was a soft no.

## What to do on no reply after touch 3

- Move them to a `nurture-2026-q3.csv`
- Don't email them again unless one of three things happens:
  1. They post publicly about an AI sales-agent pilot
  2. Their company hires for an "AI Operations" role
  3. You ship a major case study they would recognize as a peer
- If none of those happen, they were never the buyer
