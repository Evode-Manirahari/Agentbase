// Claude-driven variant of the cross-stack demo.
//
// Same goal as src/index.ts — mirror the lead across HubSpot AND Salesforce,
// draft the email in Gmail, exercise the cross-stack $25k+ approval rule —
// but Claude chooses the ordering and shape of the calls. Every tool the
// model invokes still goes through Agentbase, so policy mediation is
// identical.
//
// Run:
//   ANTHROPIC_API_KEY=sk-ant-... AGENTBASE_API_KEY=agb_... \
//     pnpm --filter @agentbase/cross-stack-demo run start:claude [email]

import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { AgentbaseClient } from '@agentbase/sdk';

const agentbaseKey = process.env.AGENTBASE_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

if (!agentbaseKey) {
  console.error(
    'Set AGENTBASE_API_KEY (run examples/cross-stack-demo/setup.sh first)',
  );
  process.exit(1);
}
if (!anthropicKey) {
  console.error(
    'Set ANTHROPIC_API_KEY (the hard-coded variant src/index.ts works without one)',
  );
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
  const stack = tool.split('.')[0]!;
  process.stdout.write(`\n→ [${stack}] ${label}\n  ${tool}\n`);
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
  return JSON.stringify({
    action_id: r.action_id,
    status: r.status,
    policy: r.policy_decision,
    result: r.result,
  });
}

// ── Tool definitions ────────────────────────────────────────────────────────
// One thin wrapper per Agentbase tool the model is allowed to call. Note both
// HubSpot AND Salesforce surfaces are exposed — that's the cross-stack point.

const enrichPerson = betaZodTool({
  name: 'enrich_person',
  description: 'Look up a person by email via Apollo. Read-only enrichment.',
  inputSchema: z.object({ email: z.string().email() }),
  run: async ({ email }) =>
    callAgentbase('Enrich the lead', 'apollo.people.match', { email }),
});

const enrichCompany = betaZodTool({
  name: 'enrich_company',
  description: 'Look up a company by domain via Apollo. Read-only enrichment.',
  inputSchema: z.object({ domain: z.string().min(1) }),
  run: async ({ domain }) =>
    callAgentbase('Enrich the company', 'apollo.organizations.match', { domain }),
});

const upsertHubspotContact = betaZodTool({
  name: 'upsert_hubspot_contact',
  description: 'Create or update a contact in HubSpot by email.',
  inputSchema: z.object({
    email: z.string().email(),
    company: z.string().optional(),
    firstname: z.string().optional(),
    lastname: z.string().optional(),
  }),
  run: async ({ email, company, firstname, lastname }) => {
    const properties: Record<string, unknown> = {
      email,
      lifecyclestage: 'salesqualifiedlead',
    };
    if (company) properties.company = company;
    if (firstname) properties.firstname = firstname;
    if (lastname) properties.lastname = lastname;
    return callAgentbase(
      'Mirror contact into HubSpot CRM',
      'hubspot.contacts.upsert',
      { email, properties },
    );
  },
});

const createSalesforceContact = betaZodTool({
  name: 'create_salesforce_contact',
  description: 'Create a contact in Salesforce mirroring the HubSpot record.',
  inputSchema: z.object({
    email: z.string().email(),
    lastName: z.string().min(1),
    firstName: z.string().optional(),
    description: z.string().optional(),
  }),
  run: async ({ email, lastName, firstName, description }) => {
    const fields: Record<string, unknown> = { Email: email, LastName: lastName };
    if (firstName) fields.FirstName = firstName;
    if (description) fields.Description = description;
    return callAgentbase(
      'Mirror contact into Salesforce CRM',
      'salesforce.contact.create',
      { fields },
    );
  },
});

