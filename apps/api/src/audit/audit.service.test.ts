// Integration tests for AuditService — exercise filter behavior against real
// Postgres. Each test uses a unique org for isolation.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, orgs, auditLog } from '@dejavas/db';
import { AuditService } from './audit.service.js';

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

describe('AuditService', () => {
  let orgId: string;
  let svc: AuditService;

  beforeEach(async () => {
    const slug = `aud-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: 'aud-org', slug })
      .returning();
    orgId = org!.id;
    svc = new AuditService(db);
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  async function emit(
    eventType: string,
    actorType: 'agent' | 'user' | 'system' = 'agent',
    createdAt?: Date,
    payload: Record<string, unknown> = {},
  ) {
    if (createdAt) {
      // Skip the service to set explicit timestamps for the window test.
      await db.insert(auditLog).values({
        orgId,
        actorType,
        actorId: 'a',
        eventType,
        payload,
        createdAt,
      });
    } else {
      await svc.record({
        orgId,
        actorType,
        actorId: 'a',
        eventType,
        payload,
      });
    }
  }

  it('listForOrg with no filter returns all rows desc by createdAt', async () => {
    await emit('action.executed');
    await emit('action.failed');
    await emit('approval.approved');
    const rows = await svc.listForOrg(orgId);
    assert.equal(rows.length, 3);
    // most recent first — last emit should be at index 0
    assert.equal(rows[0]!.eventType, 'approval.approved');
  });

  it('filter by eventType narrows the result set', async () => {
    await emit('action.executed');
    await emit('action.executed');
    await emit('action.failed');
    await emit('approval.approved');
    const rows = await svc.listForOrg(orgId, 100, { eventType: 'action.executed' });
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.eventType, 'action.executed');
  });

  it('filter by actorType excludes other actors', async () => {
    await emit('action.executed', 'agent');
    await emit('action.retried', 'user');
    await emit('approval.expired', 'system');
    const userOnly = await svc.listForOrg(orgId, 100, { actorType: 'user' });
    assert.equal(userOnly.length, 1);
    assert.equal(userOnly[0]!.eventType, 'action.retried');
  });

  it('filter by since: only events at-or-after the cutoff', async () => {
    const old = new Date(Date.now() - 48 * 3600_000);
    const recent = new Date(Date.now() - 1 * 3600_000);
    await emit('action.executed', 'agent', old);
    await emit('action.executed', 'agent', recent);
    const since24h = new Date(Date.now() - 24 * 3600_000);
    const rows = await svc.listForOrg(orgId, 100, { since: since24h });
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.createdAt >= since24h);
  });

  it('filter by until: only events at-or-before the cutoff', async () => {
    const old = new Date(Date.now() - 48 * 3600_000);
    const recent = new Date(Date.now() - 1 * 3600_000);
    await emit('a.x', 'agent', old);
    await emit('a.x', 'agent', recent);
    const cutoff = new Date(Date.now() - 24 * 3600_000);
    const rows = await svc.listForOrg(orgId, 100, { until: cutoff });
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.createdAt <= cutoff);
  });

  it('combined filters AND together (eventType + actorType)', async () => {
    await emit('action.executed', 'agent');
    await emit('action.executed', 'user');
    await emit('action.failed', 'agent');
    const rows = await svc.listForOrg(orgId, 100, {
      eventType: 'action.executed',
      actorType: 'agent',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.eventType, 'action.executed');
    assert.equal(rows[0]!.actorType, 'agent');
  });

  it('listEventTypes returns distinct types alphabetical, scoped to org', async () => {
    await emit('z.last');
    await emit('a.first');
    await emit('a.first'); // duplicate — distinct should drop
    await emit('m.middle');
    const types = await svc.listEventTypes(orgId);
    assert.deepEqual(types, ['a.first', 'm.middle', 'z.last']);

    // Cross-org: another org's events do not leak.
    const otherSlug = `aud-other-${randomUUID().slice(0, 8)}`;
    const [other] = await db
      .insert(orgs)
      .values({ name: 'other', slug: otherSlug })
      .returning();
    try {
      await db.insert(auditLog).values({
        orgId: other!.id,
        actorType: 'agent',
        actorId: 'x',
        eventType: 'should.not.appear',
        payload: {},
      });
      const stillThree = await svc.listEventTypes(orgId);
      assert.deepEqual(stillThree, ['a.first', 'm.middle', 'z.last']);
    } finally {
      await db.delete(orgs).where(eq(orgs.id, other!.id));
    }
  });

  it('limit cap honored even with filters applied', async () => {
    for (let i = 0; i < 10; i++) await emit('e.t');
    const rows = await svc.listForOrg(orgId, 3, { eventType: 'e.t' });
    assert.equal(rows.length, 3);
  });

  it('exportForOrg applies filters, maxRows, ordering, and preserves payloads', async () => {
    const old = new Date(Date.now() - 3 * 3600_000);
    const newer = new Date(Date.now() - 2 * 3600_000);
    const newest = new Date(Date.now() - 1 * 3600_000);
    await emit('action.executed', 'agent', old, { tool: 'gmail.send' });
    await emit('action.executed', 'user', newer, { tool: 'hubspot.deals.update' });
    await emit('action.failed', 'agent', newest, { tool: 'apollo.people.search' });

    const rows = await svc.exportForOrg(
      orgId,
      { eventType: 'action.executed' },
      { maxRows: 1 },
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.eventType, 'action.executed');
    assert.equal(rows[0]!.actorType, 'user');
    assert.deepEqual(rows[0]!.payload, { tool: 'hubspot.deals.update' });
  });
});
