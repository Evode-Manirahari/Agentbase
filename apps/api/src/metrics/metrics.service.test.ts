// Integration tests for MetricsService — exercise SQL aggregations against a
// real Postgres. Each test uses a unique org for isolation.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, orgs, agents, actions } from '@dejavas/db';
import { MetricsService } from './metrics.service.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://dejavas:dejavas@localhost:5433/dejavas';

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
    status: 'executed' | 'failed' | 'denied' | 'awaiting_approval';
    result?: Record<string, unknown> | null;
    createdAt?: Date;
  }) {
    await db.insert(actions).values({
      orgId,
      agentId: opts.agentId ?? agentId,
      tool: opts.tool ?? 't.tool',
      params: {},
      status: opts.status,
      result: opts.result ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
  }

  it('empty org → all zeros, empty top arrays', async () => {
    const m = await svc.overview(orgId);
    assert.equal(m.total, 0);
    assert.equal(m.deny_rate, 0);
    assert.equal(m.failure_rate, 0);
    assert.equal(m.rate_limited_count, 0);
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
