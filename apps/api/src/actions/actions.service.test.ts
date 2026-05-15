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
import type {
  RateLimitResult,
  RateLimitService,
} from './rate-limit.service.js';

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

class StubRateLimit {
  result: RateLimitResult = { ok: true };
  checks: Array<{ orgId: string; agentId: string; tool: string }> = [];
  async check(input: {
    orgId: string;
    agentId: string;
    tool: string;
  }): Promise<RateLimitResult> {
    this.checks.push(input);
    return this.result;
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
  let rateLimit: StubRateLimit;
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
    rateLimit = new StubRateLimit();
    svc = new ActionsService(
      db,
      audit,
      policy as unknown as PolicyService,
      registry as unknown as ConnectorRegistry,
      slack as unknown as SlackService,
      rateLimit as unknown as RateLimitService,
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

  it('dashboard HubSpot lead workflow posts Slack approval card with deal context', async () => {
    policy.decision = makeDecision({
      effect: 'require_approval',
      reason: 'high value lead',
      approver_role: 'approver',
      rule_matched: {
        match: { tool: 'hubspot.leads.create_deal' },
        effect: 'require_approval',
        slack_channel: '#sales-approvals',
      },
    });
    slack.isConfiguredValue = true;
    slack.postedCard = { channel: 'C999', ts: '999.1000' };

    const params = {
      contact: {
        email: 'buyer@example.com',
        firstname: 'Bea',
        lastname: 'Buyer',
        company: 'Acme',
      },
      deal: {
        dealname: 'Enterprise pilot',
        amount: 50000,
      },
      note: {
        body: 'Requested a security review before rollout.',
      },
    };

    const out = await execute('hubspot.leads.create_deal', params);

    assert.equal(out.status, 'awaiting_approval');
    assert.equal(registry.invocations.length, 0);
    assert.equal(slack.posts.length, 1);
    assert.equal(slack.posts[0]!.tool, 'hubspot.leads.create_deal');
    assert.equal(slack.posts[0]!.channelOverride, '#sales-approvals');

    const [app] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.actionId, out.action_id));
    assert.equal(app!.requiredRole, 'approver');
    assert.equal(app!.slackChannel, 'C999');
    assert.equal(app!.slackTs, '999.1000');

    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, out.action_id));
    assert.equal(row!.status, 'awaiting_approval');
    assert.deepEqual(row!.params, params);

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    assert.ok(events.some((e) => e.eventType === 'action.awaiting_approval'));
    assert.ok(events.some((e) => e.eventType === 'approval.posted_to_slack'));
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

