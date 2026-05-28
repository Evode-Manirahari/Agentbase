# byoa-mcp — MCP integration example

Bring your own MCP-aware agent (Claude Desktop, Cursor, Codex, Claude Code, or any MCP client) and route every tool call through Agentbase's policy + identity + approval + audit layer.

For the SDK-based equivalent (LangChain / Vercel AI / Mastra / raw Anthropic), see [`../byoa-vercel-ai`](../byoa-vercel-ai).

## What this example does

`src/index.ts` is a 50-line smoke test that:

1. Spawns [`@agentbase/mcp-server`](../../packages/mcp-server) as a child process over stdio.
2. Connects an MCP client to it.
3. Lists the tools the server advertises (HubSpot + Salesforce + Gmail + Outreach + Apollo, ~60 tools).
4. Calls `hubspot_contacts_upsert` through the gate (MCP-encoded form of the gate-side `hubspot.contacts.upsert`).
5. Prints the result the agent would see — including the `awaiting_approval` shape if your policy gates the call.

It exists so you can verify the full MCP path works before wiring it into a real client.

## Run the smoke test

Make sure Agentbase is running locally (`docker compose -f infra/docker-compose.full.yml up --build` from the repo root). Then grab an `agb_…` key from the [/agents page](http://localhost:3000/agents).

```bash
AGENTBASE_API_KEY=agb_... pnpm --filter '@agentbase/byoa-mcp' run start
```

Expected output:

```
connected (baseUrl=http://localhost:3002)

tools advertised: 60
first 5: apollo_people_search, apollo_people_enrich, gmail_send, gmail_threads_get, hubspot_contacts_create

calling hubspot_contacts_upsert through the gate…

--- result ---
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"action_id\": \"...\",\n  \"status\": \"executed\",\n  \"result\": { \"id\": \"hs-...\" }\n}"
    }
  ],
  "isError": false
}
```

If your policy requires approval for `hubspot.contacts.upsert` (note: policy files still use the dotted gate-side names), you'll see `"status": "awaiting_approval"` along with `"poll_tool": "agentbase_get_action_status"` — the agent should remember the `action_id` and either move on or poll.

## Wire it into Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentbase": {
      "command": "pnpm",
      "args": ["--filter", "@agentbase/mcp-server", "--silent", "run", "start"],
      "cwd": "/absolute/path/to/Agentbase",
      "env": {
        "AGENTBASE_API_KEY": "agb_...",
        "AGENTBASE_BASE_URL": "http://localhost:3002"
      }
    }
  }
}
```

A copy lives in [`claude-desktop-config.json`](./claude-desktop-config.json) for paste-and-edit convenience.

Restart Claude Desktop. The Agentbase tools will appear under the `agentbase` server with underscore-encoded names (`hubspot_contacts_upsert`, `salesforce_opportunity_create`, …). Ask Claude something like *"Add Lina Cho (cto@globex.com) to HubSpot."* Claude calls `hubspot_contacts_upsert` via MCP, the server translates it to `hubspot.contacts.upsert` and routes it through the Agentbase gate, the gate applies your policy, and the action lands in the audit log (and the approval queue if your policy gates it).

Swap the `AGENTBASE_API_KEY` to a different `agb_…` token to change which agent identity Claude Desktop acts as. One server instance = one identity.

## Cross-stack version

The [`examples/cross-stack-demo`](../cross-stack-demo) example demonstrates the same policy file governing actions across **both** HubSpot and Salesforce. Once that demo runs, swap its SDK calls for an MCP client and you have the "Claude Desktop → Agentbase → two CRMs governed by one policy" story for buyer demos.
