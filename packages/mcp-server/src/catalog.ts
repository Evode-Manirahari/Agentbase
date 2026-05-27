import { APOLLO_TOOLS } from '@agentbase/connector-apollo';
import { GMAIL_TOOLS } from '@agentbase/connector-gmail';
import { HUBSPOT_TOOLS } from '@agentbase/connector-hubspot';
import { OUTREACH_TOOLS } from '@agentbase/connector-outreach';
import { SALESFORCE_TOOLS } from '@agentbase/connector-salesforce';

export interface ToolCatalogEntry {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    additionalProperties: true;
  };
}

const PROVIDER_LABEL: Record<string, string> = {
  apollo: 'Apollo',
  gmail: 'Gmail',
  hubspot: 'HubSpot',
  outreach: 'Outreach',
  salesforce: 'Salesforce',
};

function describe(toolName: string): string {
  const [provider, ...rest] = toolName.split('.');
  const label = (provider && PROVIDER_LABEL[provider]) ?? provider ?? 'connector';
  const action = rest.join('.');
  return `Run ${label} action \`${action}\` through the Agentbase action gate. ` +
    `Policy, identity, and audit are enforced server-side. Params shape is ` +
    `provider-specific; pass the same fields you would to the ${label} API.`;
}

function entry(name: string): ToolCatalogEntry {
  return {
    name,
    description: describe(name),
    // v1 alpha: connector packages don't yet export JSON Schemas for tool
    // params (they keep them as private Zod schemas inside REQUEST_TOOLS).
    // The Agentbase gate validates params server-side and surfaces a
    // structured error on mismatch, so a permissive schema here lets the
    // MCP client send whatever the connector expects without us duplicating
    // every connector's input shape. Tightening this is the v2 job.
    inputSchema: { type: 'object', additionalProperties: true },
  };
}

export function buildCatalog(): ToolCatalogEntry[] {
  const all = [
    ...APOLLO_TOOLS,
    ...GMAIL_TOOLS,
    ...HUBSPOT_TOOLS,
    ...OUTREACH_TOOLS,
    ...SALESFORCE_TOOLS,
  ];
  return all.map(entry);
}

export function isCatalogTool(name: string, catalog: ToolCatalogEntry[]): boolean {
  return catalog.some((t) => t.name === name);
}
