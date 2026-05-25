// Integration tests for WebhookService — exercise the dispatch fan-out (DB
// queries against subscriptions) and delivery path (real HTTP server, real
// HMAC signing). BullMQ is stubbed via a fake Queue so we test enqueue
// behavior without booting a worker.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import {
  schema,
  orgs,
  webhookSubscriptions,
} from '@agentbase/db';
import { sign, WebhookService, WEBHOOK_DELIVER_JOB } from './webhook.service.js';
import type { Queue } from 'bullmq';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://agentbase:agentbase@localhost:5433/agentbase';

class StubQueue {
  added: Array<{ name: string; data: unknown; opts: unknown }> = [];
  async add(name: string, data: unknown, opts?: unknown) {
    this.added.push({ name, data, opts });
  }
}

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

before(() => {
  client = postgres(DB_URL, { max: 5 });
  db = drizzle(client, { schema });
});

after(async () => {
  await client.end();
});

function startReceiver(): Promise<{
  url: string;
  hits: Array<{ headers: Record<string, string>; body: string; status: number }>;
  setStatus: (n: number) => void;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const hits: Array<{
      headers: Record<string, string>;
      body: string;
      status: number;
    }> = [];
    let nextStatus = 200;
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
        hits.push({ headers, body, status: nextStatus });
        res.statusCode = nextStatus;
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port =
        typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        hits,
        setStatus: (n) => {
          nextStatus = n;
        },
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('WebhookService.sign — HMAC contract', () => {
  it('produces a stable hex digest for the (timestamp, body, secret) tuple', () => {
    const sig = sign('s3cr3t', '1700000000', '{"a":1}');
    // Stable golden value — receivers can verify by recomputing.
    assert.match(sig, /^[a-f0-9]{64}$/);
    assert.equal(sign('s3cr3t', '1700000000', '{"a":1}'), sig);
  });

  it('flips for any byte change', () => {
    const a = sign('s', '1', '{}');
    assert.notEqual(a, sign('s', '2', '{}'));
    assert.notEqual(a, sign('s', '1', '{ }'));
    assert.notEqual(a, sign('s2', '1', '{}'));
  });
});

describe('WebhookService', () => {
  let orgId: string;
  let svc: WebhookService;
  let queue: StubQueue;

  beforeEach(async () => {
    const slug = `wh-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: 'wh-org', slug })
      .returning();
    orgId = org!.id;
    queue = new StubQueue();
    svc = new WebhookService(db, queue as unknown as Queue);
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('create returns the secret exactly once and persists the row', async () => {
    const sub = await svc.create({
      orgId,
      name: 'pagerduty',
      url: 'https://example.com/hook',
      events: ['action.failed'],
    });
    assert.match(sub.secret, /^dws_[a-f0-9]+$/);
    assert.equal(sub.events.length, 1);

    // list does NOT return the secret
    const items = (await svc.list(orgId)).items;
    assert.equal(items.length, 1);
    assert.ok(!('secret' in items[0]!));
  });

  it('dispatch enqueues a delivery job per matching enabled subscription', async () => {
    await svc.create({
      orgId,
      name: 'A',
      url: 'http://x/A',
      events: ['action.failed'],
    });
    await svc.create({
      orgId,
      name: 'B',
      url: 'http://x/B',
      events: ['action.executed'],
    });
    await svc.create({
      orgId,
      name: 'C-wildcard',
      url: 'http://x/C',
      events: ['*'],
    });

    await svc.dispatch({
      orgId,
      eventType: 'action.failed',
      actorType: 'agent',
      actorId: 'a',
      payload: {},
      occurredAt: new Date().toISOString(),
    });

    // A (matches) and C (wildcard) — but not B (different event).
    assert.equal(queue.added.length, 2);
    assert.deepEqual(
      queue.added.map((j) => j.name).sort(),
      [WEBHOOK_DELIVER_JOB, WEBHOOK_DELIVER_JOB],
    );
  });

  it('dispatch skips disabled subscriptions', async () => {
    const sub = await svc.create({
      orgId,
      name: 'A',
      url: 'http://x/A',
      events: ['*'],
    });
    await svc.update(orgId, sub.id, { enabled: false });
    await svc.dispatch({
      orgId,
      eventType: 'action.failed',
      actorType: 'agent',
      actorId: 'a',
      payload: {},
      occurredAt: new Date().toISOString(),
    });
    assert.equal(queue.added.length, 0);
  });

  it('dispatch is best-effort: queue errors do not throw', async () => {
    await svc.create({
      orgId,
      name: 'A',
      url: 'http://x/A',
      events: ['*'],
    });
    const failingQueue: { add: () => Promise<void> } = {
      add: async () => {
        throw new Error('redis down');
      },
    };
    const flaky = new WebhookService(db, failingQueue as unknown as Queue);
    await flaky.dispatch({
      orgId,
      eventType: 'x',
      actorType: 'agent',
      actorId: 'a',
      payload: {},
      occurredAt: new Date().toISOString(),
    });
    // No throw == passing.
  });

  it('deliver: 2xx response succeeds and marks last_delivery_status', async () => {
    const recv = await startReceiver();
    try {
      const sub = await svc.create({
        orgId,
        name: 'r',
        url: recv.url,
        events: ['*'],
      });
      const out = await svc.deliver({
        subscriptionId: sub.id,
        event: {
          orgId,
          eventType: 'action.failed',
          actorType: 'agent',
          actorId: 'agent-1',
          payload: { tool: 'x' },
          occurredAt: '2026-05-02T00:00:00.000Z',
        },
      });
      assert.equal(out.status, 200);
      assert.equal(recv.hits.length, 1);

      const hit = recv.hits[0]!;
      // Required headers
      assert.equal(hit.headers['x-agentbase-event-type'], 'action.failed');
      assert.equal(hit.headers['x-agentbase-subscription-id'], sub.id);
      assert.match(hit.headers['x-agentbase-timestamp']!, /^\d+$/);
      assert.match(hit.headers['x-agentbase-signature']!, /^sha256=[a-f0-9]{64}$/);
      // HMAC verifies with the returned secret
      const ts = hit.headers['x-agentbase-timestamp']!;
      const expected = sign(sub.secret, ts, hit.body);
      assert.equal(hit.headers['x-agentbase-signature'], `sha256=${expected}`);

      // Persisted state
      const [row] = await db
        .select()
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.id, sub.id));
      assert.equal(row!.lastDeliveryStatus, '200');
      assert.ok(row!.lastDeliveryAt);
    } finally {
      await recv.close();
    }
  });

  it('deliver: 5xx throws (so BullMQ retries) and persists error', async () => {
    const recv = await startReceiver();
    recv.setStatus(503);
    try {
      const sub = await svc.create({
        orgId,
        name: 'r',
        url: recv.url,
        events: ['*'],
      });
      await assert.rejects(
        svc.deliver({
          subscriptionId: sub.id,
          event: {
            orgId,
            eventType: 'x',
            actorType: 'agent',
            actorId: 'a',
            payload: {},
            occurredAt: new Date().toISOString(),
          },
        }),
        /delivery failed/,
      );
      const [row] = await db
        .select()
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.id, sub.id));
      assert.equal(row!.lastDeliveryStatus, '503');
    } finally {
      await recv.close();
    }
  });

  it('deliver: subscription deleted between dispatch and delivery → drops silently', async () => {
    const sub = await svc.create({
      orgId,
      name: 'r',
      url: 'http://example.invalid/never',
      events: ['*'],
    });
    await svc.remove(orgId, sub.id);
    const out = await svc.deliver({
      subscriptionId: sub.id,
      event: {
        orgId,
        eventType: 'x',
        actorType: 'agent',
        actorId: 'a',
        payload: {},
        occurredAt: new Date().toISOString(),
      },
    });
    assert.equal(out.status, 0);
  });

  it('update: enabled toggle pauses then resumes dispatch', async () => {
    const sub = await svc.create({
      orgId,
      name: 'r',
      url: 'http://x/y',
      events: ['*'],
    });

    // disabled → no enqueue
    await svc.update(orgId, sub.id, { enabled: false });
    await svc.dispatch({
      orgId,
      eventType: 'x',
      actorType: 'agent',
      actorId: 'a',
      payload: {},
      occurredAt: new Date().toISOString(),
    });
    assert.equal(queue.added.length, 0);

    // re-enabled → dispatch enqueues
    await svc.update(orgId, sub.id, { enabled: true });
    await svc.dispatch({
      orgId,
      eventType: 'x',
      actorType: 'agent',
      actorId: 'a',
      payload: {},
      occurredAt: new Date().toISOString(),
    });
    assert.equal(queue.added.length, 1);
  });

  it('update: 404 for an id in another org', async () => {
    const otherOrg = await db
      .insert(orgs)
      .values({ name: 'other', slug: `wh-other-${randomUUID().slice(0, 8)}` })
      .returning();
    try {
      const sub = await svc.create({
        orgId: otherOrg[0]!.id,
        name: 'their',
        url: 'http://x/y',
        events: ['*'],
      });
      const result = await svc.update(orgId, sub.id, { enabled: false });
      assert.equal(result.ok, false);
      if (result.ok === false) assert.equal(result.reason, 'not_found');
    } finally {
      await db.delete(orgs).where(eq(orgs.id, otherOrg[0]!.id));
    }
  });

  it('remove: returns false when the subscription belongs to another org', async () => {
    const otherOrg = await db
      .insert(orgs)
      .values({ name: 'other', slug: `wh-other-${randomUUID().slice(0, 8)}` })
      .returning();
    try {
      const sub = await svc.create({
        orgId: otherOrg[0]!.id,
        name: 'their',
        url: 'http://x/y',
        events: ['*'],
      });
      const ok = await svc.remove(orgId, sub.id);
      assert.equal(ok, false);
    } finally {
      await db.delete(orgs).where(eq(orgs.id, otherOrg[0]!.id));
    }
  });
});
