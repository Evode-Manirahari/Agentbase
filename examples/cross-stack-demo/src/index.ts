// Cross-stack reference agent: ONE agent identity, ONE policy file,
// ONE approval queue — governed across HubSpot + Salesforce + Gmail.
//
// This is the worked example for Agentbase's core differentiator: the
// control plane spans the entire revenue stack, not a single vendor.
// Same hot lead lands in both CRMs; the same $25k approval rule fires
// regardless of which one the agent touches.
//
// Run:
//   AGENTBASE_API_KEY=agb_... pnpm --filter @agentbase/cross-stack-demo \
//     exec tsx src/index.ts [email]

import { AgentbaseClient, AgentbaseError } from '@agentbase/sdk';

const apiKey = process.env.AGENTBASE_API_KEY;
const baseUrl = process.env.AGENTBASE_BASE_URL ?? 'http://localhost:3002';

if (!apiKey) {
  console.error(
    'Set AGENTBASE_API_KEY (register an agent via examples/cross-stack-demo/setup.sh)',
  );
  process.exit(1);
}

const agentbase = new AgentbaseClient({ apiKey, baseUrl });

interface AgentbaseStepResult {
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

const STATUS_ICONS: Record<AgentbaseStepResult['status'], string> = {
  pending: '⏳',
  awaiting_approval: '🛂',
  approved: '✅',
  denied: '🚫',
  executed: '✓',
  failed: '✗',
};

async function step(
  label: string,
  body: { tool: string; params: Record<string, unknown> },
): Promise<AgentbaseStepResult | null> {
  const stack = body.tool.split('.')[0]!;
  process.stdout.write(`\n→ [${stack}] ${label}\n  ${body.tool}\n`);
  const start = Date.now();
  try {
    const r = (await agentbase.execute(body)) as unknown as AgentbaseStepResult;
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
    return r;
  } catch (err) {
    const ms = Date.now() - start;
    if (err instanceof AgentbaseError) {
      console.log(`  ✗ HTTP ${err.status} (${ms}ms)`);
      console.log(`  ↳ ${JSON.stringify(err.body).slice(0, 160)}`);
    } else {
      console.log(`  ✗ ${(err as Error).message} (${ms}ms)`);
    }
    return null;
  }
}

async function main() {
  const email = process.argv[2] ?? 'cto@globex.com';
  const domain = email.split('@')[1] ?? 'globex.com';
  const company = domain.split('.')[0]!.replace(/^\w/, (c) => c.toUpperCase());

  console.log(`\n🤖 cross-stack-demo — one agent, one policy, two CRMs`);
  console.log(`   lead:   ${email}`);
  console.log(`   policy: high-value writes ($25k+) → #critical-approvals\n`);

  // 1. Enrich the lead — read-only, both CRMs reuse the same Apollo lookup.
  await step('Enrich the lead', {
    tool: 'apollo.people.match',
    params: { email, reveal_personal_emails: false },
  });

  // 2. Enrich the company.
  await step('Enrich the company', {
    tool: 'apollo.organizations.match',
    params: { domain },
  });

  // 3. Mirror the contact into HubSpot.
  await step('Mirror contact into HubSpot CRM', {
    tool: 'hubspot.contacts.upsert',
    params: {
      email,
      properties: {
        email,
        company,
        lifecyclestage: 'salesqualifiedlead',
      },
    },
  });

  // 4. Mirror the same contact into Salesforce.
  // Same lead, second CRM — proves cross-stack identity.
  await step('Mirror contact into Salesforce CRM', {
    tool: 'salesforce.contact.create',
    params: {
      fields: {
        Email: email,
        LastName: email.split('@')[0],
        Description: 'Sourced via cross-stack-demo agent',
      },
    },
  });

  // 5. Open a small Salesforce opportunity — under the $25k threshold,
  //    auto-allows.
  await step('Open small Salesforce opportunity ($8k)', {
    tool: 'salesforce.opportunity.create',
    params: {
      fields: {
        Name: `${company} — pilot`,
        Amount: 8000,
        StageName: 'Prospecting',
        CloseDate: closeDate(45),
      },
    },
  });

  // 6. Open a high-value Salesforce opportunity — $80k. This should match
  //    the cross-stack $25k+ rule and require approval, routed to Slack.
  await step('Open high-value Salesforce opportunity ($80k) — gated', {
    tool: 'salesforce.opportunity.create',
    params: {
      fields: {
        Name: `${company} — enterprise expansion`,
        Amount: 80000,
        StageName: 'Proposal/Price Quote',
        CloseDate: closeDate(60),
      },
    },
  });

  // 7. Draft the personalized outreach email — drafts are safe.
  await step('Draft outreach email in Gmail', {
    tool: 'gmail.draft.create',
    params: {
      to: email,
      subject: `Re: scaling agents at ${company}`,
      body: [
        `Hi,`,
        ``,
        `Noticed ${company} is rolling out AI sales agents. Agentbase is the`,
        `control plane that governs them — one policy file, every CRM,`,
        `every action audited.`,
        ``,
        `Worth 20 min next week?`,
        ``,
        `— cross-stack-demo`,
      ].join('\n'),
    },
  });

  // 8. Update a HubSpot deal to a high amount — same $25k+ rule fires,
  //    but on the *other* CRM. Same approval queue, same Slack channel.
  await step('Bump HubSpot deal to $60k — gated', {
    tool: 'hubspot.deals.update',
    params: {
      dealId: 'deal-cross-stack-001',
      properties: { amount: 60000, dealstage: 'contractsent' },
    },
  });

  console.log('\n🤖 cross-stack-demo — done.\n');
  console.log('   What just happened:');
  console.log('   · one agent identity issued the writes to BOTH CRMs');
  console.log('   · one policy.yaml governed every call');
  console.log('   · both high-value steps (#6 and #8) routed to the same queue');
  console.log('');
  console.log('   Inspect the run:');
  console.log('     dashboard   http://localhost:3000');
  console.log('     approvals   http://localhost:3000/approvals');
  console.log('     audit       http://localhost:3000/audit\n');
}

function closeDate(daysAhead: number): string {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error('\n[cross-stack-demo] fatal:', err);
  process.exit(1);
});
