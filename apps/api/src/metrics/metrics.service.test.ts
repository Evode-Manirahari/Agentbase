// Integration tests for MetricsService — exercise SQL aggregations against a
// real Postgres. Each test uses a unique org for isolation.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, orgs, agents, actions } from '@agentbase/db';
import { MetricsService } from './metrics.service.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://agentbase:agentbase@localhost:5433/agentbase';

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

before(() => {
  client = postgres(DB_URL, { max: 5 });
  db = drizzle(client, { schema });
});

after(async () => {
  await client.end();
});

describe('MetricsService.overview', () => {
  let orgId: string;
  let agentId: string;
  let agentBId: string;
  let svc: MetricsService;

  beforeEach(async () => {
    const slug = `met-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: 'metrics-org', slug })
      .returning();
    orgId = org!.id;
    const [a, b] = await Promise.all([
      db.insert(agents).values({ orgId, name: 'agent-a' }).returning(),
      db.insert(agents).values({ orgId, name: 'agent-b' }).returning(),
    ]);
    agentId = a[0]!.id;
    agentBId = b[0]!.id;
    svc = new MetricsService(db);
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  async function insertAction(opts: {
    agentId?: string;
    tool?: string;
    status: 'executed' | 'failed' | 'denied' | 'awaiting_approval' | 'approved';
    result?: Record<string, unknown> | null;
    policyDecision?: Record<string, unknown> | null;
    createdAt?: Date;
    dispatchState?: 'not_dispatched' | 'in_flight' | 'settled' | 'unknown';
  }) {
    await db.insert(actions).values({
      orgId,
      agentId: opts.agentId ?? agentId,
      tool: opts.tool ?? 't.tool',
      params: {},
      status: opts.status,
      result: opts.result ?? null,
      policyDecision: opts.policyDecision ?? null,
      ...(opts.dispatchState ? { dispatchState: opts.dispatchState } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
  }

  // An unknown dispatch is recorded status=failed because the action did not
  // complete. Counting it as a failure asserts nothing happened, which is
  // precisely what nobody knows — and it buries the number an operator needs.
  describe('unknown dispatches are not failures', () => {
    it('counts them separately and keeps them out of failure_rate', async () => {
      await insertAction({ status: 'executed' });
      await insertAction({ status: 'executed' });
      await insertAction({ status: 'failed' }); // a real failure
      await insertAction({ status: 'failed', dispatchState: 'unknown' });
      await insertAction({ status: 'failed', dispatchState: 'unknown' });

      const m = await svc.overview(orgId);
      assert.equal(m.total, 5);
      assert.equal(m.indeterminate_count, 2);
      // 1 genuine failure out of 5, not 3 of 5.
      assert.equal(m.failure_rate, 1 / 5);
    });

    it('is zero when nothing is quarantined', async () => {
      await insertAction({ status: 'executed' });
      await insertAction({ status: 'failed' });
      const m = await svc.overview(orgId);
      assert.equal(m.indeterminate_count, 0);
      assert.equal(m.failure_rate, 1 / 2, 'real failures still counted');
    });

    it('never reports a negative failure rate', async () => {
      // The two counts come from separate queries, so a row can settle
      // between them. Clamped rather than allowed to go negative.
      await insertAction({ status: 'executed', dispatchState: 'unknown' });
      const m = await svc.overview(orgId);
      assert.ok(m.failure_rate >= 0);
    });
  });

  it('empty org → all zeros, empty top arrays', async () => {
    const m = await svc.overview(orgId);
    assert.equal(m.total, 0);
    assert.equal(m.deny_rate, 0);
    assert.equal(m.failure_rate, 0);
    assert.equal(m.rate_limited_count, 0);
    assert.equal(m.indeterminate_count, 0);
    assert.deepEqual(m.top_tools, []);
    assert.deepEqual(m.top_agents, []);
    // by_status is fully populated even when empty (so the UI doesn't have
    // to special-case missing keys).
    assert.equal(m.by_status.executed, 0);
    assert.equal(m.by_status.denied, 0);
  });

  it('totals + per-status + rates', async () => {
    await insertAction({ status: 'executed' });
    await insertAction({ status: 'executed' });
    await insertAction({ status: 'executed' });
    await insertAction({ status: 'executed' });
    await insertAction({ status: 'failed' });
    await insertAction({ status: 'failed' });
    await insertAction({ status: 'denied' });
    await insertAction({ status: 'awaiting_approval' });

    const m = await svc.overview(orgId);
    assert.equal(m.total, 8);
    assert.equal(m.by_status.executed, 4);
    assert.equal(m.by_status.failed, 2);
    assert.equal(m.by_status.denied, 1);
    assert.equal(m.by_status.awaiting_approval, 1);
    assert.equal(Math.round(m.deny_rate * 1000) / 1000, 0.125); // 1/8
    assert.equal(Math.round(m.failure_rate * 1000) / 1000, 0.25); // 2/8
  });

  it('rate_limited_count: counts only rows with result.error.code=rate_limited', async () => {
    await insertAction({
      status: 'failed',
      result: { ok: false, error: { code: 'rate_limited' } },
    });
    await insertAction({
      status: 'failed',
      result: { ok: false, error: { code: 'rate_limited' } },
    });
    // Different error — should NOT be counted as rate-limited.
    await insertAction({
      status: 'failed',
      result: { ok: false, error: { code: 'http_503' } },
    });
    // Successful — should not be counted.
    await insertAction({ status: 'executed', result: { ok: true } });

    const m = await svc.overview(orgId);
    assert.equal(m.rate_limited_count, 2);
    assert.equal(m.by_status.failed, 3);
  });

  it('top_tools: top 5 ordered by count desc', async () => {
    for (let i = 0; i < 7; i++) await insertAction({ tool: 'a.x', status: 'executed' });
    for (let i = 0; i < 4; i++) await insertAction({ tool: 'b.y', status: 'executed' });
    for (let i = 0; i < 2; i++) await insertAction({ tool: 'c.z', status: 'executed' });
    await insertAction({ tool: 'd.w', status: 'executed' });
    await insertAction({ tool: 'e.q', status: 'executed' });
    await insertAction({ tool: 'f.r', status: 'executed' });

    const m = await svc.overview(orgId);
    assert.equal(m.top_tools.length, 5);
    assert.equal(m.top_tools[0]!.tool, 'a.x');
    assert.equal(m.top_tools[0]!.count, 7);
    assert.equal(m.top_tools[1]!.tool, 'b.y');
    assert.equal(m.top_tools[1]!.count, 4);
    // f.r is the 6th most frequent (1 each for d/e/f); not in top 5.
    assert.ok(!m.top_tools.find((t) => t.tool === 'f.r'));
  });

  it('top_agents: returns id + name, ordered by count desc', async () => {
    for (let i = 0; i < 5; i++) await insertAction({ agentId, status: 'executed' });
    for (let i = 0; i < 3; i++) await insertAction({ agentId: agentBId, status: 'executed' });

    const m = await svc.overview(orgId);
    assert.equal(m.top_agents.length, 2);
    assert.equal(m.top_agents[0]!.agent_id, agentId);
    assert.equal(m.top_agents[0]!.agent_name, 'agent-a');
    assert.equal(m.top_agents[0]!.count, 5);
    assert.equal(m.top_agents[1]!.agent_name, 'agent-b');
    assert.equal(m.top_agents[1]!.count, 3);
  });

  it('respects window: rows outside the window are excluded', async () => {
    const recent = new Date(Date.now() - 1 * 3600_000); // 1h ago
    const old = new Date(Date.now() - 48 * 3600_000); // 48h ago

    await insertAction({ status: 'executed', createdAt: recent });
    await insertAction({ status: 'executed', createdAt: recent });
    await insertAction({ status: 'failed', createdAt: old });
    await insertAction({ status: 'denied', createdAt: old });

    const m24 = await svc.overview(orgId, 24);
    assert.equal(m24.total, 2);
    assert.equal(m24.by_status.executed, 2);
    assert.equal(m24.by_status.failed, 0);

    const m72 = await svc.overview(orgId, 72);
    assert.equal(m72.total, 4);
    assert.equal(m72.by_status.failed, 1);
    assert.equal(m72.by_status.denied, 1);
  });

  it('approval_rate: null when no require_approval actions exist', async () => {
    await insertAction({ status: 'executed' });
    await insertAction({ status: 'denied' }); // policy-deny, not human-deny

    const m = await svc.overview(orgId);
    assert.equal(m.approval_rate, null);
    assert.equal(m.approval_stats.require_approval_total, 0);
  });

  it('approval_rate: counts only actions whose policy required approval', async () => {
    const requireApproval = { effect: 'require_approval', reason: 'high-value deal' };
    // 3 approved, 1 denied by human, 1 still awaiting
    await insertAction({ status: 'executed', policyDecision: requireApproval });
    await insertAction({ status: 'executed', policyDecision: requireApproval });
    await insertAction({ status: 'approved', policyDecision: requireApproval });
    await insertAction({ status: 'denied', policyDecision: requireApproval });
    await insertAction({ status: 'awaiting_approval', policyDecision: requireApproval });
    // Plus a policy-deny (effect=deny) — must NOT skew the approval rate.
    await insertAction({
      status: 'denied',
      policyDecision: { effect: 'deny', reason: 'destructive op' },
    });

    const m = await svc.overview(orgId);
    assert.equal(m.approval_stats.require_approval_total, 5);
    assert.equal(m.approval_stats.approved, 3);
    assert.equal(m.approval_stats.denied, 1);
    assert.equal(m.approval_stats.pending, 1);
    // 3 approved / 4 decided
    assert.equal(Math.round((m.approval_rate ?? 0) * 1000) / 1000, 0.75);
  });

  it('top_policy_rules: ranks (reason, effect) tuples by count', async () => {
    const r1 = { effect: 'require_approval', reason: 'high-value deal' };
    const r2 = { effect: 'allow', reason: 'enrichment is read-only' };
    const r3 = { effect: 'deny', reason: 'deletes are blocked' };
    for (let i = 0; i < 6; i++)
      await insertAction({ status: 'awaiting_approval', policyDecision: r1 });
    for (let i = 0; i < 4; i++)
      await insertAction({ status: 'executed', policyDecision: r2 });
    for (let i = 0; i < 2; i++)
      await insertAction({ status: 'denied', policyDecision: r3 });
    // Action with no policy_decision must not appear.
    await insertAction({ status: 'executed', policyDecision: null });

    const m = await svc.overview(orgId);
    assert.equal(m.top_policy_rules.length, 3);
    assert.equal(m.top_policy_rules[0]!.reason, 'high-value deal');
    assert.equal(m.top_policy_rules[0]!.effect, 'require_approval');
    assert.equal(m.top_policy_rules[0]!.count, 6);
    assert.equal(m.top_policy_rules[1]!.reason, 'enrichment is read-only');
    assert.equal(m.top_policy_rules[1]!.effect, 'allow');
    assert.equal(m.top_policy_rules[2]!.reason, 'deletes are blocked');
    assert.equal(m.top_policy_rules[2]!.effect, 'deny');
  });

  it('cross-org isolation: another org\'s rows do not leak in', async () => {
    const otherSlug = `met-other-${randomUUID().slice(0, 8)}`;
    const [otherOrg] = await db
      .insert(orgs)
      .values({ name: 'other', slug: otherSlug })
      .returning();
    try {
      const [otherAgent] = await db
        .insert(agents)
        .values({ orgId: otherOrg!.id, name: 'other-agent' })
        .returning();

      await db.insert(actions).values({
        orgId: otherOrg!.id,
        agentId: otherAgent!.id,
        tool: 'other.tool',
        params: {},
        status: 'executed',
      });
      await insertAction({ status: 'executed' });

      const m = await svc.overview(orgId);
      assert.equal(m.total, 1);
      assert.equal(m.top_tools.length, 1);
      assert.equal(m.top_tools[0]!.tool, 't.tool');
    } finally {
      await db.delete(orgs).where(eq(orgs.id, otherOrg!.id));
    }
  });
});

describe('MetricsService.timeseries', () => {
  let orgId: string;
  let agentAId: string;
  let agentBId: string;
  let svc: MetricsService;

  beforeEach(async () => {
    const slug = `met-ts-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: 'ts-org', slug })
      .returning();
    orgId = org!.id;
    const [a, b] = await Promise.all([
      db.insert(agents).values({ orgId, name: 'agent-a' }).returning(),
      db.insert(agents).values({ orgId, name: 'agent-b' }).returning(),
    ]);
    agentAId = a[0]!.id;
    agentBId = b[0]!.id;
    svc = new MetricsService(db);
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  async function insertAt(agentId: string, when: Date) {
    await db.insert(actions).values({
      orgId,
      agentId,
      tool: 't.tool',
      params: {},
      status: 'executed',
      createdAt: when,
    });
  }

  it('produces dense buckets even when an agent has no activity on some days', async () => {
    // Window of 3 days, two agents, agent-a has activity on day 0 and 2,
    // agent-b only on day 1.
    const now = new Date();
    const day0 = new Date(now.getTime() - 2 * 86400_000);
    const day1 = new Date(now.getTime() - 1 * 86400_000);
    const day2 = now;

    await insertAt(agentAId, day0);
    await insertAt(agentAId, day0);
    await insertAt(agentBId, day1);
    await insertAt(agentAId, day2);

    const ts = await svc.timeseries(orgId, 72);
    assert.equal(ts.bucket, 'day');
    assert.equal(ts.buckets.length, 3);
    assert.equal(ts.series.length, 2);

    const a = ts.series.find((s) => s.agent_name === 'agent-a')!;
    const b = ts.series.find((s) => s.agent_name === 'agent-b')!;
    assert.deepEqual(a.counts, [2, 0, 1]);
    assert.deepEqual(b.counts, [0, 1, 0]);
  });

  it('excludes rows outside the window', async () => {
    const now = new Date();
    const inside = new Date(now.getTime() - 1 * 86400_000);
    const outside = new Date(now.getTime() - 10 * 86400_000);

    await insertAt(agentAId, inside);
    await insertAt(agentAId, outside);

    const ts = await svc.timeseries(orgId, 72);
    const totals = ts.series[0]!.counts.reduce((s, n) => s + n, 0);
    assert.equal(totals, 1);
  });

  it('clamps window: 0h floored to 1 day, 1000h capped to 30 days', async () => {
    const tsTooSmall = await svc.timeseries(orgId, 0);
    assert.equal(tsTooSmall.buckets.length, 1);

    const tsTooBig = await svc.timeseries(orgId, 24 * 1000);
    assert.equal(tsTooBig.buckets.length, 30);
  });
});
