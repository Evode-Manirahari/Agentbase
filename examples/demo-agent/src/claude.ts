// Claude-driven variant of the demo agent.
//
// Same lead-processing flow as src/index.ts, but the order of operations is
// chosen by Claude (via Anthropic tool use) rather than hard-coded. Every
// tool the model calls still goes through @agentbase/sdk, so policy /
// approval / audit / connector mediation is identical — the difference is
// the reasoning layer on top.
//
// Run:
//   ANTHROPIC_API_KEY=sk-ant-... AGENTBASE_API_KEY=agb_... \
//     pnpm --filter @agentbase/demo-agent run start:claude [email]

import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { AgentbaseClient } from '@agentbase/sdk';

const agentbaseKey = process.env.AGENTBASE_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

if (!agentbaseKey) {
  console.error('Set AGENTBASE_API_KEY (run examples/demo-agent/setup.sh first)');
  process.exit(1);
}
if (!anthropicKey) {
  console.error('Set ANTHROPIC_API_KEY (the hard-coded variant src/index.ts works without one)');
  process.exit(1);
}

const agentbase = new AgentbaseClient({
  apiKey: agentbaseKey,
  baseUrl: process.env.AGENTBASE_BASE_URL ?? 'http://localhost:3002',
});

const anthropic = new Anthropic({ apiKey: anthropicKey });

interface AgentbaseResult {
  action_id: string;
  status:
    | 'pending'
    | 'awaiting_approval'
    | 'approved'
    | 'denied'
    | 'executed'
    | 'failed';
  result?: unknown;
  policy_decision?: {
    effect: 'allow' | 'require_approval' | 'deny';
    reason: string | null;
  };
}

const STATUS_ICONS: Record<AgentbaseResult['status'], string> = {
  pending: '⏳',
  awaiting_approval: '🛂',
  approved: '✅',
  denied: '🚫',
  executed: '✓',
  failed: '✗',
};