const createSalesforceOpportunity = betaZodTool({
  name: 'create_salesforce_opportunity',
  description:
    'Create a Salesforce opportunity. Amounts at or above $25k will be gated by the cross-stack approval rule.',
  inputSchema: z.object({
    name: z.string().min(1),
    amount: z.number().nonnegative(),
    stage: z.string().min(1),
    closeDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
      .describe('Expected close date, YYYY-MM-DD'),
  }),
  run: async ({ name, amount, stage, closeDate }) =>
    callAgentbase(
      `Open Salesforce opportunity ($${amount.toLocaleString()})`,
      'salesforce.opportunity.create',
      {
        fields: { Name: name, Amount: amount, StageName: stage, CloseDate: closeDate },
      },
    ),
});

const updateHubspotDeal = betaZodTool({
  name: 'update_hubspot_deal',
  description:
    'Update a HubSpot deal — amount, stage, etc. Amounts at or above $25k will be gated by the cross-stack approval rule.',
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
      `Update HubSpot deal${amount !== undefined ? ` ($${amount.toLocaleString()})` : ''}`,
      'hubspot.deals.update',
      { dealId, properties },
    );
  },
});

const draftGmailEmail = betaZodTool({
  name: 'draft_gmail_email',
  description:
    'Create a draft email in Gmail. Drafts are safe — sends require approval.',
  inputSchema: z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  run: async ({ to, subject, body }) =>
    callAgentbase('Draft outreach email in Gmail', 'gmail.draft.create', {
      to,
      subject,
      body,
    }),
});

const SYSTEM_PROMPT = `You are a sales-development agent at a B2B startup.

Your defining trait: you keep BOTH the HubSpot CRM and the Salesforce CRM in sync for every lead. The org runs both systems and RevOps doesn't want a primary — both must reflect reality.

Every action you take goes through Agentbase, a control-plane that mediates each call against an organization-defined policy. The policy is the same one across HubSpot and Salesforce: writes at $25k or above need human approval, no exceptions.

When a tool returns:
- "executed" or "failed" with connector_not_configured → the call ran (or would have, given credentials). Continue.
- "awaiting_approval" → the action is paused for a human. Don't retry. Move on; humans will approve in Slack.
- "denied" → blocked by policy. Don't work around it.

Playbook for each inbound lead:
1. Enrich the person and the company via Apollo.
2. Mirror the contact into HubSpot.
3. Mirror the same contact into Salesforce.
4. Open a Salesforce opportunity at the deal size you can justify from enrichment. If the prospect is enterprise-sized (>100 headcount or Fortune 1000), size the opportunity at $50k+ — this will trigger the cross-stack approval gate, which is exactly what you want.
5. Draft a personalized outreach email in Gmail (drafts are safe).
6. If you have a separate HubSpot deal to update with a high amount, do so — same $25k+ gate, same approval queue, just on the other CRM.

Produce a short summary at the end: what executed, what awaits approval, and what RevOps needs to do next.

Be concise — the user is watching a live trace.`;

async function main() {
  const email = process.argv[2] ?? 'cto@globex.com';

  console.log(`\n🤖 cross-stack-demo (Claude-driven) — one agent, one policy, two CRMs`);
  console.log(`   lead:  ${email}`);
  console.log(`   model: claude-opus-4-7 · effort: xhigh · adaptive thinking\n`);

  const runner = anthropic.beta.messages.toolRunner({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh' },
    tools: [
      enrichPerson,
      enrichCompany,
      upsertHubspotContact,
      createSalesforceContact,
      createSalesforceOpportunity,
      updateHubspotDeal,
      draftGmailEmail,
    ],
    messages: [
      {
        role: 'user',
        content: `Inbound lead: ${email}\n\nProcess it. Keep both CRMs in sync.`,
      },
    ],
  });
  const finalMessage = await runner.runUntilDone();

  console.log('\n--- Claude summary ---');
  for (const block of finalMessage.content) {
    if (block.type === 'text') {
      console.log(block.text);
    }
  }

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
  console.error('\n[cross-stack-demo:claude] fatal:', err);
  process.exit(1);
});
