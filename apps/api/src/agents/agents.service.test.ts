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
import { schema, orgs, agents, agentApiKeys, auditLog } from '@agentbase/db';
import { AgentsService } from './agents.service.js';
import { AuditService } from '../audit/audit.service.js';
import { hashApiKey } from '../auth/api-key.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://agentbase:agentbase@localhost:5433/agentbase';

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

  it('creates the agent + a single api key with agb_ plaintext and matching prefix', async () => {
    const out = await svc.register({
      orgId,
      name: 'researcher',
      description: 'looks things up',
    });
    assert.match(out.api_key, /^agb_/);
    assert.equal(out.api_key_prefix, out.api_key.slice(0, 12));
    assert.match(out.agent_id, /^[0-9a-f-]{36}$/i);

    const [row] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, out.agent_id));
    assert.equal(row!.name, 'researcher');
    assert.equal(row!.description, 'looks things up');
    assert.equal(row!.permissionProfile, 'sales_sdr');
    assert.equal(out.permission_profile, 'sales_sdr');
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

  it('persists an explicit permission profile', async () => {
    const out = await svc.register({
      orgId,
      name: 'analyst',
      permissionProfile: 'read_only_analyst',
    });

    assert.equal(out.permission_profile, 'read_only_analyst');
    const [row] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, out.agent_id));
    assert.equal(row!.permissionProfile, 'read_only_analyst');
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
    assert.equal(rows[0]!.permissionProfile, 'sales_sdr');
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
      revokedByEmail: 'alice@agentbase.test',
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
    assert.equal(ev!.actorId, 'alice@agentbase.test');
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

describe('AgentsService.updatePermissionProfile', () => {
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

  it('updates the profile and records an audit event', async () => {
    const reg = await svc.register({ orgId, name: 'profiled' });

    const updated = await svc.updatePermissionProfile({
      orgId,
      agentId: reg.agent_id,
      permissionProfile: 'support_agent',
      actorId: 'user_profile_admin',
    });

    assert.equal(updated.permissionProfile, 'support_agent');

    const [row] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, reg.agent_id));
    assert.equal(row!.permissionProfile, 'support_agent');

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const ev = events.find(
      (event) => event.eventType === 'agent.permission_profile.updated',
    );
    assert.ok(ev);
    assert.equal(ev!.actorId, 'user_profile_admin');
    const payload = ev!.payload as {
      agentId: string;
      agentName: string;
      from: string;
      to: string;
    };
    assert.equal(payload.agentId, reg.agent_id);
    assert.equal(payload.agentName, 'profiled');
    assert.equal(payload.from, 'sales_sdr');
    assert.equal(payload.to, 'support_agent');
  });

  it('throws NotFoundException when the agent is not in the org', async () => {
    const reg = await svc.register({ orgId, name: 'mine' });
    const [otherOrg] = await db
      .insert(orgs)
      .values({ name: 'Other', slug: `ag-${randomUUID().slice(0, 8)}` })
      .returning();

    try {
      await assert.rejects(
        () =>
          svc.updatePermissionProfile({
            orgId: otherOrg!.id,
            agentId: reg.agent_id,
            permissionProfile: 'revops_admin',
            actorId: 'operator',
          }),
        NotFoundException,
      );

      const [row] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, reg.agent_id));
      assert.equal(row!.permissionProfile, 'sales_sdr');
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

describe('AgentsService.getById', () => {
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

  it('returns the agent row by id', async () => {
    const reg = await svc.register({ orgId, name: 'lookup-me' });
    const row = await svc.getById(reg.agent_id);
    assert.equal(row.id, reg.agent_id);
    assert.equal(row.name, 'lookup-me');
    assert.equal(row.status, 'active');
  });

  it('throws NotFoundException for an unknown id', async () => {
    await assert.rejects(() => svc.getById(randomUUID()), NotFoundException);
  });

  it('still returns revoked agents (getById is not status-filtered)', async () => {
    const reg = await svc.register({ orgId, name: 'revoked-lookup' });
    await svc.revoke({ orgId, agentId: reg.agent_id });
    const row = await svc.getById(reg.agent_id);
    assert.equal(row.status, 'revoked');
  });
});

describe('AgentsService.ensureInternalAgent', () => {
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

  it('creates one active agent per org/name and reuses it', async () => {
    const first = await svc.ensureInternalAgent({
      orgId,
      name: 'dashboard-hubspot-workflow',
      description: 'internal',
    });
    const second = await svc.ensureInternalAgent({
      orgId,
      name: 'dashboard-hubspot-workflow',
      description: 'internal',
    });

    assert.equal(first.id, second.id);
    assert.equal(first.status, 'active');

    const rows = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          eq(agents.name, 'dashboard-hubspot-workflow'),
        ),
      );
    assert.equal(rows.length, 1);
  });

  it('does not reuse a revoked agent — creates a fresh active one', async () => {
    const first = await svc.ensureInternalAgent({
      orgId,
      name: 'internal-rotator',
    });
    await svc.revoke({ orgId, agentId: first.id });

    const second = await svc.ensureInternalAgent({
      orgId,
      name: 'internal-rotator',
    });

    assert.notEqual(second.id, first.id);
    assert.equal(second.status, 'active');

    const [old] = await db.select().from(agents).where(eq(agents.id, first.id));
    assert.equal(old!.status, 'revoked');
  });

  it('scopes reuse to the org — same name in another org gets its own agent', async () => {
    const mine = await svc.ensureInternalAgent({ orgId, name: 'shared-name' });

    const [otherOrg] = await db
      .insert(orgs)
      .values({ name: 'Other', slug: `ag-${randomUUID().slice(0, 8)}` })
      .returning();
    try {
      const theirs = await svc.ensureInternalAgent({
        orgId: otherOrg!.id,
        name: 'shared-name',
      });
      assert.notEqual(theirs.id, mine.id);
      assert.equal(theirs.orgId, otherOrg!.id);
    } finally {
      await db.delete(orgs).where(eq(orgs.id, otherOrg!.id));
    }
  });
});

describe('AgentsService.listForOrg — revoked agents', () => {
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

  it('includes revoked agents with their revokedAt and key prefix (audit trail stays visible)', async () => {
    const reg = await svc.register({ orgId, name: 'gone' });
    await svc.revoke({ orgId, agentId: reg.agent_id });

    const rows = await svc.listForOrg(orgId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'revoked');
    assert.ok(rows[0]!.revokedAt);
    assert.equal(rows[0]!.keyPrefix, reg.api_key_prefix);
  });
});
