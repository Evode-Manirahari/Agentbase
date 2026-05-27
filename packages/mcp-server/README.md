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

Restart Claude Desktop. The Agentbase tools (`hubspot.contacts.upsert`, `salesforce.opportunity.create`, etc.) will appear under the agentbase server. Every call routes through your local Agentbase gate.

For the full worked example with a cross-stack policy, see [`examples/byoa-mcp`](../../examples/byoa-mcp).

## What the server exposes

Two kinds of MCP tools:

1. **Connector tools** (~60 total across HubSpot, Salesforce, Gmail, Outreach, Apollo). Each connector tool maps 1:1 to an Agentbase tool name — calling `hubspot.contacts.upsert` from the MCP client triggers `POST /v1/actions/execute` on the gate with that tool name.
2. **`agentbase.get_action_status`** — look up the current state of an action by `action_id`. Use this after a connector call returns `status: "awaiting_approval"` to check whether the human approver has decided.

### Result shape

Every connector tool call returns a JSON-stringified payload in the standard MCP `content[0].text` slot:

```json
{
  "action_id": "...",
  "status": "executed" | "awaiting_approval" | "denied" | "failed",
  "result": { ... },              // when status=executed
  "policy_decision": { ... },     // when policy was non-allow
  "poll_tool": "agentbase.get_action_status",   // only when awaiting_approval
  "note": "Human approval required..."           // only when awaiting_approval
}
```

`isError: true` is set for `denied` and `failed` so the MCP client treats them as tool errors. `awaiting_approval` is **not** an error — it's a pending state. The server returns immediately rather than blocking the MCP request while a human decides in Slack. The agent should remember the `action_id` and either move on or poll `agentbase.get_action_status`.

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
