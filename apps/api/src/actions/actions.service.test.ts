// Integration tests for ActionsService — require Postgres on $DATABASE_URL
// (default localhost:5433). Each test creates a unique org for isolation.

import {
  describe,
  it,
  before,
  after,
  beforeEach,
  afterEach,
} from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  schema,
  orgs,
  agents,
  actions,
  approvals,
  auditLog,
} from '@dejavas/db';
import type { Connector, ConnectorResult } from '@dejavas/connector-hubspot';
import type { PolicyDecision } from '@dejavas/shared';
import { ActionsService } from './actions.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { PolicyService } from '../policy/policy.service.js';
import type { ConnectorRegistry } from '../connectors/connector-registry.js';
import type { SlackService } from '../slack/slack.service.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://dejavas:dejavas@localhost:5433/dejavas';

function makeDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    effect: 'allow',
    reason: null,
    rule_index: null,
    rule_matched: null,
    approver_role: null,
    policy_id: null,
    fallback: false,
    ...overrides,
  };
}

class StubPolicy {
  decision: PolicyDecision = makeDecision();
  async evaluate(): Promise<PolicyDecision> {
    return this.decision;
  }
}

class StubRegistry {
  invocations: { tool: string; params: Record<string, unknown> }[] = [];
  result: ConnectorResult = { ok: true, data: { stub: true } };
  resolveAlways = true;
  resolve(_tool: string): Connector | null {
    if (!this.resolveAlways) return null;
    return {
      name: 'stub',
      supports: () => true,
      invoke: async (tool, params) => {
        this.invocations.push({ tool, params });
        return this.result;
      },
    };
  }
}

class StubSlack {
  isConfiguredValue = false;
  postedCard: { channel: string; ts: string } | null = null;
  posts: Array<{
    channelOverride: string | null | undefined;
    approvalId: string;
    tool: string;
  }> = [];
  isConfigured() {
    return this.isConfiguredValue;
  }
  async postApprovalCard(input: {
    approvalId: string;
    tool: string;
    channelOverride?: string | null;
  }) {
    this.posts.push({
      approvalId: input.approvalId,
      tool: input.tool,
      channelOverride: input.channelOverride ?? null,
    });
    return this.postedCard;
  }
}

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let audit: AuditService;

before(() => {
  client = postgres(DB_URL, { max: 5 });
  db = drizzle(client, { schema });
  audit = new AuditService(db);
});

after(async () => {
  await client.end();
});

