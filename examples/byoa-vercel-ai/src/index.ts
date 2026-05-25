// Bring-your-own-agent example: Vercel AI SDK + Agentbase.
//
// Shows the pattern any third-party AI sales agent should follow:
//   1. Define your tools in your own framework (here: ai-sdk `tool()`).
//   2. Each tool's `execute` calls `agentbase.executeAndWait(...)` instead
//      of hitting the CRM / email vendor directly.
//   3. Agentbase mediates: scoped identity, policy decision, Slack approval
//      for sensitive actions, full audit trail. Your agent never sees the
//      gate logic — it just gets back the connector result (or a denial).
//
// Run:
//   AGENTBASE_API_KEY=agb_... ANTHROPIC_API_KEY=sk-ant-... \
//     pnpm --filter @agentbase/byoa-vercel-ai start [lead-email]

import { anthropic } from '@ai-sdk/anthropic';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import { AgentbaseClient, AgentbaseError } from '@agentbase/sdk';

const agentbaseKey = process.env.AGENTBASE_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

if (!agentbaseKey) {
  console.error('Set AGENTBASE_API_KEY (register an agent at /agents).');
  process.exit(1);
}
if (!anthropicKey) {
  console.error('Set ANTHROPIC_API_KEY (Claude is the agent reasoning model).');
  process.exit(1);
}

const agentbase = new AgentbaseClient({
  apiKey: agentbaseKey,
  ...(process.env.AGENTBASE_BASE_URL
    ? { baseUrl: process.env.AGENTBASE_BASE_URL }
    : {}),
});

const leadEmail = process.argv[2] ?? 'cto@globex.com';

const tools = {
  enrichPerson: tool({
    description: 'Look up a person by email via Apollo.',
    parameters: z.object({ email: z.string().email() }),
    execute: async ({ email }) => runThroughGate('apollo.people.match', { email }),
  }),

  enrichCompany: tool({
    description: 'Look up the company that owns a domain via Apollo.',
    parameters: z.object({ domain: z.string() }),
    execute: async ({ domain }) =>
      runThroughGate('apollo.organizations.match', { domain }),
  }),

  upsertHubspotContact: tool({
    description: 'Create or update a HubSpot contact for a known lead.',
    parameters: z.object({
      email: z.string().email(),
      firstname: z.string().optional(),
      lastname: z.string().optional(),
      company: z.string().optional(),
      jobtitle: z.string().optional(),
    }),
    execute: async (params) =>
      runThroughGate('hubspot.contacts.upsert', params),
  }),

  draftEmail: tool({
    description: 'Draft an outbound email in Gmail (not yet sent).',
    parameters: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
    }),
    execute: async (params) => runThroughGate('gmail.draft.create', params),
  }),

  sendEmail: tool({
    description:
      'Send an external email. Hits the approval-before-external-email policy; pauses for a human ✓ in Slack.',
    parameters: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
    }),
    execute: async (params) => runThroughGate('gmail.send', params),
  }),
} as const;

async function runThroughGate(toolName: string, params: Record<string, unknown>) {
  // executeAndWait blocks on awaiting_approval. For long-running approvals,
  // see the "Long-running approvals" pattern in packages/sdk/README.md.
  const idempotencyKey = `byoa-${toolName}-${JSON.stringify(params)}-${leadEmail}`;
  try {
    const res = await agentbase.executeAndWait(
      { tool: toolName, params, idempotencyKey },
      {
        onPoll: (a) =>
          process.stdout.write(`  [agentbase] ${toolName} ${a.status}\r`),
      },
    );
    process.stdout.write('\n');
    if (res.status === 'denied') {
      const reason =
        (res.policy_decision as { reason?: string } | undefined)?.reason ??
        'no reason given';
      return { ok: false, denied: true, reason };
    }
    if (res.status === 'failed') {
      return { ok: false, denied: false, reason: 'connector failed' };
    }
    return { ok: true, result: res.result };
  } catch (err) {
    if (err instanceof AgentbaseError) {
      return { ok: false, denied: false, reason: err.message };
    }
    throw err;
  }
}

async function main() {
  console.log(`Processing lead ${leadEmail} through Agentbase…\n`);

  const { text, steps } = await generateText({
    model: anthropic('claude-opus-4-7'),
    tools,
    maxSteps: 12,
    system: [
      'You are an AI sales agent processing one inbound lead at a B2B SaaS company.',
      'Every tool call you make runs through Agentbase — an approval gate that',
      'mediates each call against an organization-defined policy. Some calls',
      'auto-execute, some pause for human ✓ in Slack, some are denied. Trust',
      'what the gate returns; do not work around it.',
      '',
      'Playbook:',
      '  1. Enrich the lead (enrichPerson) and their company (enrichCompany).',
      '  2. Upsert the contact in HubSpot (upsertHubspotContact).',
      '  3. Draft a personalized email (draftEmail).',
      '  4. Send the email (sendEmail) — this will pause for human approval.',
      '',
      'One tool per step. Be concise. If the gate denies a call, stop and',
      "summarize what happened — don't retry around the policy.",
    ].join('\n'),
    prompt: `New inbound lead: ${leadEmail}. Run the playbook.`,
  });

  console.log(`\n--- Final summary from agent ---\n${text}\n`);
  console.log(`Completed in ${steps.length} step(s).`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
