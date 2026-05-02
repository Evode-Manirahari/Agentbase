// Integration tests for AgentsService — require Postgres on $DATABASE_URL.

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
import { and, eq, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { NotFoundException } from '@nestjs/common';
import { schema, orgs, agents, agentApiKeys, auditLog } from '@dejavas/db';
import { AgentsService } from './agents.service.js';
import { AuditService } from '../audit/audit.service.js';
import { hashApiKey } from '../auth/api-key.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://dejavas:dejavas@localhost:5433/dejavas';

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

describe('AgentsService.register', () => {
  let orgId: string;
  let svc: AgentsService;

  beforeEach(async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug: `ag-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;
    svc = new AgentsService(db, audit);
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('creates the agent + a single api key with dvk_ plaintext and matching prefix', async () => {
    const out = await svc.register({
      orgId,
      name: 'researcher',
      description: 'looks things up',
    });
    assert.match(out.api_key, /^dvk_/);
    assert.equal(out.api_key_prefix, out.api_key.slice(0, 12));
    assert.match(out.agent_id, /^[0-9a-f-]{36}$/i);

    const [row] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, out.agent_id));
    assert.equal(row!.name, 'researcher');
    assert.equal(row!.description, 'looks things up');
    assert.equal(row!.status, 'active');
    assert.equal(row!.revokedAt, null);

    const keys = await db
      .select()
      .from(agentApiKeys)
      .where(eq(agentApiKeys.agentId, out.agent_id));
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.keyHash, hashApiKey(out.api_key));
    assert.equal(keys[0]!.keyPrefix, out.api_key_prefix);
    assert.equal(keys[0]!.revokedAt, null);
  });

  it('two registrations produce different agents and different keys', async () => {
    const a = await svc.register({ orgId, name: 'a' });
    const b = await svc.register({ orgId, name: 'b' });
    assert.notEqual(a.agent_id, b.agent_id);
    assert.notEqual(a.api_key, b.api_key);
  });
});

describe('AgentsService.listForOrg', () => {
  let orgId: string;
  let svc: AgentsService;

  beforeEach(async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug: `ag-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;
    svc = new AgentsService(db, audit);
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('returns each agent joined with its api key prefix, ordered desc by createdAt', async () => {
    await svc.register({ orgId, name: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await svc.register({ orgId, name: 'second' });

    const rows = await svc.listForOrg(orgId, 50);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.name, 'second');
    assert.equal(rows[0]!.id, second.agent_id);
    assert.equal(rows[0]!.keyPrefix, second.api_key_prefix);
    assert.equal(rows[1]!.name, 'first');
  });

  it('returns empty for an org with no agents', async () => {
    const rows = await svc.listForOrg(orgId);
    assert.deepEqual(rows, []);
  });
});

describe('AgentsService.revoke', () => {
  let orgId: string;
  let svc: AgentsService;

  beforeEach(async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug: `ag-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;
    svc = new AgentsService(db, audit);
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('flips agent.status + revokes all active keys + records audit event', async () => {
    const reg = await svc.register({ orgId, name: 'to-revoke' });

    const result = await svc.revoke({
      orgId,
      agentId: reg.agent_id,
      reason: 'test',
      revokedByEmail: 'alice@dejavas.test',
    });
    assert.equal(result.status, 'revoked');
    assert.equal(result.keys_revoked, 1);
    assert.equal(result.already_revoked, false);
    assert.ok(result.revoked_at);

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, reg.agent_id));
    assert.equal(agent!.status, 'revoked');
    assert.ok(agent!.revokedAt);

    const stillActiveKeys = await db
      .select()
      .from(agentApiKeys)
      .where(
        and(
          eq(agentApiKeys.agentId, reg.agent_id),
          isNull(agentApiKeys.revokedAt),
        ),
      );
    assert.equal(stillActiveKeys.length, 0);

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const ev = events.find((e) => e.eventType === 'agent.revoked');
    assert.ok(ev);
    assert.equal(ev!.actorId, 'alice@dejavas.test');
    const payload = ev!.payload as { agentName: string; reason: string; keysRevoked: number };
    assert.equal(payload.agentName, 'to-revoke');
    assert.equal(payload.reason, 'test');
    assert.equal(payload.keysRevoked, 1);
  });

  it('idempotent: second call returns already_revoked=true with keys_revoked=0', async () => {
    const reg = await svc.register({ orgId, name: 'twice' });
    await svc.revoke({ orgId, agentId: reg.agent_id });
    const second = await svc.revoke({ orgId, agentId: reg.agent_id });

    assert.equal(second.already_revoked, true);
    assert.equal(second.keys_revoked, 0);

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const revokedEvents = events.filter((e) => e.eventType === 'agent.revoked');
    assert.equal(revokedEvents.length, 1);
  });

  it('throws NotFoundException when agent not in org', async () => {
    await assert.rejects(
      () => svc.revoke({ orgId, agentId: randomUUID() }),
      NotFoundException,
    );
  });

  it('does not revoke an agent in a different org', async () => {
    const reg = await svc.register({ orgId, name: 'mine' });

    const [otherOrg] = await db
      .insert(orgs)
      .values({ name: 'Other', slug: `ag-${randomUUID().slice(0, 8)}` })
      .returning();

    try {
      await assert.rejects(
        () => svc.revoke({ orgId: otherOrg!.id, agentId: reg.agent_id }),
        NotFoundException,
      );
      const [row] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, reg.agent_id));
      assert.equal(row!.status, 'active');
    } finally {
      await db.delete(orgs).where(eq(orgs.id, otherOrg!.id));
    }
  });
});

describe('AgentsService.ensureDefaultOrg', () => {
  it('returns the same org id on repeat calls (idempotent)', async () => {
    const svc = new AgentsService(db, audit);
    const a = await svc.ensureDefaultOrg();
    const b = await svc.ensureDefaultOrg();
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f-]{36}$/i);
  });
});
