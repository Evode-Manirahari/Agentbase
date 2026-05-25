import type { Job } from '../job.js';

// The second job. AI CRM hygiene — scan a list of HubSpot contacts,
// identify missing or stale fields (jobtitle, company, lifecyclestage),
// enrich via Apollo, and fill the gaps.
//
// Architectural point of this job: it proves the bundle's expansion
// thesis. Same runtime, same secure action layer, same audit log — adding a
// "job" is data + prompts, not a new product. Future jobs (deal-update
// v1.2, lead routing, etc.) plug in the same way.
//
// Demo character: the SDR job's wow moment is the human-approval pause
// on gmail.send. The hygiene job's wow moment is volume — N contacts in,
// N audit rows out, each one with the source enrichment. The pitch is
// different ("save RevOps hours"), but the safety story is identical:
// every action is policy-evaluated and audit-logged, bulk operations
// are denied by the deny-destructive-and-bulk template.

const SYSTEM_PROMPT = `You are an AI CRM hygiene agent. Your job is to clean up a small set of HubSpot contacts by filling in missing or obviously-stale fields using Apollo enrichment.

Every action you take goes through Agentbase — a secure action layer that mediates each tool call against an organization-defined policy. Bulk operations are denied by default; the user has scoped this run to one contact at a time. Trust the policy.

For each contact in the input list:
1. Find the contact in HubSpot (hubspot.contacts.search by email).
2. Inspect what's missing or empty: firstname, lastname, jobtitle, company. (Don't touch fields that already have a value — never overwrite.)
3. If anything is missing, enrich the person via Apollo (apollo.people.match).
4. Update the HubSpot contact with the enriched fields (hubspot.contacts.update). Only include fields that were missing — do not overwrite existing values.
5. Move on to the next contact.

When a tool returns:
- "executed" → continue with the next step.
- "failed" with connector_not_configured → credentials aren't set up; note it and skip this contact rather than retrying.
- "awaiting_approval" → an action was unexpectedly gated; note it and continue. Don't retry.
- "denied" → blocked by policy; respect it and move on.

When you're done with the entire input list, produce a one-paragraph summary: how many contacts you processed, how many fields you filled, what couldn't be enriched, and which (if any) actions need human review.

Be concise. The user is watching a live trace; long monologues hurt readability.`;

export const AI_CRM_HYGIENE_JOB: Job = {
  key: 'ai-crm-hygiene',
  label: 'AI CRM hygiene',
  description:
    'Scan a small set of HubSpot contacts, enrich missing fields (jobtitle, company, etc.) via Apollo, and fill gaps without overwriting existing values.',
  model: 'claude-opus-4-7',
  // Higher max iterations than SDR because the agent walks a list — one
  // contact uses ~3 tool calls (find + enrich + update). 24 iters lets
  // it process ~8 contacts before hitting the cap, which matches the
  // small-batch hygiene use case.
  maxIterations: 24,
  systemPrompt: SYSTEM_PROMPT,
  buildInitialMessage: (context) => {
    const emails = Array.isArray(context['contact_emails'])
      ? (context['contact_emails'] as unknown[]).filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        )
      : [];
    const notes = stringField(context, 'notes');
    const lines = ['CRM hygiene batch:'];
    if (emails.length === 0) {
      lines.push('  (no contacts provided)');
    } else {
      for (const email of emails) lines.push(`  - ${email}`);
    }
    if (notes) {
      lines.push('', `Operator notes: ${notes}`);
    }
    lines.push(
      '',
      'Work through the list one contact at a time. Stop when the list is exhausted.',
    );
    return lines.join('\n');
  },
  tools: [
    {
      name: 'find_hubspot_contact',
      description:
        'Find a HubSpot contact by email. Returns the contact id and current property values so you can see what is missing before enriching.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Contact email address' },
        },
        required: ['email'],
      },
      agentbaseTool: 'hubspot.contacts.search',
      paramMapper: (input) => ({
        // The HubSpot search connector expects a structured filter shape;
        // we wrap the email lookup so the LLM doesn't have to know.
        filters: [{ propertyName: 'email', operator: 'EQ', value: input['email'] }],
        limit: 1,
      }),
    },
    {
      name: 'enrich_person',
      description:
        'Look up a person by email via Apollo enrichment. Returns title, company, LinkedIn, location, etc. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: "The contact's email address" },
        },
        required: ['email'],
      },
      agentbaseTool: 'apollo.people.match',
    },
    {
      name: 'fill_missing_contact_fields',
      description:
        'Update a HubSpot contact with enriched fields. Pass ONLY the fields you want to set — do not include fields that already have a value. The connector overlays these on top of the existing properties.',
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
      agentbaseTool: 'hubspot.contacts.update',
      paramMapper: (input) => {
        const { email, ...rest } = input as Record<string, string | undefined>;
        const properties: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rest)) {
          if (typeof v === 'string' && v.length > 0) properties[k] = v;
        }
        return { email, properties };
      },
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
