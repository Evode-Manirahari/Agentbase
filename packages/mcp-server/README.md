# @agentbase/mcp-server

Expose the [Agentbase](https://github.com/Evode-Manirahari/Agentbase) action gate as a [Model Context Protocol](https://modelcontextprotocol.io) server. Drop the server's URL into any MCP-aware client — Claude Desktop, Cursor, Codex, Claude Code, MCP-Inspector — and every tool call to HubSpot, Salesforce, Gmail, Outreach, or Apollo is now routed through Agentbase's policy, identity, approval, and audit layer.

> Agentbase is the secure action layer for AI sales agents. This package is the **protocol-level** integration; the [`@agentbase/sdk`](../sdk) package is the code-level integration. Same gate behind both.

## When to use this vs. the SDK

| You have…                                                | Use                         |
| -------------------------------------------------------- | --------------------------- |
| Your own agent code (LangChain, CrewAI, Vercel AI, etc.) | [`@agentbase/sdk`](../sdk)  |
| A protocol-first MCP client (Claude Desktop, Cursor)     | this package                |
| Both                                                     | both                        |

## Install + run

```bash
pnpm add @agentbase/mcp-server
```

Start the server (stdio transport, the default for desktop MCP clients):

```bash
AGENTBASE_API_KEY=agb_... \
AGENTBASE_BASE_URL=http://localhost:3002 \
pnpm exec agentbase-mcp
```

`AGENTBASE_API_KEY` is the `agb_…` key for the agent identity you want the MCP client to act as. Grab one from the Agentbase web UI's `/agents` page. `AGENTBASE_BASE_URL` defaults to `http://localhost:3002`.

## Wire it into Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentbase": {
      "command": "pnpm",
      "args": ["exec", "agentbase-mcp"],
      "env": {
        "AGENTBASE_API_KEY": "agb_...",
        "AGENTBASE_BASE_URL": "http://localhost:3002"
      }
    }
  }
}
```

Restart Claude Desktop. The Agentbase tools (`hubspot_contacts_upsert`, `salesforce_opportunity_create`, etc.) will appear under the agentbase server. Every call routes through your local Agentbase gate.

> **Tool name encoding.** MCP requires tool names match `^[a-zA-Z0-9_-]{1,64}$`. Agentbase gate-side tool names are dot-separated (`hubspot.contacts.upsert`) — the MCP server exposes them with `.` replaced by `_` (`hubspot_contacts_upsert`) and translates back internally. You always use the underscore form from Claude Desktop / Cursor / etc.; the gate, policy file, audit log, and `@agentbase/sdk` keep using the dotted form.

For the full worked example with a cross-stack policy, see [`examples/byoa-mcp`](../../examples/byoa-mcp).

## Demo from Claude Desktop (60-second tour)

After the server is wired in:

1. **Start the gate locally.** `pnpm --filter @agentbase/api dev` (port 3002). Make sure the DB is up: `infra/docker-compose.yml up -d` + `pnpm --filter @agentbase/db db:push`.
2. **Mint an agent identity.** Open the Agentbase web UI's `/agents` page, create one, copy the `agb_…` key into the `AGENTBASE_API_KEY` slot of the Desktop config above.
3. **Restart Claude Desktop.** Open a new chat. You should see "agentbase" listed under the tools menu with ~60 entries — all underscore-encoded.
4. **Trigger a gated call.** Ask Desktop: _"Create a Salesforce opportunity worth $80,000 for ACME Corp using `salesforce_opportunity_create`."_ The gate's policy fires `require_approval`, the MCP tool returns `status: "awaiting_approval"` with an `action_id`, and the call queues in the Agentbase web UI's `/approvals` page.
5. **Approve in the web UI**, then ask Desktop to call `agentbase_get_action_status` with the `action_id`. Watch it transition to `executed`.

That's the full loop: agent → gate → policy → human → audit, with Claude Desktop as the agent. Every call shows up in `/audit` with the agent identity, policy decision, and final result.

## What the server exposes

Two kinds of MCP tools:

1. **Connector tools** (~60 total across HubSpot, Salesforce, Gmail, Outreach, Apollo). Each connector tool maps 1:1 to an Agentbase tool name — calling `hubspot_contacts_upsert` from the MCP client triggers `POST /v1/actions/execute` on the gate with the dotted form `hubspot.contacts.upsert`.
2. **`agentbase_get_action_status`** — look up the current state of an action by `action_id`. Use this after a connector call returns `status: "awaiting_approval"` to check whether the human approver has decided.

### Result shape

Every connector tool call returns a JSON-stringified payload in the standard MCP `content[0].text` slot:

```json
{
  "action_id": "...",
  "status": "executed" | "awaiting_approval" | "denied" | "failed",
  "result": { ... },              // when status=executed
  "policy_decision": { ... },     // when policy was non-allow
  "poll_tool": "agentbase_get_action_status",   // only when awaiting_approval
  "note": "Human approval required..."           // only when awaiting_approval
}
```

`isError: true` is set for `denied` and `failed` so the MCP client treats them as tool errors. `awaiting_approval` is **not** an error — it's a pending state. The server returns immediately rather than blocking the MCP request while a human decides in Slack. The agent should remember the `action_id` and either move on or poll `agentbase_get_action_status`.

This is a deliberate UX choice. A long-blocking MCP call (Claude Desktop spinning for 4 minutes) is much worse than `"I queued a $50k deal for approval, here's the action_id."`

## v1 alpha limitations

These are real and called out so you don't hit them mid-demo:

- **No policy filtering on `list-tools`.** The server advertises the full connector catalog regardless of what the identity's policy allows. Denied tools fail at call time, not at discovery time. Adding pre-filtering needs a `POST /v1/policy/preview` endpoint on the gate (not yet built).
- **Permissive input schemas.** Each tool advertises `{type: "object", additionalProperties: true}` rather than per-tool JSON Schema. The gate still validates params server-side and returns structured errors. Per-tool schemas land in v2 once connectors export their Zod schemas alongside the tool-name arrays.
- **Stdio transport only.** Streamable-HTTP is doable but unwired. Open an issue if you need it.

## Identity model

One MCP server instance per agent identity. The `AGENTBASE_API_KEY` env var binds the entire server to one `agb_…` token. Want a different agent identity? Run a second server instance with a different `AGENTBASE_API_KEY`. This mirrors how Claude Desktop already namespaces MCP servers by config key (`mcpServers.<name>`).

Multi-identity routing (one MCP server, per-call agent identity) is a v2 design question — leaving it for when there's buyer pull.

## Architecture

```
MCP client (Claude Desktop / Cursor / Codex)
        │
        │  MCP over stdio
        ▼
@agentbase/mcp-server      ← this package
        │
        │  HTTP, Bearer agb_...
        ▼
Agentbase gate (apps/api)
        │
        ├── PolicyEngine        ← allow / require_approval / deny
        ├── ApprovalsService    ← Slack + web inbox routing
        ├── AuditService        ← immutable audit log
        │
        ▼
ConnectorRegistry → HubSpot / Salesforce / Gmail / Outreach / Apollo
```

Same gate as `@agentbase/sdk`. Same policy file. Same approval queue. Same audit log.
