import type { Job } from '../job.js';

// The first job. An AI SDR processing a single inbound lead.
//
// The agent has access to:
//   - Apollo enrichment (allow under most policies — read-only)
//   - HubSpot contact upsert (allow under most policies)
//   - Gmail draft creation (allow — no email leaves the outbox)
//   - Gmail send (REQUIRE_APPROVAL under the
//     `approval-before-external-email` template — the agent will see the
//     run pause here, and a human approves via Slack or the web inbox)
//
// What it does NOT have: any tool that updates revenue records, enrolls
// in sequences, or alters deal data. Those are expansion-job concerns.

const SYSTEM_PROMPT = `You are an AI SDR processing a single inbound lead at a B2B SaaS company.

Every action you take goes through Dejavas — an approval gate that mediates each tool call against an organization-defined policy. Some actions auto-execute, some pause for human approval in Slack, some are denied. Trust the policy: it exists to keep the agent safe to run in production.

For each lead, work through this playbook:
1. Enrich the lead (apollo.people.match) and their company (apollo.organizations.match).
2. Upsert the contact in HubSpot CRM (hubspot.contacts.upsert) with the lead's role, company, and industry from the enrichment results.
3. Draft a short, specific, personalized outreach email (gmail.draft.create) that references one concrete detail from the enrichment — the company's recent funding round, the prospect's job title shift, their tech stack, anything that proves you read about them. Don't write generic "I noticed your company is growing" filler. The subject line should be under 50 characters and not look like marketing copy.
4. Send the email (gmail.send). This will require human approval — that's expected. Note it and continue.

When a tool returns:
- status "executed" → the action ran. Continue.
- status "failed" with connector_not_configured → credentials aren't set up; treat as a soft success for the demo and continue.
- status "awaiting_approval" → the action is paused for a human. Don't retry. The run will halt here and resume after the human approves.
- status "denied" → blocked by policy. Don't work around it. Continue with the next step.

Be concise in your reasoning. The user is watching a live trace; long monologues hurt readability. When you're done, produce a one-paragraph summary of what happened and what needs human attention.`;

export const AI_SDR_OUTBOUND_JOB: Job = {
  key: 'ai-sdr-outbound',
  label: 'AI SDR — outbound',
  description:
    'Enrich one inbound lead, upsert in CRM, draft and send a personalized outreach email through the approval gate.',
  model: 'claude-opus-4-7',
  maxIterations: 16,
  systemPrompt: SYSTEM_PROMPT,
  buildInitialMessage: (context) => {
    const email = stringField(context, 'email');
    const notes = stringField(context, 'notes');
    const lines = [
      'Inbound lead to process:',
      `  email: ${email ?? '(missing)'}`,
    ];
    if (notes) lines.push(`  notes: ${notes}`);
    lines.push('', 'Work through the playbook.');
    return lines.join('\n');
  },
  tools: [
    {
      name: 'enrich_person',
      description:
        'Look up a person by email via Apollo enrichment. Returns title, company, LinkedIn, location.',
      inputSchema: {
        type: 'object',
        properties: {
          email: {
            type: 'string',
            description: "The lead's email address",
          },
        },
        required: ['email'],
      },
      dejavasTool: 'apollo.people.match',
    },
    {
      name: 'enrich_company',
      description:
        'Look up a company by domain via Apollo. Returns industry, size, funding, headcount.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            description: 'Company domain, e.g. acme.com',
          },
        },
        required: ['domain'],
      },
      dejavasTool: 'apollo.organizations.match',
    },
    {
      name: 'upsert_hubspot_contact',
      description:
        'Create or update a contact in HubSpot by email. Sets lifecyclestage to salesqualifiedlead by default.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          firstname: { type: 'string' },
          lastname: { type: 'string' },
          company: { type: 'string' },
          jobtitle: { type: 'string' },
        },
        required: ['email'],
      },
      dejavasTool: 'hubspot.contacts.upsert',
      paramMapper: (input) => {
        const { email, ...rest } = input as Record<string, string | undefined>;
        const properties: Record<string, unknown> = {
          email,
          lifecyclestage: 'salesqualifiedlead',
        };
        for (const [k, v] of Object.entries(rest)) {
          if (typeof v === 'string' && v.length > 0) properties[k] = v;
        }
        return { email, properties };
      },
    },
    {
      name: 'draft_outreach_email',
      description:
        'Create a draft email in Gmail. The draft is NOT sent — a human (or the agent in a later step) sends it via gmail.send, which is approval-gated.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: {
            type: 'string',
            description: 'Subject line, under 50 characters, no marketing tone',
          },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
      dejavasTool: 'gmail.draft.create',
    },
    {
      name: 'send_outreach_email',
      description:
        'Send an email via Gmail. This is approval-gated by default — expect the run to pause here for human review.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
      dejavasTool: 'gmail.send',
    },
  ],
};

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
