// Verify the MCP path OpenClaw will use — without involving OpenClaw.
//
// OpenClaw spawns `pnpm exec agentbase-mcp` over stdio (see
// openclaw-mcp-config.json). This script spawns that exact command with your
// agb_ key, connects an MCP client, asserts the governed connector tools are
// advertised, then calls one gated tool so you can see the `awaiting_approval`
// shape the gate returns under the bundled policy.yaml.
//
// The call below is deliberately the "delusional agent" beat from the README:
// OpenClaw was asked to "follow up with everyone who went quiet this quarter,
// use your judgement," decided a stale deal needed a status change to clean up
// the pipeline, and picked a number. The gate does not care how it got there —
// it only looks at the params on the call in front of it.
//
// If this prints "awaiting_approval" for hubspot_deals_update, the gate is
// live and OpenClaw is safe to wire in. Run:
//
//   AGENTBASE_API_KEY=agb_... pnpm --filter '@agentbase/byoa-openclaw' run verify

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const apiKey = process.env['AGENTBASE_API_KEY'];
if (!apiKey) {
  console.error('AGENTBASE_API_KEY is required. Run ./setup.sh to mint one.');
  process.exit(2);
}
const baseUrl = process.env['AGENTBASE_BASE_URL'] ?? 'http://localhost:3002';

// Spawn the *exact* command the OpenClaw MCP config uses, so this verifies the
// real wiring rather than a bespoke one.
const transport = new StdioClientTransport({
  command: 'pnpm',
  args: ['exec', 'agentbase-mcp'],
  env: {
    ...process.env,
    AGENTBASE_API_KEY: apiKey,
    AGENTBASE_BASE_URL: baseUrl,
  } as Record<string, string>,
});

const client = new Client({ name: 'byoa-openclaw-verify', version: '0.0.0' });

await client.connect(transport);
console.log(`connected (baseUrl=${baseUrl})`);

const tools = await client.listTools();
console.log(`\ntools advertised: ${tools.tools.length}`);

// MCP names use underscores; the gate keeps the dotted form internally.
const expected = [
  'hubspot_deals_update',
  'gmail_send',
  'salesforce_opportunity_create',
  'outreach_sequences_enroll',
];
const advertised = new Set(tools.tools.map((t) => t.name));
const missing = expected.filter((name) => !advertised.has(name));
if (missing.length > 0) {
  console.error(`\n✗ expected governed tools missing: ${missing.join(', ')}`);
  console.error('  is @agentbase/mcp-server built and are connectors imported?');
  process.exit(1);
}
console.log(`✓ governed tools present: ${expected.join(', ')}`);

// hubspot.deals.update over $10k requires approval under policy.yaml — so a
// chat-triggered agent cannot mark a real deal closed-won on its own, no
// matter how it justified the number to itself.
console.log('\ncalling hubspot_deals_update through the gate (expect awaiting_approval)…');
const result = await client.callTool({
  name: 'hubspot_deals_update',
  arguments: {
    deal_id: '4471002',
    properties: { dealstage: 'closedwon', amount: 82000 },
    idempotency_key: `byoa-openclaw-${Date.now()}`,
  },
});

const text = JSON.stringify(result);
if (text.includes('awaiting_approval')) {
  console.log('✓ hubspot_deals_update was gated — the human ✓ is required before it closes.');
} else {
  console.log('⚠ hubspot_deals_update was not gated. Check that policy.yaml is the active policy.');
}

console.log('\n--- raw result ---');
console.log(JSON.stringify(result, null, 2));

await client.close();
