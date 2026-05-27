#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGateClient } from './gate-client.js';
import { createAgentbaseMcpServer } from './server.js';

const PKG_VERSION = '0.1.0';

function envOrDie(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    process.stderr.write(
      `[agentbase-mcp] ${name} is required. ` +
        `Set it in your MCP client config (e.g. Claude Desktop mcpServers.<name>.env).\n`,
    );
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const apiKey = envOrDie('AGENTBASE_API_KEY');
  const baseUrl = process.env['AGENTBASE_BASE_URL'];

  const gate = createGateClient({
    apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });

  const server = createAgentbaseMcpServer({
    gate,
    name: 'agentbase-mcp',
    version: PKG_VERSION,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[agentbase-mcp] connected over stdio (baseUrl=${baseUrl ?? 'default'})\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[agentbase-mcp] fatal: ${msg}\n`);
  process.exit(1);
});
