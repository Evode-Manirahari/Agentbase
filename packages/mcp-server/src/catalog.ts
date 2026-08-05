import { APOLLO_TOOLS } from '@agentbase/connector-apollo';
import { GMAIL_TOOLS } from '@agentbase/connector-gmail';
import { HUBSPOT_TOOLS } from '@agentbase/connector-hubspot';
import { OUTREACH_TOOLS } from '@agentbase/connector-outreach';
import { SALESFORCE_TOOLS } from '@agentbase/connector-salesforce';
import { SHELL_TOOLS } from '@agentbase/connector-shell';

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
  shell: 'shell',
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
  // shell.run is described by hand rather than by the generic template: the
  // agent needs to know the command is graded and may be held for approval,
  // and that compound lines are refused. A tool description an agent
  // misunderstands turns into an approval queue full of retries.
  return [
    ...all.map(entry),
    ...SHELL_TOOLS.map((name) => ({
      name,
      description:
        'Run a single shell command through the Agentbase effect gate. The ' +
        'command is classified by consequence (read / workspace_write / ' +
        'vcs_write / deploy / publish / infra_write / egress) before it runs, ' +
        'and policy may allow it, hold it for human approval, or deny it. ' +
        'Submit ONE command per call — compound lines (`a && b`, `a | b`) are ' +
        'refused so each effect gets its own receipt. Commands containing ' +
        '$(...), backticks, or eval are refused because their contents cannot ' +
        'be classified. Params: { command: string, cwd?: string, timeout_ms?: number }.',
      inputSchema: { type: 'object' as const, additionalProperties: true as const },
    })),
  ];
}

export function isCatalogTool(name: string, catalog: ToolCatalogEntry[]): boolean {
  return catalog.some((t) => t.name === name);
}
