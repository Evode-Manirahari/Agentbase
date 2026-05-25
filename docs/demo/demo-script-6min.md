# 6-minute demo storyboard

Storyboard for the recorded demo video you'll attach to outbound touch 2 and play on the first 4 minutes of a discovery call. Six minutes total, six scenes. Record in one take if you can; voiceover in editing is fine.

## Constraints

- **One lead, not a batch.** Multi-lead is impressive but you don't have a feature for it yet, and a single lead is enough to show the whole loop.
- **One stack, not five.** Use HubSpot + Gmail + Slack — that's the slice the outbound revenue-agent job ships with. If a prospect runs Salesforce, do a custom recording for them; don't try to be everything for everyone in the public video.
- **Show one approval pause.** That's the demo's payoff moment. Don't show three.
- **No talking-head intro.** Cold open on the dashboard. The viewer is on touch 2 — they've read the message, they don't need to know who you are yet.
- **Show real text, not Lorem Ipsum.** The agent's email draft should be plausibly something a buyer would send. Pre-record with `cto@globex.com` so the prospect's eye lands on something recognizable.

## Six scenes

### Scene 1 — The blocked pilot (0:00 – 0:45)

**Visual:** A single side-by-side: left, a Slack channel called `#sales-agent-pilot` with one human message ("@RevOps the agent's been in draft-only for 3 weeks, when does it actually send?"); right, a CRM showing a stalled lead.

**Voiceover (45 sec):**

> "Here's the thing every AI sales-agent pilot in 2026 looks like:
>
> RevOps deploys the agent. The agent works. It enriches the lead, drafts a great email, opens a contact record in HubSpot. Then it tries to send.
>
> And security pulls the OAuth scopes.
>
> So the pilot sits in draft-only mode. Three weeks. Six weeks. Eventually the team gives up.
>
> Agentbase gives that agent a secure action layer. Let me show you."

### Scene 2 — Start a governed run (0:45 – 1:30)

**Visual:** Cut to the Agentbase dashboard at `/campaigns`. Show the form: Job dropdown (Revenue Agent — outbound), Agent identity dropdown (Sales Agent profile selected), Lead email field, Notes field. You type:

- Email: `cto@globex.com`
- Notes: `Downloaded our pricing PDF this morning. Hit our docs from a Google search for "Salesforce AI agent governance." Series B fintech, ~280 employees.`

Click **Start governed run**. Page redirects to `/campaigns/batch/[id]`.

**Voiceover (45 sec):**

> "I'm running a governed revenue agent against one inbound lead — a CTO at a fintech who downloaded our pricing PDF this morning.
>
> The agent identity is registered in Agentbase with a Sales Agent permission profile — that profile says what the agent can do on its own and what needs a human.
>
> One click."

### Scene 3 — Auto-execute (1:30 – 2:45)

**Visual:** Run detail page polling live. Transcript fills in:

1. `agent_thinking`: "Let me enrich this lead through Apollo first..."
2. `tool_call`: `apollo.people.match` → `tool_result`: **executed** (allow)
3. `tool_call`: `apollo.organizations.match` → `tool_result`: **executed** (allow)
4. `agent_thinking`: "Title is CTO at Series B fintech, ~280 headcount, Salesforce-heavy stack per the enrichment data..."
5. `tool_call`: `hubspot.contacts.upsert` → `tool_result`: **executed** (allow)
6. `tool_call`: `gmail.draft.create` → `tool_result`: **executed** (allow). Expand the draft, show the personalized body referencing Salesforce + Series B + the pricing PDF download.

**Voiceover (75 sec):**

> "The agent's working through Claude. Adaptive thinking on — you can see its reasoning right in the timeline.
>
> Apollo enrich — that's a read, allow it.
>
> HubSpot contact upsert — also auto-approved because the policy lets low-risk CRM writes execute without a human.
>
> Gmail draft create — also auto. Drafts never leave the outbox, so there's no risk yet.
>
> Notice the email it wrote. It picked up that we're a Salesforce shop with security pain — that's not in any prompt I wrote; that's the agent reading the lead context and Apollo data and putting them together."

### Scene 4 — The pause (2:45 – 3:45)

**Visual:** Next transcript entry:

