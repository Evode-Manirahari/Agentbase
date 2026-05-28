// End-to-end smoke test for @agentbase/mcp-server.
//
// Spawns the MCP server in a child process (stdio), connects an MCP client,
// asks for the tool list, then calls one tool through Agentbase. Prints
// what the agent sees — including the awaiting_approval shape if the
// gate policy gates the call.
//
// Run: AGENTBASE_API_KEY=agb_... pnpm --filter '@agentbase/byoa-mcp' run start
//
// This is the "does the protocol actually wire up" test. For a real
// integration, drop the same config into Claude Desktop's
// claude_desktop_config.json (see ../README.md).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const apiKey = process.env['AGENTBASE_API_KEY'];
if (!apiKey) {
  console.error('AGENTBASE_API_KEY is required. Get one from the /agents page.');
  process.exit(2);
}
const baseUrl = process.env['AGENTBASE_BASE_URL'] ?? 'http://localhost:3002';

const transport = new StdioClientTransport({
  command: 'pnpm',
  args: ['--filter', '@agentbase/mcp-server', '--silent', 'run', 'start'],
  env: {
    ...process.env,
    AGENTBASE_API_KEY: apiKey,
    AGENTBASE_BASE_URL: baseUrl,
  } as Record<string, string>,
});

const client = new Client({ name: 'byoa-mcp-example', version: '0.0.0' });

await client.connect(transport);
console.log(`connected (baseUrl=${baseUrl})`);

const tools = await client.listTools();
console.log(`\ntools advertised: ${tools.tools.length}`);
const sample = tools.tools.slice(0, 5).map((t) => t.name);
console.log(`first 5: ${sample.join(', ')}`);

// MCP tool names use underscores (the dot-separated gate name
// `hubspot.contacts.upsert` is encoded by the MCP server before being
// advertised — see packages/mcp-server/src/server.ts).
const targetTool = 'hubspot_contacts_upsert';
const hasTool = tools.tools.some((t) => t.name === targetTool);
if (!hasTool) {
  console.error(`expected ${targetTool} in tool list — connector imports broken?`);
  process.exit(1);
}

console.log(`\ncalling ${targetTool} through the gate…`);
const result = await client.callTool({
  name: targetTool,
  arguments: {
    email: 'cto@globex.com',
    firstname: 'Lina',
    lastname: 'Cho',
    idempotency_key: `byoa-mcp-${Date.now()}`,
  },
});

console.log('\n--- result ---');
console.log(JSON.stringify(result, null, 2));

await client.close();
