// Reference agent that exercises five connectors through @dejavas/sdk in
// the typical "inbound lead" flow. Prints the policy decision + outcome
// for each step so you can see exactly where Dejavas mediates.
//
// Run:
//   DEJAVAS_API_KEY=dvk_... pnpm --filter @dejavas/demo-agent exec tsx src/index.ts [email]

import { DejavasClient, DejavasError } from '@dejavas/sdk';

const apiKey = process.env.DEJAVAS_API_KEY;
const baseUrl = process.env.DEJAVAS_BASE_URL ?? 'http://localhost:3002';

if (!apiKey) {
  console.error('Set DEJAVAS_API_KEY (register an agent via examples/demo-agent/setup.sh)');
  process.exit(1);
}

const dejavas = new DejavasClient({ apiKey, baseUrl });

interface DejavasStepResult {
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

const STATUS_ICONS: Record<DejavasStepResult['status'], string> = {
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
): Promise<DejavasStepResult | null> {
  process.stdout.write(`\n→ ${label}\n  ${body.tool}\n`);
  const start = Date.now();
  try {
    const r = (await dejavas.execute(body)) as unknown as DejavasStepResult;
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
    if (err instanceof DejavasError) {
      console.log(`  ✗ HTTP ${err.status} (${ms}ms)`);
      console.log(`  ↳ ${JSON.stringify(err.body).slice(0, 160)}`);
    } else {
      console.log(`  ✗ ${(err as Error).message} (${ms}ms)`);
    }
    return null;
  }
}

async function main() {
  const email = process.argv[2] ?? 'demo-lead@acme.com';
  const domain = email.split('@')[1] ?? 'acme.com';

  console.log(`\n🤖 demo-agent — processing inbound lead\n   ${email}`);
  console.log(`   (every action is mediated by Dejavas)\n`);

  // 1. Enrich the person via Apollo (low-stakes read; should auto-allow)
  await step('Enrich the lead via Apollo', {
    tool: 'apollo.people.match',
    params: { email, reveal_personal_emails: false },
  });

  // 2. Enrich the company
  await step('Enrich the company via Apollo', {
    tool: 'apollo.organizations.match',
    params: { domain },
  });

  // 3. Write the contact to HubSpot CRM (write, but typically allowed)
  await step('Create the contact in HubSpot CRM', {
    tool: 'hubspot.contacts.create',
    params: {
      properties: {
        email,
        lifecyclestage: 'salesqualifiedlead',
      },
    },
  });

  // 4. Draft a personalized email in Gmail (allowed; never sent without approval)
  await step('Draft a personalized outreach email in Gmail', {
    tool: 'gmail.draft.create',
    params: {
      to: email,
      subject: 'Re: your sales-agent stack',
      body: [
        `Hi,`,
        ``,
        `Saw you're at ${domain} and noticed you're deploying AI sales agents.`,
        `We're building Dejavas — Okta + Zapier + Datadog for AI sales agents.`,
        `Worth 15 min next week?`,
        ``,
        `— demo-agent`,
      ].join('\n'),
    },
  });

  // 5. Enroll in an Outreach sequence (could match a require_approval rule)
  await step('Enroll the prospect in an Outreach sequence', {
    tool: 'outreach.sequences.enroll',
    params: {
      prospectId: 'prospect-123',
      sequenceId: 'sequence-vip-456',
      mailboxId: 'mailbox-789',
    },
  });

  // 6. Update a high-value deal — designed to trigger require_approval if the
  // policy installed by setup.sh is active.
  await step('Update high-value deal in HubSpot ($75k)', {
    tool: 'hubspot.deals.update',
    params: {
      dealId: 'deal-100',
      properties: { amount: 75000, dealstage: 'closedwon' },
    },
  });

  console.log('\n🤖 demo-agent — done.\n');
  console.log('   Inspect the run:');
  console.log('     dashboard   http://localhost:3000');
  console.log('     approvals   http://localhost:3000/approvals');
  console.log('     audit       http://localhost:3000/audit\n');
}

main().catch((err) => {
  console.error('\n[demo-agent] fatal:', err);
  process.exit(1);
});
