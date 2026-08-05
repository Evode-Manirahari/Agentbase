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
import { ConfigService } from '@nestjs/config';
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
  effectReceipts,
} from '@agentbase/db';
import type { Connector, ConnectorResult } from '@agentbase/connector-hubspot';
import type { PolicyDecision } from '@agentbase/shared';
import { ActionsService } from './actions.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { PolicyService } from '../policy/policy.service.js';
import type { ConnectorRegistry } from '../connectors/connector-registry.js';
import type { SlackService } from '../slack/slack.service.js';
import { EffectDispatcher } from './effect-dispatcher.service.js';
import { EffectReceiptsService } from './effect-receipts.service.js';
import type {
  RateLimitResult,
  RateLimitService,
} from './rate-limit.service.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://agentbase:agentbase@localhost:5433/agentbase';

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
  calls: Array<{
    orgId: string;
    action: {
      tool: string;
      params: Record<string, unknown>;
      agentId?: string | undefined;
    };
  }> = [];
  async evaluate(
    orgId: string,
    action: {
      tool: string;
      params: Record<string, unknown>;
      agentId?: string | undefined;
    },
  ): Promise<PolicyDecision> {
    this.calls.push({ orgId, action });
    return this.decision;
  }
}

class StubRegistry {
  invocations: { tool: string; params: Record<string, unknown> }[] = [];
  // What the fake provider claims about retry safety. Defaults to the
  // pessimistic reading, matching an undeclared connector.
  idempotencyMode: 'key' | 'natural' | 'none' = 'none';
  // Simulates a classifier that blows up mid-assessment.
  assessThrows = false;
  // What assess() reports when it does not throw.
  assessResult: {
    effectClass: string;
    reversible: boolean;
    summary: string;
  } | null = null;
  result: ConnectorResult = { ok: true, data: { stub: true } };
  resolveAlways = true;
  // Widens the window between "connector called" and "outcome recorded" so
  // concurrency tests deterministically exercise the race the reservation is
  // there to close.
  delayMs = 0;
  resolve(_tool: string): Connector | null {
    if (!this.resolveAlways) return null;
    return {
      name: 'stub',
      supports: () => true,
      idempotency: () => this.idempotencyMode,
      assess: () => {
        if (this.assessThrows) throw new Error('classifier exploded');
        return this.assessResult;
      },
      invoke: async (tool, params) => {
        this.invocations.push({ tool, params });
        if (this.delayMs > 0) {
          await new Promise((r) => setTimeout(r, this.delayMs));
        }
        return this.result;
      },
    } as Connector;
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

// Builds the effect dispatcher the services now depend on. `replay` flips the
// hard mode switch that makes it incapable of reaching a connector.
function makeEffects(replay = false): EffectDispatcher {
  const config = {
    // Returns '' rather than undefined for the non-replay case. Undefined
    // makes EffectDispatcher.isReplay fall through to process.env, so an
    // exported AGENTBASE_REPLAY=1 would silently put the whole suite in replay
    // mode — every connector assertion would pass while nothing was called.
    get: (k: string) => (k === 'AGENTBASE_REPLAY' ? (replay ? '1' : '') : undefined),
  } as unknown as ConfigService;
  return new EffectDispatcher(new EffectReceiptsService(db, audit), config);
}

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
      makeEffects(),
      new EffectReceiptsService(db, audit),
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

    assert.equal(policy.calls.length, 1);
    assert.equal(policy.calls[0]!.orgId, orgId);
    assert.equal(policy.calls[0]!.action.agentId, agentId);
    assert.equal(policy.calls[0]!.action.tool, 'hubspot.contacts.update');

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

  it('retry: refuses an unknown dispatch when the provider cannot dedupe', async () => {
    // The sweeper marks a never-settled dispatch `failed` + `unknown`. "Failed"
    // there means "we do not know", not "nothing happened" — so the Retry
    // button was a way to turn one deployment into two.
    policy.decision = makeDecision({ effect: 'allow' });
    registry.result = { ok: false, error: { code: 'timeout', message: 'gone' } };
    const out = await execute('t.t', {});
    await db
      .update(actions)
      .set({ status: 'failed', dispatchState: 'unknown' })
      .where(eq(actions.id, out.action_id));

    registry.invocations.length = 0;
    await assert.rejects(
      svc.retry({ orgId, actionId: out.action_id, operatorId: 'op' }),
      /dispatch outcome is unknown/,
    );
    assert.equal(registry.invocations.length, 0, 'the connector was not called');
  });

  it('retry: refuses a key-mode retry once the provider dedupe window has passed', async () => {
    // Stripe keys last 24h. Past that the key collapses nothing and the retry
    // is a fresh effect — the same duplicate the guard exists to prevent, just
    // slower to arrive.
    policy.decision = makeDecision({ effect: 'allow' });
    // Declared before the attempt so the recorded receipt says 'key' — the
    // guard reads attempt 1, not the connector's opinion today.
    registry.idempotencyMode = 'key';
    registry.result = { ok: false, error: { code: 'timeout', message: 'gone' } };
    const out = await execute('t.t', {});
    await db
      .update(effectReceipts)
      .set({ startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(effectReceipts.actionId, out.action_id));
    await db
      .update(actions)
      .set({
        status: 'failed',
        dispatchState: 'unknown',
        dispatchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      })
      .where(eq(actions.id, out.action_id));

    registry.invocations.length = 0;
    await assert.rejects(
      svc.retry({ orgId, actionId: out.action_id, operatorId: 'op' }),
      /older than 24h/,
    );
    assert.equal(registry.invocations.length, 0, 'the connector was not called');
  });

  it('retry: a mid-window retry cannot reset the provider expiry clock', async () => {
    // The bypass: retry() used to measure expiry from actions.dispatchedAt,
    // which the retry claim overwrites. Retry at hour 23, and a retry at hour
    // 30 then looks fresh — long after the provider expired the original key.
    // The decision now comes from attempt 1, which is immutable.
    policy.decision = makeDecision({ effect: 'allow' });
    registry.idempotencyMode = 'key';
    registry.result = { ok: false, error: { code: 'timeout', message: 'gone' } };
    const out = await execute('t.t', {});

    // Age the FIRST attempt past the window, but leave the action row looking
    // freshly dispatched — exactly what a mid-window retry would have done.
    await db
      .update(effectReceipts)
      .set({ startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(effectReceipts.actionId, out.action_id));
    await db
      .update(actions)
      .set({ status: 'failed', dispatchState: 'unknown', dispatchedAt: new Date() })
      .where(eq(actions.id, out.action_id));

    registry.invocations.length = 0;
    await assert.rejects(
      svc.retry({ orgId, actionId: out.action_id, operatorId: 'op' }),
      /older than 24h/,
    );
    assert.equal(registry.invocations.length, 0, 'the connector was not called');
  });

  it('retry: uses the mode recorded at attempt time, not the connector today', async () => {
    // A connector can be changed between the attempt and the retry. What
    // governed the effect is what it declared when it ran.
    policy.decision = makeDecision({ effect: 'allow' });
    registry.idempotencyMode = 'none';
    registry.result = { ok: false, error: { code: 'timeout', message: 'gone' } };
    const out = await execute('t.t', {});
    await db
      .update(actions)
      .set({ status: 'failed', dispatchState: 'unknown' })
      .where(eq(actions.id, out.action_id));

    // Connector now claims it is safe. The recorded attempt says otherwise.
    registry.idempotencyMode = 'key';
    registry.invocations.length = 0;
    await assert.rejects(
      svc.retry({ orgId, actionId: out.action_id, operatorId: 'op' }),
      /does not support idempotent retry/,
    );
    assert.equal(registry.invocations.length, 0);
  });

  it('records what the gate believed the action would do, as evidence', async () => {
    // An incident asks "why was this allowed?". The honest answer depends on
    // what the classifier said WHEN THE POLICY RAN — not on what it would say
    // today after a rule change. Recomputing at read time rewrites history.
    policy.decision = makeDecision({ effect: 'allow' });
    registry.assessResult = {
      effectClass: 'publish',
      reversible: false,
      summary: 'Publishes a package to a public registry',
    };
    const out = await execute('t.t', {});

    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, out.action_id));
    assert.deepEqual(row!.effectAssessment, {
      effectClass: 'publish',
      reversible: false,
      summary: 'Publishes a package to a public registry',
    });
  });

  it('records the assessment on denied and awaiting_approval too', async () => {
    registry.assessResult = {
      effectClass: 'infra_write',
      reversible: false,
      summary: 'Destroys provisioned infrastructure',
    };
    policy.decision = makeDecision({ effect: 'deny', reason: 'no' });
    const denied = await execute('t.t', {});
    const [d] = await db.select().from(actions).where(eq(actions.id, denied.action_id));
    assert.equal(
      (d!.effectAssessment as { effectClass: string } | null)?.effectClass,
      'infra_write',
    );

    policy.decision = makeDecision({ effect: 'require_approval' });
    const held = await execute('t.t', {});
    const [h] = await db.select().from(actions).where(eq(actions.id, held.action_id));
    assert.equal(
      (h!.effectAssessment as { reversible: boolean } | null)?.reversible,
      false,
    );
  });

  it('leaves the assessment null when the connector cannot classify', async () => {
    registry.assessResult = null;
    policy.decision = makeDecision({ effect: 'allow' });
    const out = await execute('t.t', {});
    const [row] = await db.select().from(actions).where(eq(actions.id, out.action_id));
    assert.equal(row!.effectAssessment, null, 'no invented default');
  });

  it('an assessment that throws denies, even when the policy default is allow', async () => {
    // CWE-863. Returning "no assessment" here would stop effect-scoped
    // require_approval rules from matching, and on a permissive default the
    // action would dispatch unreviewed.
    policy.decision = makeDecision({ effect: 'allow' });
    registry.assessThrows = true;
    registry.invocations.length = 0;

    const out = await execute('t.t', {});
    assert.equal(out.status, 'denied');
    assert.match(out.policy_decision.reason ?? '', /assessment failed/);
    assert.equal(registry.invocations.length, 0, 'nothing was dispatched');

    const events = await db.select().from(auditLog).where(eq(auditLog.orgId, orgId));
    assert.ok(events.some((e) => e.eventType === 'action.assessment_failed'));
  });

  it('retry: allows an unknown dispatch when the provider honours idempotency', async () => {
    policy.decision = makeDecision({ effect: 'allow' });
    // Declared BEFORE the first attempt, so the recorded receipt says 'key' —
    // which is what the guard now reads.
    registry.idempotencyMode = 'key';
    registry.result = { ok: false, error: { code: 'timeout', message: 'gone' } };
    const out = await execute('t.t', {});
    await db
      .update(actions)
      .set({ status: 'failed', dispatchState: 'unknown' })
      .where(eq(actions.id, out.action_id));

    // A provider that collapses our retry into the original request makes the
    // re-send safe, so the guard must not block it.
    registry.result = { ok: true, data: {} };
    const retried = await svc.retry({
      orgId,
      actionId: out.action_id,
      operatorId: 'op',
    });
    assert.equal(retried.status, 'executed');
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

  // ---------------------------------------------------------------------
  // Effect safety. These are the tests that make the product claim true:
  // the idempotency key bounds the SIDE EFFECT, not merely the record of it.
  // ---------------------------------------------------------------------

  it('concurrent executes sharing an idempotency key invoke the connector once', async () => {
    registry.delayMs = 120; // hold the connector open so all callers overlap
    const key = `idem-${randomUUID()}`;

    const settled = await Promise.all(
      Array.from({ length: 8 }, () =>
        svc.execute({
          orgId,
          agentId,
          tool: 'gmail.send',
          params: { to: 'cto@globex.com' },
          idempotencyKey: key,
        }),
      ),
    );

    // The claim. Eight concurrent agent retries, one email.
    assert.equal(
      registry.invocations.length,
      1,
      `expected exactly one connector call, got ${registry.invocations.length}`,
    );

    // And exactly one action row owns the key.
    const rows = await db
      .select()
      .from(actions)
      .where(eq(actions.idempotencyKey, key));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.dispatchState, 'settled');
    assert.equal(rows[0]!.status, 'executed');

    // Every caller gets a coherent answer pointing at that one action.
    for (const r of settled) {
      assert.equal(r.action_id, rows[0]!.id);
    }
  });

  it('reserves the action row before the connector is invoked', async () => {
    let stateDuringInvoke: string | null = null;
    const key = `idem-${randomUUID()}`;
    registry.resolveAlways = false; // replaced below

    const probing: Connector = {
      name: 'probe',
      supports: () => true,
      invoke: async () => {
        // Mid-flight: the row must already exist and be marked in_flight, so a
        // crash right here is recoverable rather than invisible.
        const [row] = await db
          .select()
          .from(actions)
          .where(eq(actions.idempotencyKey, key));
        stateDuringInvoke = row?.dispatchState ?? null;
        return { ok: true, data: {} };
      },
    };
    registry.resolve = () => probing;

    await svc.execute({
      orgId,
      agentId,
      tool: 'gmail.send',
      params: {},
      idempotencyKey: key,
    });

    assert.equal(stateDuringInvoke, 'in_flight');
  });

  it('marks a dispatch that never settled as unknown and does not retry it', async () => {
    const key = `idem-${randomUUID()}`;
    const [stuck] = await db
      .insert(actions)
      .values({
        orgId,
        agentId,
        tool: 'gmail.send',
        params: {},
        status: 'pending',
        policyDecision: makeDecision() as unknown as Record<string, unknown>,
        idempotencyKey: key,
        dispatchState: 'in_flight',
        dispatchedAt: new Date(Date.now() - 60 * 60 * 1000), // an hour ago
      })
      .returning();

    const swept = await svc.reconcileStaleDispatches(5 * 60 * 1000);
    assert.equal(swept, 1);

    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, stuck!.id));
    assert.equal(row!.dispatchState, 'unknown');
    assert.equal(row!.status, 'failed');
    const res = row!.result as { error: { code: string } };
    assert.equal(res.error.code, 'dispatch_unknown');
    // Critically: the sweeper resolved state without calling the connector.
    assert.equal(registry.invocations.length, 0);
  });

