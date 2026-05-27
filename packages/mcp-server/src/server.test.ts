import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import type { ExecuteActionResponse } from '@agentbase/shared';
import { buildCatalog, type ToolCatalogEntry } from './catalog.js';
import { AgentbaseError, type GateClient } from './gate-client.js';
import {
  buildListToolsResponse,
  handleCallTool,
  STATUS_TOOL,
  type McpToolResult,
} from './server.js';

function parseSinglePayload(result: McpToolResult): Record<string, unknown> {
  assert.equal(result.content.length, 1, 'expected exactly one content part');
  const first = result.content[0];
  assert.ok(first, 'content[0] must be defined');
  assert.equal(first.type, 'text');
  return JSON.parse(first.text) as Record<string, unknown>;
}

interface FakeGateOpts {
  execute?: (input: {
    tool: string;
    params: Record<string, unknown>;
    idempotencyKey?: string;
  }) => Promise<ExecuteActionResponse>;
  get?: (actionId: string) => Promise<ExecuteActionResponse>;
}

function fakeGate(opts: FakeGateOpts = {}): GateClient {
  return {
    async execute(input) {
      if (opts.execute) return opts.execute(input);
      throw new Error('execute not stubbed');
    },
    async get(id) {
      if (opts.get) return opts.get(id);
      throw new Error('get not stubbed');
    },
  };
}

const SAMPLE_CATALOG: ToolCatalogEntry[] = [
  {
    name: 'hubspot.contacts.upsert',
    description: 'upsert a hubspot contact',
    inputSchema: { type: 'object', additionalProperties: true },
  },
  {
    name: 'salesforce.opportunity.create',
    description: 'create a salesforce opportunity',
    inputSchema: { type: 'object', additionalProperties: true },
  },
];

describe('buildCatalog', () => {
  it('includes tools from every connector package', () => {
    const catalog = buildCatalog();
    const names = new Set(catalog.map((t) => t.name));
    assert.ok(names.has('hubspot.contacts.upsert'), 'missing hubspot tool');
    assert.ok(names.has('salesforce.opportunity.create'), 'missing salesforce tool');
    assert.ok(names.has('gmail.send') || names.has('gmail.draft'), 'missing gmail tool');
    assert.ok([...names].some((n) => n.startsWith('apollo.')), 'missing apollo tools');
    assert.ok([...names].some((n) => n.startsWith('outreach.')), 'missing outreach tools');
  });

  it('gives every tool a permissive object input schema for v1', () => {
    const catalog = buildCatalog();
    for (const t of catalog) {
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(t.inputSchema.additionalProperties, true);
    }
  });
});

describe('buildListToolsResponse', () => {
  it('advertises the connector catalog plus the status tool', () => {
    const response = buildListToolsResponse(SAMPLE_CATALOG);
    const names = response.tools.map((t) => t.name);
    assert.deepEqual(names, [
      'hubspot.contacts.upsert',
      'salesforce.opportunity.create',
      STATUS_TOOL,
    ]);
  });

  it('declares action_id as a required string on the status tool', () => {
    const response = buildListToolsResponse([]);
    const status = response.tools.find((t) => t.name === STATUS_TOOL);
    assert.ok(status, 'status tool missing');
    const schema = status.inputSchema as {
      required: string[];
      properties: Record<string, { type: string }>;
    };
    assert.deepEqual(schema.required, ['action_id']);
    assert.equal(schema.properties['action_id']?.type, 'string');
  });
});