describe('ActionsService.execute', () => {
  let orgId: string;
  let agentId: string;
  let policy: StubPolicy;
  let registry: StubRegistry;
  let slack: StubSlack;
  let svc: ActionsService;

  beforeEach(async () => {
    const slug = `act-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug })
      .returning();
    orgId = org!.id;
    const [agent] = await db
      .insert(agents)
      .values({ orgId, name: 'actions-agent' })
      .returning();
    agentId = agent!.id;

    policy = new StubPolicy();
    registry = new StubRegistry();
    slack = new StubSlack();
    svc = new ActionsService(
      db,
      audit,
      policy as unknown as PolicyService,
      registry as unknown as ConnectorRegistry,
      slack as unknown as SlackService,
    );
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  async function execute(
    tool = 'test.tool',
    params: Record<string, unknown> = { k: 'v' },
  ) {
    return svc.execute({ orgId, agentId, tool, params });
  }

  it('deny: action ends denied, no connector call, audit denied', async () => {
    policy.decision = makeDecision({ effect: 'deny', reason: 'forbidden' });
    const out = await execute();
    assert.equal(out.status, 'denied');

    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, out.action_id));
    assert.equal(row!.status, 'denied');
    assert.ok(row!.completedAt);

    assert.equal(registry.invocations.length, 0);
    assert.equal(slack.posts.length, 0);

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.eventType, 'action.denied');
  });

  it('require_approval (no Slack): creates approval row with TTL, no slack post', async () => {
    policy.decision = makeDecision({
      effect: 'require_approval',
      approver_role: 'approver',
      reason: 'sensitive',
    });
    const out = await execute();
    assert.equal(out.status, 'awaiting_approval');

    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, out.action_id));
    assert.equal(row!.status, 'awaiting_approval');
    assert.equal(row!.completedAt, null);

    const apps = await db
      .select()
      .from(approvals)
      .where(eq(approvals.actionId, out.action_id));
    assert.equal(apps.length, 1);
    assert.equal(apps[0]!.decision, 'pending');
    assert.equal(apps[0]!.requiredRole, 'approver');
    assert.ok(apps[0]!.expiresAt);
    const ttlMs = apps[0]!.expiresAt!.getTime() - Date.now();
    assert.ok(ttlMs > 23 * 3600_000 && ttlMs <= 24 * 3600_000);

    assert.equal(slack.posts.length, 0);
    assert.equal(registry.invocations.length, 0);

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.eventType, 'action.awaiting_approval');
  });

  it('require_approval + Slack configured + rule slack_channel: card posted with override', async () => {
    policy.decision = makeDecision({
      effect: 'require_approval',
      rule_matched: {
        match: { tool: 'test.tool' },
        effect: 'require_approval',
        slack_channel: '#critical-approvals',
      },
    });
    slack.isConfiguredValue = true;
    slack.postedCard = { channel: 'C123', ts: '1234.5678' };

    const out = await execute('test.tool', { amount: 50000 });
    assert.equal(out.status, 'awaiting_approval');

    assert.equal(slack.posts.length, 1);
    assert.equal(slack.posts[0]!.channelOverride, '#critical-approvals');
    assert.equal(slack.posts[0]!.tool, 'test.tool');

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const types = events.map((e) => e.eventType).sort();
    assert.deepEqual(types, ['action.awaiting_approval', 'approval.posted_to_slack']);

    const slackEvent = events.find((e) => e.eventType === 'approval.posted_to_slack')!;
    const payload = slackEvent.payload as Record<string, unknown>;
    assert.equal(payload['channel_override_used'], '#critical-approvals');

    // approval row should have been backfilled with slack_channel + slack_ts
    const apps = await db
      .select()
      .from(approvals)
      .where(eq(approvals.actionId, out.action_id));
    assert.equal(apps[0]!.slackChannel, 'C123');
    assert.equal(apps[0]!.slackTs, '1234.5678');
  });

  it('allow + connector success: action executed with stored result', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    registry.result = { ok: true, data: { id: 'hs-1', updated: true } };

    const out = await execute('hubspot.contacts.update', { contactId: 'c1' });
    assert.equal(out.status, 'executed');

    assert.equal(registry.invocations.length, 1);
    assert.equal(registry.invocations[0]!.tool, 'hubspot.contacts.update');
    assert.deepEqual(registry.invocations[0]!.params, { contactId: 'c1' });

    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, out.action_id));
    assert.equal(row!.status, 'executed');
    assert.ok(row!.completedAt);
    const stored = row!.result as { ok: boolean; data: unknown };
    assert.equal(stored.ok, true);
    assert.deepEqual(stored.data, { id: 'hs-1', updated: true });

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    assert.equal(events[0]!.eventType, 'action.executed');
  });

  it('allow + connector failure: action ends failed with error code', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    registry.result = {
      ok: false,
      error: { code: 'http_503', message: 'upstream down' },
    };

    const out = await execute();
    assert.equal(out.status, 'failed');

    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, out.action_id));
    assert.equal(row!.status, 'failed');
    const stored = row!.result as { ok: boolean; error: { code: string } };
    assert.equal(stored.ok, false);
    assert.equal(stored.error.code, 'http_503');

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    assert.equal(events[0]!.eventType, 'action.failed');
    const payload = events[0]!.payload as { error?: { code?: string } };
    assert.equal(payload.error?.code, 'http_503');
  });

  it('allow + no connector resolves: action fails with no_connector', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    registry.resolveAlways = false;

    const out = await execute('mystery.tool');
    assert.equal(out.status, 'failed');

    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, out.action_id));
    const stored = row!.result as { error: { code: string } };
    assert.equal(stored.error.code, 'no_connector');

    assert.equal(registry.invocations.length, 0);
  });

  it('idempotency_key is persisted on the action row', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    const out = await svc.execute({
      orgId,
      agentId,
      tool: 't.t',
      params: {},
      idempotencyKey: 'unique-abc-123',
    });
    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, out.action_id));
    assert.equal(row!.idempotencyKey, 'unique-abc-123');
  });
});

describe('ActionsService.listForOrg', () => {
  let orgId: string;
  let agentId: string;
  let svc: ActionsService;

  beforeEach(async () => {
    const slug = `actl-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug })
      .returning();
    orgId = org!.id;
    const [agent] = await db
      .insert(agents)
      .values({ orgId, name: 'list-agent' })
      .returning();
    agentId = agent!.id;
    svc = new ActionsService(
      db,
      audit,
      new StubPolicy() as unknown as PolicyService,
      new StubRegistry() as unknown as ConnectorRegistry,
      new StubSlack() as unknown as SlackService,
    );
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('returns actions for the org joined with agent name, ordered desc by createdAt', async () => {
    for (const tool of ['t.one', 't.two', 't.three']) {
      await db.insert(actions).values({
        orgId,
        agentId,
        tool,
        params: {},
        status: 'executed',
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const result = await svc.listForOrg(orgId, 50);
    assert.equal(result.items.length, 3);
    assert.equal(result.items[0]!.tool, 't.three');
    assert.equal(result.items[2]!.tool, 't.one');
    for (const item of result.items) {
      assert.equal(item.agent_name, 'list-agent');
      assert.equal(item.agent_id, agentId);
    }
  });

  it('limit is honored', async () => {
    for (let i = 0; i < 5; i++) {
      await db.insert(actions).values({
        orgId,
        agentId,
        tool: `t.${i}`,
        params: {},
        status: 'executed',
      });
    }
    const result = await svc.listForOrg(orgId, 2);
    assert.equal(result.items.length, 2);
  });

  it('returns empty for an org with no actions', async () => {
    const result = await svc.listForOrg(orgId);
    assert.deepEqual(result.items, []);
  });
});