  it('leaves a fresh in-flight dispatch alone', async () => {
    await db.insert(actions).values({
      orgId,
      agentId,
      tool: 'gmail.send',
      params: {},
      status: 'pending',
      policyDecision: makeDecision() as unknown as Record<string, unknown>,
      dispatchState: 'in_flight',
      dispatchedAt: new Date(), // just now — still legitimately running
    });
    assert.equal(await svc.reconcileStaleDispatches(5 * 60 * 1000), 0);
  });

  it('a reservation that never reaches its next update is still sweepable', async () => {
    // The reservation persists `in_flight` in the same insert that claims the
    // key, rather than inserting `not_dispatched` and transitioning in a second
    // statement. This kills the first `update` the service issues, standing in
    // for a process that dies right there. If the dispatch state depended on
    // that update, the row would strand at `not_dispatched`: the sweeper only
    // looks at `in_flight` and retry() only accepts `failed`, so nothing would
    // ever resolve it and same-key replays would return `pending` forever.
    const key = `idem-${randomUUID()}`;
    let updates = 0;
    const brittleDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return (...args: unknown[]) => {
            if (++updates === 1) {
              throw new Error('process died before the next update landed');
            }
            return (target.update as (...a: unknown[]) => unknown)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const brittle = new ActionsService(
      brittleDb,
      audit,
      policy as unknown as PolicyService,
      registry as unknown as ConnectorRegistry,
      slack as unknown as SlackService,
      rateLimit as unknown as RateLimitService,
      makeEffects(),
      new EffectReceiptsService(db, audit),
    );

    await assert.rejects(
      brittle.execute({
        orgId,
        agentId,
        tool: 'gmail.send',
        params: {},
        idempotencyKey: key,
      }),
    );

    const [stranded] = await db
      .select()
      .from(actions)
      .where(eq(actions.idempotencyKey, key));
    assert.equal(stranded!.dispatchState, 'in_flight');
    assert.ok(stranded!.dispatchedAt, 'dispatchedAt must be set for the sweeper');

    // Therefore reachable by reconciliation rather than stuck forever. The
    // sweeper is global, so assert on this row rather than the total count —
    // concurrent suites leave in-flight rows of their own.
    assert.ok((await svc.reconcileStaleDispatches(0)) >= 1);
    const [swept] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, stranded!.id));
    assert.equal(swept!.dispatchState, 'unknown');
    assert.equal(swept!.status, 'failed');
  });

  it('concurrent require_approval sharing a key posts one card and one approval', async () => {
    // recordAction() does not call a connector, but losing the key race still
    // matters: the loser used to go on and insert a second approval row and
    // post a second Slack card for the winner's action.
    policy.decision = makeDecision({
      effect: 'require_approval',
      approver_role: 'approver',
      reason: 'high value',
    });
    slack.isConfiguredValue = true;
    slack.postedCard = { channel: 'C123', ts: '1.1' };
    const key = `idem-${randomUUID()}`;

    const settled = await Promise.all(
      Array.from({ length: 8 }, () =>
        svc.execute({
          orgId,
          agentId,
          tool: 'hubspot.deals.update',
          params: { amount: 60000 },
          idempotencyKey: key,
        }),
      ),
    );

    const rows = await db
      .select()
      .from(actions)
      .where(eq(actions.idempotencyKey, key));
    assert.equal(rows.length, 1, 'one action row owns the key');
    const actionId = rows[0]!.id;

    const approvalRows = await db
      .select()
      .from(approvals)
      .where(eq(approvals.actionId, actionId));
    assert.equal(approvalRows.length, 1, 'one approval, not one per caller');

    assert.equal(slack.posts.length, 1, 'one Slack card, not eight');

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const awaiting = events.filter(
      (e) => e.eventType === 'action.awaiting_approval',
    );
    assert.equal(awaiting.length, 1, 'one audit event for one action');

    // Every caller still gets a coherent answer pointing at that action.
    for (const r of settled) {
      assert.equal(r.action_id, actionId);
      assert.equal(r.status, 'awaiting_approval');
    }
  });

  it('refuses a concurrent retry of the same failed action', async () => {
    registry.result = {
      ok: false,
      error: { code: 'http_503', message: 'upstream down' },
    };
    const first = await execute('t.t', {});
    registry.delayMs = 120;
    registry.result = { ok: true, data: {} };
    registry.invocations.length = 0;

    const outcomes = await Promise.allSettled([
      svc.retry({ orgId, actionId: first.action_id, operatorId: 'op-a' }),
      svc.retry({ orgId, actionId: first.action_id, operatorId: 'op-b' }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one retry should win');
    assert.equal(rejected.length, 1, 'the loser should be rejected, not queued');
    assert.equal(registry.invocations.length, 1, 'one connector call only');
  });
});

describe('ActionsService.listForOrg — what a reviewer can see', () => {
  // The review surface has to distinguish "it did not happen" from "nobody
  // knows". The sweeper marks a never-settled dispatch `failed`, so status
  // alone actively misleads on the one case where being wrong is expensive.
  let orgId: string;
  let agentId: string;
  let svc: ActionsService;

  beforeEach(async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug: `vis-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;
    const [agent] = await db
      .insert(agents)
      .values({ orgId, name: 'vis-agent' })
      .returning();
    agentId = agent!.id;
    svc = new ActionsService(
      db,
      audit,
      new StubPolicy() as unknown as PolicyService,
      new StubRegistry() as unknown as ConnectorRegistry,
      new StubSlack() as unknown as SlackService,
      new StubRateLimit() as unknown as RateLimitService,
      makeEffects(),
      new EffectReceiptsService(db, audit),
    );
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('exposes dispatch_state so an unknown outcome is distinguishable', async () => {
    const [row] = await db
      .insert(actions)
      .values({
        orgId,
        agentId,
        tool: 'shell.run',
        params: { command: 'npm publish' },
        status: 'failed',
        dispatchState: 'unknown',
        policyDecision: makeDecision() as unknown as Record<string, unknown>,
      })
      .returning();

    const listed = (await svc.listForOrg(orgId)).items.find((i) => i.id === row!.id);
    assert.ok(listed);
    assert.equal(listed!.status, 'failed');
    assert.equal(
      listed!.dispatch_state,
      'unknown',
      'without this the row is indistinguishable from a genuine failure',
    );
  });

  it('exposes the recorded effect assessment', async () => {
    const [row] = await db
      .insert(actions)
      .values({
        orgId,
        agentId,
        tool: 'shell.run',
        params: {},
        status: 'executed',
        dispatchState: 'settled',
        effectAssessment: {
          effectClass: 'publish',
          reversible: false,
          summary: 'Publishes a package to a public registry',
        },
        policyDecision: makeDecision() as unknown as Record<string, unknown>,
      })
      .returning();

    const listed = (await svc.listForOrg(orgId)).items.find((i) => i.id === row!.id);
    assert.equal(listed!.effect_assessment?.reversible, false);
    assert.equal(listed!.effect_assessment?.effectClass, 'publish');
  });

  it('leaves both null-ish for rows that predate the columns', async () => {
    const [row] = await db
      .insert(actions)
      .values({
        orgId,
        agentId,
        tool: 'hubspot.deals.update',
        params: {},
        status: 'executed',
        policyDecision: makeDecision() as unknown as Record<string, unknown>,
      })
      .returning();
    const listed = (await svc.listForOrg(orgId)).items.find((i) => i.id === row!.id);
    assert.equal(listed!.effect_assessment, null);
    assert.equal(listed!.dispatch_state, 'not_dispatched');
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
      makeEffects(),
      new EffectReceiptsService(db, audit),
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