describe('handleCallTool — connector tools', () => {
  it('routes executed results back as MCP content with isError=false', async () => {
    const gate = fakeGate({
      async execute(input) {
        assert.equal(input.tool, 'hubspot.contacts.upsert');
        assert.deepEqual(input.params, { email: 'cto@globex.com' });
        return {
          action_id: '11111111-1111-1111-1111-111111111111',
          status: 'executed',
          result: { id: 'hs-1' },
        };
      },
    });
    const result = await handleCallTool(
      {
        name: 'hubspot.contacts.upsert',
        arguments: { email: 'cto@globex.com' },
      },
      { gate, catalog: SAMPLE_CATALOG },
    );
    assert.equal(result.isError, false);
    const payload = parseSinglePayload(result);
    assert.equal(payload['status'], 'executed');
    assert.deepEqual(payload['result'], { id: 'hs-1' });
  });

  it('flags denied results with isError=true and surfaces the policy reason', async () => {
    const gate = fakeGate({
      async execute() {
        return {
          action_id: '22222222-2222-2222-2222-222222222222',
          status: 'denied',
          policy_decision: { effect: 'deny', reason: 'outside allowed hours' },
        };
      },
    });
    const result = await handleCallTool(
      { name: 'salesforce.opportunity.create', arguments: { Amount: 50000 } },
      { gate, catalog: SAMPLE_CATALOG },
    );
    assert.equal(result.isError, true);
    const payload = parseSinglePayload(result);
    assert.equal(payload['status'], 'denied');
    assert.deepEqual(payload['policy_decision'], {
      effect: 'deny',
      reason: 'outside allowed hours',
    });
  });

  it('returns pending sentinel for awaiting_approval without blocking', async () => {
    let called = 0;
    const gate = fakeGate({
      async execute() {
        called += 1;
        return {
          action_id: '33333333-3333-3333-3333-333333333333',
          status: 'awaiting_approval',
          policy_decision: { effect: 'require_approval' },
        };
      },
      async get() {
        throw new Error('get should not be called for async-pending v1');
      },
    });
    const result = await handleCallTool(
      { name: 'salesforce.opportunity.create', arguments: { Amount: 80000 } },
      { gate, catalog: SAMPLE_CATALOG },
    );
    assert.equal(called, 1, 'execute should be called exactly once');
    assert.equal(result.isError, false, 'pending is not an error');
    const payload = parseSinglePayload(result);
    assert.equal(payload['status'], 'awaiting_approval');
    assert.equal(payload['poll_tool'], STATUS_TOOL);
    assert.match(String(payload['note'] ?? ''), /Human approval required/);
  });

  it('flags failed results with isError=true', async () => {
    const gate = fakeGate({
      async execute() {
        return {
          action_id: '44444444-4444-4444-4444-444444444444',
          status: 'failed',
        };
      },
    });
    const result = await handleCallTool(
      { name: 'hubspot.contacts.upsert', arguments: { email: 'a@b.com' } },
      { gate, catalog: SAMPLE_CATALOG },
    );
    assert.equal(result.isError, true);
  });

  it('strips idempotency_key from params and passes it through separately', async () => {
    let observed: { tool: string; params: Record<string, unknown>; idempotencyKey?: string } | null = null;
    const gate = fakeGate({
      async execute(input) {
        observed = input;
        return {
          action_id: '55555555-5555-5555-5555-555555555555',
          status: 'executed',
        };
      },
    });
    await handleCallTool(
      {
        name: 'hubspot.contacts.upsert',
        arguments: { email: 'a@b.com', idempotency_key: 'abc-123' },
      },
      { gate, catalog: SAMPLE_CATALOG },
    );
    assert.ok(observed, 'execute was never called');
    const obs = observed as unknown as {
      params: Record<string, unknown>;
      idempotencyKey?: string;
    };
    assert.equal(obs.idempotencyKey, 'abc-123');
    assert.equal('idempotency_key' in obs.params, false);
  });

  it('returns an error result for an unknown tool name', async () => {
    const gate = fakeGate();
    const result = await handleCallTool(
      { name: 'totally.fake.tool', arguments: {} },
      { gate, catalog: SAMPLE_CATALOG },
    );
    assert.equal(result.isError, true);
    const payload = parseSinglePayload(result);
    assert.match(String(payload['error']), /Unknown tool/);
  });

  it('wraps gate AgentbaseErrors with status code in the message', async () => {
    const gate = fakeGate({
      async execute() {
        throw new AgentbaseError('rate limited', 429, { code: 'too_many' });
      },
    });
    const result = await handleCallTool(
      { name: 'hubspot.contacts.upsert', arguments: {} },
      { gate, catalog: SAMPLE_CATALOG },
    );
    assert.equal(result.isError, true);
    const payload = parseSinglePayload(result);
    assert.match(String(payload['error']), /429/);
    assert.match(String(payload['error']), /rate limited/);
  });
});

describe('handleCallTool — agentbase.get_action_status', () => {
  it('returns the live action state from the gate', async () => {
    const gate = fakeGate({
      async get(id) {
        assert.equal(id, '66666666-6666-6666-6666-666666666666');
        return {
          action_id: id,
          status: 'executed',
          result: { ok: true },
        };
      },
    });
    const result = await handleCallTool(
      {
        name: STATUS_TOOL,
        arguments: { action_id: '66666666-6666-6666-6666-666666666666' },
      },
      { gate, catalog: SAMPLE_CATALOG },
    );
    assert.equal(result.isError, false);
    const payload = parseSinglePayload(result);
    assert.equal(payload['status'], 'executed');
  });

  it('rejects calls missing action_id', async () => {
    const gate = fakeGate();
    const result = await handleCallTool(
      { name: STATUS_TOOL, arguments: {} },
      { gate, catalog: SAMPLE_CATALOG },
    );
    assert.equal(result.isError, true);
    const payload = parseSinglePayload(result);
    assert.match(String(payload['error']), /action_id/);
  });
});