async function callAgentbase(
  label: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<string> {
  process.stdout.write(`\n→ ${label}\n  ${tool}\n`);
  const start = Date.now();
  const r = (await agentbase.execute({ tool, params })) as unknown as AgentbaseResult;
  const ms = Date.now() - start;
  const icon = STATUS_ICONS[r.status] ?? '?';
  console.log(`  ${icon} ${r.status} (${ms}ms)`);
  if (r.policy_decision) {
    console.log(
      `  policy: ${r.policy_decision.effect}` +
        (r.policy_decision.reason ? ` — "${r.policy_decision.reason}"` : ''),
    );
  }
  const err = (r.result as { error?: { code?: string; message?: string } } | undefined)
    ?.error;
  if (err) {
    console.log(`  ↳ connector: ${err.code} — ${err.message}`);
  }
  // Hand the model a compact JSON summary so it can keep reasoning.
  return JSON.stringify({
    action_id: r.action_id,
    status: r.status,
    policy: r.policy_decision,
    result: r.result,
  });
}

// Tool definitions — each one is a thin wrapper around agentbase.execute().
// Claude sees these schemas and decides what to call when.

const enrichPerson = betaZodTool({
  name: 'enrich_person',
  description:
    'Look up a person by email via Apollo enrichment. Returns title, company, LinkedIn, location, etc.',
  inputSchema: z.object({
    email: z.string().email().describe('The lead\'s email address'),
  }),
  run: async ({ email }) =>
    callAgentbase('Enrich the lead via Apollo', 'apollo.people.match', { email }),
});

const enrichCompany = betaZodTool({
  name: 'enrich_company',
  description:
    'Look up a company by domain via Apollo. Returns industry, size, funding, headcount, etc.',
  inputSchema: z.object({
    domain: z.string().min(1).describe('Company domain, e.g. acme.com'),
  }),
  run: async ({ domain }) =>
    callAgentbase(
      'Enrich the company via Apollo',
      'apollo.organizations.match',
      { domain },
    ),
});

const createHubspotContact = betaZodTool({
  name: 'upsert_hubspot_contact',
  description:
    'Create or update a contact in HubSpot CRM by email. Sets lifecyclestage to salesqualifiedlead by default.',
  inputSchema: z.object({
    email: z.string().email(),
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    company: z.string().optional(),
    jobtitle: z.string().optional(),
  }),
  run: async ({ email, firstname, lastname, company, jobtitle }) => {
    const properties: Record<string, unknown> = {
      email,
      lifecyclestage: 'salesqualifiedlead',
    };
    if (firstname) properties.firstname = firstname;
    if (lastname) properties.lastname = lastname;
    if (company) properties.company = company;
    if (jobtitle) properties.jobtitle = jobtitle;
    return callAgentbase(
      'Create or update the contact in HubSpot CRM',
      'hubspot.contacts.upsert',
      { email, properties },
    );
  },
});

const createHubspotDealFromLead = betaZodTool({
  name: 'create_hubspot_deal_from_lead',
  description:
    'Create or update a HubSpot contact, create an associated deal, and attach a note in one mediated CRM workflow.',
  inputSchema: z.object({
    email: z.string().email(),
    company: z.string().optional(),
    dealname: z.string().min(1),
    amount: z.number().optional(),
    dealstage: z.string().optional(),
    note: z.string().optional(),
  }),
  run: async ({ email, company, dealname, amount, dealstage, note }) =>
    callAgentbase(
      'Create HubSpot contact + deal workflow',
      'hubspot.leads.create_deal',
      omitUndefined({
        contact: omitUndefined({ email, company }),
        deal: omitUndefined({
          dealname,
          amount,
          dealstage: dealstage ?? 'appointmentscheduled',
        }),
        note: note ? { body: note } : undefined,
      }),
    ),
});

const draftGmailEmail = betaZodTool({
  name: 'draft_gmail_email',
  description:
    'Create a draft email in Gmail. The draft is NOT sent — a human reviews it before sending.',
  inputSchema: z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  run: async ({ to, subject, body }) =>
    callAgentbase(
      'Draft a personalized outreach email in Gmail',
      'gmail.draft.create',
      { to, subject, body },
    ),
});

const enrollOutreachSequence = betaZodTool({
  name: 'enroll_outreach_sequence',
  description:
    'Enroll a prospect in an Outreach sequence. This is high-stakes — typically gated by the policy and may require approval.',
  inputSchema: z.object({
    prospectId: z.string().min(1),
    sequenceId: z.string().min(1),
    mailboxId: z.string().min(1),
  }),
  run: async ({ prospectId, sequenceId, mailboxId }) =>
    callAgentbase(
      'Enroll the prospect in an Outreach sequence',
      'outreach.sequences.enroll',
      { prospectId, sequenceId, mailboxId },
    ),
});

const updateHubspotDeal = betaZodTool({
  name: 'update_hubspot_deal',
  description:
    'Update a HubSpot deal — amount, stage, etc. Updates over $10k typically require human approval.',
  inputSchema: z.object({
    dealId: z.string().min(1),
    amount: z.number().optional(),
    dealstage: z.string().optional(),
  }),
  run: async ({ dealId, amount, dealstage }) => {
    const properties: Record<string, unknown> = {};
    if (amount !== undefined) properties.amount = amount;
    if (dealstage !== undefined) properties.dealstage = dealstage;
    return callAgentbase(
      'Update high-value deal in HubSpot',
      'hubspot.deals.update',
      { dealId, properties },
    );
  },
});

const SYSTEM_PROMPT = `You are a sales-development agent processing inbound leads at a B2B startup.

Every action you take goes through Agentbase — a secure action layer that mediates each call against an organization-defined policy. Some actions are auto-allowed, some require human approval, some are denied. The policy is configured for your safety and the company's: trust it.

When a tool returns:
- status "executed" or "failed" with connector_not_configured → the action ran (or would have, given credentials). Continue with the next step.
- status "awaiting_approval" → the action is paused for a human. Don't retry; note it and move on. The human will approve in Slack or the web inbox.
- status "denied" → the action is blocked by policy. Don't try a workaround. Note it and move on.

For each lead, work through this playbook:
1. Enrich the person and the company via Apollo.
2. Create or update a contact record in HubSpot CRM.
3. Create a HubSpot lead deal when the lead is qualified enough to track.
4. Draft a personalized outreach email in Gmail (don't send — humans review drafts).
5. Enroll the prospect in an appropriate Outreach sequence.
6. If you have evidence the deal is high-value (e.g. enterprise tier, >100 employees), update the corresponding HubSpot deal with an estimated amount.

When you're done — or as soon as enough actions are awaiting approval that further work would be wasted — produce a brief summary of what happened: which steps executed, which need approval, and what the human should do next.

Be concise in your reasoning. The user is watching a live trace; long monologues hurt readability.`;

async function main() {
  const email = process.argv[2] ?? 'demo-lead@acme.com';

  console.log(`\n🤖 demo-agent (Claude-driven) — processing inbound lead`);
  console.log(`   ${email}`);
  console.log(`   model: claude-opus-4-7 · effort: xhigh · adaptive thinking\n`);

  const runner = anthropic.beta.messages.toolRunner({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // System prompt is stable across runs; this caches it once it crosses
        // the per-model minimum prefix length. For a small demo prompt it
        // won't activate, but the pattern is right for production.
        cache_control: { type: 'ephemeral' },
      },
    ],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
    tools: [
      enrichPerson,
      enrichCompany,
      createHubspotContact,
      createHubspotDealFromLead,
      draftGmailEmail,
      enrollOutreachSequence,
      updateHubspotDeal,
    ],
    messages: [
      {
        role: 'user',
        content: `Inbound lead: ${email}\n\nProcess it.`,
      },
    ],
  });
  const finalMessage = await runner.runUntilDone();

  // Print Claude's final summary.
  console.log('\n--- Claude summary ---');
  for (const block of finalMessage.content) {
    if (block.type === 'text') {
      console.log(block.text);
    }
  }

  // Token usage for cost visibility.
  const u = finalMessage.usage;
  console.log(
    `\n  tokens: input=${u.input_tokens} output=${u.output_tokens}` +
      (u.cache_read_input_tokens
        ? ` cache_read=${u.cache_read_input_tokens}`
        : '') +
      (u.cache_creation_input_tokens
        ? ` cache_write=${u.cache_creation_input_tokens}`
        : ''),
  );

  console.log('\n   Inspect the run:');
  console.log('     dashboard   http://localhost:3000');
  console.log('     approvals   http://localhost:3000/approvals');
  console.log('     audit       http://localhost:3000/audit\n');
}

main().catch((err) => {
  console.error('\n[demo-agent:claude] fatal:', err);
  process.exit(1);
});

function omitUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
