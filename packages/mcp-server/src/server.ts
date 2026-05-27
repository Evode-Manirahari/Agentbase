import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { buildCatalog, isCatalogTool, type ToolCatalogEntry } from './catalog.js';
import type { GateClient } from './gate-client.js';
import { AgentbaseError } from './gate-client.js';

export const STATUS_TOOL = 'agentbase.get_action_status';

interface ServerOptions {
  gate: GateClient;
  name?: string;
  version?: string;
  catalog?: ToolCatalogEntry[];
}

interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  isError?: boolean;
}

interface CallToolInput {
  name: string;
  arguments?: Record<string, unknown> | undefined;
}

// Shapes the gate response into a single JSON payload the MCP client (and
// the model behind it) can read. Always returns the action_id so the agent
// can poll via `agentbase.get_action_status` if it wants the eventual
// outcome of an awaiting_approval call.
function shapeToolResult(response: {
  action_id: string;
  status: string;
  result?: unknown;
  policy_decision?: unknown;
}): McpToolResult {
  const base: Record<string, unknown> = {
    action_id: response.action_id,
    status: response.status,
  };
  if (response.result !== undefined) base['result'] = response.result;
  if (response.policy_decision !== undefined) {
    base['policy_decision'] = response.policy_decision;
  }
  if (response.status === 'awaiting_approval') {
    base['poll_tool'] = STATUS_TOOL;
    base['note'] =
      'Human approval required. Call ' +
      STATUS_TOOL +
      ` with action_id="${response.action_id}" to check status.`;
  }
  const text = JSON.stringify(base, null, 2);
  return {
    content: [{ type: 'text', text }],
    isError: response.status === 'denied' || response.status === 'failed',
  };
}

function errorResult(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function formatError(err: unknown): string {
  if (err instanceof AgentbaseError) {
    return `Agentbase gate error (${err.status}): ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export function buildListToolsResponse(catalog: ToolCatalogEntry[]): {
  tools: Array<ToolCatalogEntry | {
    name: string;
    description: string;
    inputSchema: object;
  }>;
} {
  return {
    tools: [
      ...catalog,
      {
        name: STATUS_TOOL,
        description:
          'Look up the current status of an Agentbase action by action_id. ' +
          'Use this after a connector tool returned status="awaiting_approval" ' +
          'to check whether the human approver has decided.',
        inputSchema: {
          type: 'object',
          required: ['action_id'],
          additionalProperties: false,
          properties: {
            action_id: {
              type: 'string',
              description: 'The action_id returned by an earlier tool call.',
            },
          },
        },
      },
    ],
  };
}

export async function handleCallTool(
  request: CallToolInput,
  ctx: { gate: GateClient; catalog: ToolCatalogEntry[] },
): Promise<McpToolResult> {
  const { name } = request;
  const params = (request.arguments ?? {}) as Record<string, unknown>;

  if (name === STATUS_TOOL) {
    const actionId = params['action_id'];
    if (typeof actionId !== 'string' || actionId.length === 0) {
      return errorResult(`${STATUS_TOOL} requires a string "action_id" argument`);
    }
    try {
      const response = await ctx.gate.get(actionId);
      return shapeToolResult(response);
    } catch (err) {
      return errorResult(formatError(err));
    }
  }

  if (!isCatalogTool(name, ctx.catalog)) {
    return errorResult(
      `Unknown tool "${name}". Call list_tools to see available tools.`,
    );
  }

  const idemRaw = params['idempotency_key'];
  const idempotencyKey = typeof idemRaw === 'string' ? idemRaw : undefined;
  const callParams = { ...params };
  delete callParams['idempotency_key'];

  try {
    const response = await ctx.gate.execute({
      tool: name,
      params: callParams,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    return shapeToolResult(response);
  } catch (err) {
    return errorResult(formatError(err));
  }
}

export function createAgentbaseMcpServer(opts: ServerOptions): Server {
  const catalog = opts.catalog ?? buildCatalog();
  const server = new Server(
    {
      name: opts.name ?? 'agentbase-mcp',
      version: opts.version ?? '0.0.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    buildListToolsResponse(catalog),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await handleCallTool(
      {
        name: request.params.name,
        arguments: request.params.arguments,
      },
      { gate: opts.gate, catalog },
    );
    return result as unknown as CallToolResult;
  });

  return server;
}