  it('idempotency: second execute with same key returns cached result, no second connector call', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    registry.result = { ok: true, data: { id: 'crm-42' } };

    const first = await svc.execute({
      orgId,
      agentId,
      tool: 'hubspot.contacts.update',
      params: { contactId: 'c1' },
      idempotencyKey: 'retry-key-1',
    });
    assert.equal(first.status, 'executed');
    assert.equal(registry.invocations.length, 1);

    // Same key, identical params → cached path. Note we change `result` on
    // the registry to prove the connector wasn't re-invoked.
    registry.result = { ok: true, data: { id: 'should-not-appear' } };
    const second = await svc.execute({
      orgId,
      agentId,
      tool: 'hubspot.contacts.update',
      params: { contactId: 'c1' },
      idempotencyKey: 'retry-key-1',
    });

    assert.equal(second.action_id, first.action_id);
    assert.equal(second.status, 'executed');
    assert.deepEqual(
      (second.result as { data: unknown }).data,
      { id: 'crm-42' },
    );
    // Critically: connector was called exactly once across both requests.
    assert.equal(registry.invocations.length, 1);

    // No second action row was created.
    const rows = await db
      .select()
      .from(actions)
      .where(eq(actions.orgId, orgId));
    assert.equal(rows.length, 1);
  });

  it('idempotency: returns cached deny without re-evaluating policy', async () => {
    policy.decision = makeDecision({ effect: 'deny', reason: 'forbidden' });
    const first = await svc.execute({
      orgId,
      agentId,
      tool: 't.deny',
      params: {},
      idempotencyKey: 'key-deny',
    });
    assert.equal(first.status, 'denied');

    // Even if policy now flips to allow, the cached deny stands.
    policy.decision = makeDecision({ effect: 'allow' });
    const second = await svc.execute({
      orgId,
      agentId,
      tool: 't.deny',
      params: {},
      idempotencyKey: 'key-deny',
    });
    assert.equal(second.status, 'denied');
    assert.equal(second.action_id, first.action_id);
    // Connector still never called.
    assert.equal(registry.invocations.length, 0);
  });

  it('idempotency: different keys → independent executions', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    await svc.execute({
      orgId, agentId, tool: 't.t', params: {}, idempotencyKey: 'key-a',
    });
    await svc.execute({
      orgId, agentId, tool: 't.t', params: {}, idempotencyKey: 'key-b',
    });
    assert.equal(registry.invocations.length, 2);
    const rows = await db
      .select()
      .from(actions)
      .where(eq(actions.orgId, orgId));
    assert.equal(rows.length, 2);
  });

  it('idempotency: same key for different agents → independent (key is scoped to agent)', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    const [agent2] = await db
      .insert(agents)
      .values({ orgId, name: 'second-agent' })
      .returning();

    await svc.execute({
      orgId, agentId, tool: 't.t', params: {}, idempotencyKey: 'shared-key',
    });
    await svc.execute({
      orgId,
      agentId: agent2!.id,
      tool: 't.t',
      params: {},
      idempotencyKey: 'shared-key',
    });
    assert.equal(registry.invocations.length, 2);
  });

  it('idempotency: no key → no dedup, every call executes fresh', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    await execute('t.t', { v: 1 });
    await execute('t.t', { v: 2 });
    await execute('t.t', { v: 3 });
    assert.equal(registry.invocations.length, 3);
  });

  it('rate-limited: connector not invoked, action persisted as failed with rate_limited code', async () => {
    rateLimit.result = {
      ok: false,
      scope: 'tool',
      limit: 60,
      retry_after_sec: 60,
    };
    policy.decision = makeDecision({ effect: 'allow' });

    const out = await execute('hubspot.contacts.update', { id: 'c1' });

    assert.equal(out.status, 'failed');
    const result = out.result as {
      ok: boolean;
      error: { code: string; scope: string; retry_after_sec: number };
    };
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'rate_limited');
    assert.equal(result.error.scope, 'tool');
    assert.equal(result.error.retry_after_sec, 60);

    // Connector never called.
    assert.equal(registry.invocations.length, 0);

    // Audit log entry recorded.
    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    assert.equal(events.length, 1);
    assert.equal(events[0]!.eventType, 'action.rate_limited');
    const payload = events[0]!.payload as { scope: string; limit: number };
    assert.equal(payload.scope, 'tool');
    assert.equal(payload.limit, 60);

    // Persisted row carries the rate_limited error so ops can audit later.
    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, out.action_id));
    assert.equal(row!.status, 'failed');
    const stored = row!.result as { error: { code: string } };
    assert.equal(stored.error.code, 'rate_limited');
  });

  it('rate-limited: agent-scope blocks even when tool-scope allows', async () => {
    rateLimit.result = {
      ok: false,
      scope: 'agent',
      limit: 600,
      retry_after_sec: 60,
    };
    policy.decision = makeDecision({ effect: 'allow' });

    const out = await execute('any.tool', {});
    const result = out.result as { error: { scope: string; message: string } };
    assert.equal(result.error.scope, 'agent');
    assert.match(result.error.message, /agent-scope limit of 600/);
  });

  it('rate-limit check happens after idempotency lookup: cached request bypasses limiter', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    // First request: limiter says ok, executes.
    rateLimit.result = { ok: true };
    const first = await svc.execute({
      orgId,
      agentId,
      tool: 't.t',
      params: {},
      idempotencyKey: 'idem-bypass',
    });
    assert.equal(first.status, 'executed');
    const checksAfterFirst = rateLimit.checks.length;

    // Limiter now blocks. But the idempotent retry should hit the cache and
    // never reach the limiter — otherwise a flaky network on the agent side
    // would cause its retried request to be falsely throttled.
    rateLimit.result = {
      ok: false,
      scope: 'tool',
      limit: 60,
      retry_after_sec: 60,
    };
    const second = await svc.execute({
      orgId,
      agentId,
      tool: 't.t',
      params: {},
      idempotencyKey: 'idem-bypass',
    });
    assert.equal(second.action_id, first.action_id);
    assert.equal(second.status, 'executed');
    // Limiter was NOT called for the cached path.
    assert.equal(rateLimit.checks.length, checksAfterFirst);
  });

  it('rate-limit ok: passes through to policy and connector unchanged', async () => {
    rateLimit.result = { ok: true };
    policy.decision = makeDecision({ effect: 'allow' });
    const out = await execute('t.t', {});
    assert.equal(out.status, 'executed');
    assert.equal(rateLimit.checks.length, 1);
    assert.equal(rateLimit.checks[0]!.tool, 't.t');
    assert.equal(registry.invocations.length, 1);
  });

  it('retry: failed action becomes executed when connector now succeeds', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    registry.result = {
      ok: false,
      error: { code: 'http_503', message: 'upstream down' },
    };
    const first = await execute('hubspot.contacts.update', { id: 'c1' });
    assert.equal(first.status, 'failed');

    // Connector now recovers.
    registry.result = { ok: true, data: { id: 'c1', updated: true } };

    const retried = await svc.retry({
      orgId,
      actionId: first.action_id,
      operatorId: 'user_op_1',
    });
    assert.equal(retried.status, 'executed');
    assert.equal(retried.action_id, first.action_id);
    assert.deepEqual(
      (retried.result as { data: unknown }).data,
      { id: 'c1', updated: true },
    );

    // Same row updated in place — no duplicate action.
    const rows = await db
      .select()
      .from(actions)
      .where(eq(actions.orgId, orgId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'executed');

    // Connector was called twice (original + retry).
    assert.equal(registry.invocations.length, 2);
    assert.equal(registry.invocations[0]!.params.id, 'c1');
    assert.equal(registry.invocations[1]!.params.id, 'c1');

    // Audit log carries the retry event with operator identity.
    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const retryEvent = events.find((e) => e.eventType === 'action.retried')!;
    assert.equal(retryEvent.actorType, 'user');
    assert.equal(retryEvent.actorId, 'user_op_1');
    const payload = retryEvent.payload as {
      previous_status: string;
      new_status: string;
    };
    assert.equal(payload.previous_status, 'failed');
    assert.equal(payload.new_status, 'executed');
  });

  it('retry: 404 if action does not exist', async () => {
    await assert.rejects(
      svc.retry({
        orgId,
        actionId: '00000000-0000-0000-0000-000000000000',
        operatorId: 'op',
      }),
      /not found/i,
    );
  });

  it('retry: 409 when status is not failed (executed cannot be retried)', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    registry.result = { ok: true, data: {} };
    const out = await execute('t.t', {});
    assert.equal(out.status, 'executed');

    await assert.rejects(
      svc.retry({ orgId, actionId: out.action_id, operatorId: 'op' }),
      /only 'failed' is retryable/,
    );
  });

  it('retry: 409 when original decision was deny — operator must change policy', async () => {
    policy.decision = makeDecision({ effect: 'deny', reason: 'forbidden' });
    const out = await execute('t.t', {});
    assert.equal(out.status, 'denied');
    // Manually flip status to failed to simulate a hypothetical edge case
    // where a deny somehow ended up persisted as failed. The retry should
    // still refuse based on the stored decision.
    await db
      .update(actions)
      .set({ status: 'failed' })
      .where(eq(actions.id, out.action_id));

    await assert.rejects(
      svc.retry({ orgId, actionId: out.action_id, operatorId: 'op' }),
      /policy decision was 'deny'/,
    );
  });

  it('retry: respects rate limiter, marks rate_limited without invoking connector', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    registry.result = {
      ok: false,
      error: { code: 'http_503', message: 'upstream down' },
    };
    const first = await execute('t.t', {});
    assert.equal(first.status, 'failed');
    assert.equal(registry.invocations.length, 1);

    rateLimit.result = {
      ok: false,
      scope: 'tool',
      limit: 60,
      retry_after_sec: 60,
    };
    const retried = await svc.retry({
      orgId,
      actionId: first.action_id,
      operatorId: 'op',
    });
    assert.equal(retried.status, 'failed');
    const result = retried.result as { error: { code: string } };
    assert.equal(result.error.code, 'rate_limited');
    // Connector NOT invoked again.
    assert.equal(registry.invocations.length, 1);

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const retryEvent = events.find(
      (e) => e.eventType === 'action.retried_rate_limited',
    );
    assert.ok(retryEvent, 'retry rate-limited event should be audited');
  });

  it('retry: connector still failing leaves action as failed with new error', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    registry.result = {
      ok: false,
      error: { code: 'http_503', message: 'upstream down' },
    };
    const first = await execute('t.t', {});

    registry.result = {
      ok: false,
      error: { code: 'http_502', message: 'bad gateway' },
    };
    const retried = await svc.retry({
      orgId,
      actionId: first.action_id,
      operatorId: 'op',
    });
    assert.equal(retried.status, 'failed');
    const result = retried.result as { error: { code: string } };
    // The retry's error code is now persisted (overwrites the original).
    assert.equal(result.error.code, 'http_502');
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
      new StubRateLimit() as unknown as RateLimitService,
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