7. `tool_call`: `gmail.send` → `tool_result`: **awaiting_approval** (require_approval, policy reason: "outbound email needs human sign-off")

Run status banner flips to **paused — waiting on human approval**. Cut to Slack: a card has landed in `#agent-approvals` with the full email body, the recipient, the policy reason, and Approve/Deny buttons.

**Voiceover (60 sec):**

> "And here's the moment. The agent tries to actually send the email — and Agentbase pauses the entire run.
>
> The policy template fired: outbound email needs human approval before it leaves the outbox.
>
> In Slack, RevOps gets the full email body, the recipient, the policy reason, and two buttons. They don't have to context-switch — they read the email right where they're already working.
>
> The agent isn't blocked. It's not dead. It's paused. The conversation state is persisted. The moment a human clicks approve, it picks up where it left off."

### Scene 5 — Approve in Slack, resume (3:45 – 5:00)

**Visual:** Show the cursor click **Approve** in the Slack card. Slack card updates to "Approved by Evode at 14:23". Cut back to the run detail page — within 2 seconds the status flips to **running**, then **completed**. New transcript entries appear:

8. `tool_result`: `gmail.send` updated to **executed** (the approval landed)
9. `agent_thinking`: "Email sent. Logging the activity to HubSpot and wrapping up."
10. `agent_message`: A clean summary paragraph — what happened, what's next for the human.

**Voiceover (75 sec):**

> "I click approve in Slack.
>
> Couple seconds later, the action transitions to executed in Agentbase, the worker enqueues a resume job, and the agent loop continues — picks up exactly where it left off, no replay, no re-running Apollo or HubSpot.
>
> Claude acknowledges the approval, writes a one-paragraph summary of what happened, and the run completes.
>
> Notice what just happened: the agent took five actions, four executed automatically, one paused for a human, the human clicked one button in Slack, and the loop kept going. From start to finish, the human was in the loop for about 30 seconds."

### Scene 6 — The audit trail (5:00 – 6:00)

**Visual:** Click over to `/audit`. Filter by `event_type: action.executed` and the current hour. Show the rows: enrichment, contact upsert, draft create, approval.approved (with the approver's email), action.executed (the gmail.send). Click **Download CSV**. Show the resulting file open in a spreadsheet — 12 columns, every column populated, the email body in `payload_json`.

**Voiceover (60 sec):**

> "Last thing. Every state transition is in the audit log.
>
> Who did it — the agent identity for the actions, the human's email for the approval.
> What they did — the tool, the params, the policy decision, the action ID.
> When — to the second.
>
> Download as CSV. Hand it to your security team. This is what they'll want for SOC 2 review, customer security questionnaires, anything else that asks "show me what your AI agents actually did last week."
>
> If you've got an AI sales-agent pilot that's been blocked from production actions, this is the unblock. Twenty-minute call to scope a pilot — link in the description."

## Production notes

- **Tool:** Loom or QuickTime + iMovie. Don't overthink production. Founders who try to make video-agency-quality demos in week 2 burn the wrong week.
- **Resolution:** 1080p minimum. 1440p if your screen supports it cleanly. Don't record at 4K — file size kills email open rates.
- **Audio:** Use a real microphone (Yeti, Shure MV7, or even AirPods Pro in a quiet room). Built-in laptop mic = unwatchable.
- **Cursor:** Add a cursor highlight (Cursor Pro or built into Loom). The viewer is following your clicks; make them findable.
- **Captions:** Auto-generate, then proofread. ~30% of recipients will watch with sound off the first time.
- **Total length:** 6 minutes hard cap. If the first cut is 7:30, you have at least 90 seconds of throat-clearing to cut — usually scene 1 or scene 3.
- **Filename:** `agentbase-demo-6min.mp4`. Host on Loom or Mux; **don't** attach the file to an email — it gets stripped by half of mail servers.

## What to record in case prospects ask for them later

Don't record these yet — wait until a prospect asks. Then record a custom one with their stack:

- The same loop with Salesforce instead of HubSpot (same flow, different connector)
- A deal-update flow with a high-value-deal-approval pause instead of the email pause
- A walkthrough of the audit export in detail for a security-team-only audience
