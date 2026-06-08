// Verify the MCP path a Hermes Agent will use — without involving Hermes.
//
// Hermes spawns `pnpm exec agentbase-mcp` over stdio (see hermes-mcp-config.yaml).
// This script spawns that exact command with your agb_ key, connects an MCP
// client, asserts the governed connector tools are advertised, then calls one
// gated tool so you can see the `awaiting_approval` shape the gate returns under
// the bundled policy.yaml.
//
// If this prints "awaiting_approval" for gmail_send, the gate is live and Hermes
// is safe to wire in. Run:
//
//   AGENTBASE_API_KEY=agb_... pnpm --filter '@agentbase/byoa-hermes' run verify

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const apiKey = process.env['AGENTBASE_API_KEY'];
if (!apiKey) {
  console.error('AGENTBASE_API_KEY is required. Run ./setup.sh to mint one.');
  process.exit(2);
}
const baseUrl = process.env['AGENTBASE_BASE_URL'] ?? 'http://localhost:3002';

// Spawn the *exact* command the Hermes MCP config uses, so this verifies the
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

const client = new Client({ name: 'byoa-hermes-verify', version: '0.0.0' });

await client.connect(transport);
console.log(`connected (baseUrl=${baseUrl})`);

const tools = await client.listTools();
console.log(`\ntools advertised: ${tools.tools.length}`);

// MCP names use underscores; the gate keeps the dotted form internally.
const expected = [
  'hubspot_contacts_upsert',
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

// gmail.send is require_approval under policy.yaml — so a self-improving agent
// can never email the world on its own. This call should come back gated.
console.log('\ncalling gmail_send through the gate (expect awaiting_approval)…');
const result = await client.callTool({
  name: 'gmail_send',
  arguments: {
    to: 'cto@globex.com',
    subject: 'Intro',
    body: 'Hello from a governed Hermes agent.',
    idempotency_key: `byoa-hermes-${Date.now()}`,
  },
});

const text = JSON.stringify(result);
if (text.includes('awaiting_approval')) {
  console.log('✓ gmail_send was gated — the human ✓ is required before it sends.');
} else {
  console.log('⚠ gmail_send was not gated. Check that policy.yaml is the active policy.');
}

console.log('\n--- raw result ---');
console.log(JSON.stringify(result, null, 2));

await client.close();
