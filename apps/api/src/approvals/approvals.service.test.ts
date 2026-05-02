// Integration tests for ApprovalsService — require Postgres on $DATABASE_URL
// (default localhost:5433 from infra/docker-compose.yml). Each test creates a
// unique org and cleans it up via cascade delete; tests are isolated.

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
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import {
  schema,
  orgs,
  agents,
  actions,
  approvals,
  auditLog,
} from '@dejavas/db';
import type { Connector, ConnectorResult } from '@dejavas/connector-hubspot';
import { ApprovalsService } from './approvals.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { ConnectorRegistry } from '../connectors/connector-registry.js';
import type { SlackService } from '../slack/slack.service.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://dejavas:dejavas@localhost:5433/dejavas';

class StubRegistry {
  invocations: { tool: string; params: Record<string, unknown> }[] = [];
  result: ConnectorResult = {
    ok: false,
    error: { code: 'stub_default', message: 'stub default' },
  };
  resolve(_tool: string): Connector {
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
  updates: { channel: string; ts: string; decision: string }[] = [];
  buildResolvedBlocks(input: { decision: string }) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: input.decision } }];
  }
  async updateCard(channel: string, ts: string, _blocks: unknown, _text: string) {
    this.updates.push({ channel, ts, decision: 'unknown' });
    return true;
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

describe('ApprovalsService.decide', () => {
  let orgId: string;
  let agentId: string;
  let registry: StubRegistry;
  let svc: ApprovalsService;

  async function seedAction(
    opts: { expiresInMs?: number } = {},
  ): Promise<{ actionId: string; approvalId: string }> {
    const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 3_600_000));
    const [action] = await db
      .insert(actions)
      .values({
        orgId,
        agentId,
        tool: 'test.tool',
        params: { key: 'value' },
        status: 'awaiting_approval',
        policyDecision: { effect: 'require_approval' } as Record<string, unknown>,
      })
      .returning();
    if (!action) throw new Error('seed action failed');
    const [approval] = await db
      .insert(approvals)
      .values({
        actionId: action.id,
        requiredRole: 'approver',
        decision: 'pending',
        expiresAt,
      })
      .returning();
    if (!approval) throw new Error('seed approval failed');
    return { actionId: action.id, approvalId: approval.id };
  }

  beforeEach(async () => {
    const slug = `test-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test Org', slug })
      .returning();
    if (!org) throw new Error('seed org failed');
    orgId = org.id;

    const [agent] = await db
      .insert(agents)
      .values({ orgId, name: 'test-agent' })
      .returning();
    if (!agent) throw new Error('seed agent failed');
    agentId = agent.id;

    registry = new StubRegistry();
    svc = new ApprovalsService(
      db,
      audit,
      registry as unknown as ConnectorRegistry,
      new StubSlack() as unknown as SlackService,
    );
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('deny: flips approval to denied, action to denied, no connector call', async () => {
    const { actionId, approvalId } = await seedAction();

    const result = await svc.decide({
      approvalId,
      orgId,
      decision: 'deny',
      decidedByEmail: 'alice@dejavas.test',
    });

    assert.equal(result.decision, 'denied');
    assert.equal(result.action_status, 'denied');
    assert.equal(result.result, null);

    const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    assert.equal(a!.decision, 'denied');
    assert.ok(a!.decidedAt);
    assert.ok(a!.decidedByUserId);

    const [ac] = await db.select().from(actions).where(eq(actions.id, actionId));
    assert.equal(ac!.status, 'denied');

    assert.equal(registry.invocations.length, 0);

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    assert.ok(events.some((e) => e.eventType === 'approval.denied'));
  });

  it('approve + connector success: action ends executed, connector invoked', async () => {
    const { actionId, approvalId } = await seedAction();
    registry.result = { ok: true, data: { id: 'hs-123', updated: true } };

    const result = await svc.decide({
      approvalId,
      orgId,
      decision: 'approve',
      decidedByEmail: 'alice@dejavas.test',
    });

    assert.equal(result.decision, 'approved');
    assert.equal(result.action_status, 'executed');

    assert.equal(registry.invocations.length, 1);
    assert.equal(registry.invocations[0]!.tool, 'test.tool');
    assert.deepEqual(registry.invocations[0]!.params, { key: 'value' });

    const [ac] = await db.select().from(actions).where(eq(actions.id, actionId));
    assert.equal(ac!.status, 'executed');
    const stored = ac!.result as { ok: boolean; data: unknown };
    assert.equal(stored.ok, true);
    assert.deepEqual(stored.data, { id: 'hs-123', updated: true });

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const types = events.map((e) => e.eventType);
    assert.ok(types.includes('approval.approved'));
    assert.ok(types.includes('action.executed'));
  });

  it('approve + connector failure: action ends failed with error code in result', async () => {
    const { actionId, approvalId } = await seedAction();
    registry.result = {
      ok: false,
      error: { code: 'http_503', message: 'upstream down' },
    };

    const result = await svc.decide({
      approvalId,
      orgId,
      decision: 'approve',
    });

    assert.equal(result.action_status, 'failed');

    const [ac] = await db.select().from(actions).where(eq(actions.id, actionId));
    assert.equal(ac!.status, 'failed');
    const stored = ac!.result as { ok: boolean; error: { code: string } };
    assert.equal(stored.ok, false);
    assert.equal(stored.error.code, 'http_503');

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    assert.ok(events.some((e) => e.eventType === 'action.failed'));
  });

  it('idempotency: re-decide on already-decided approval throws ConflictException', async () => {
    const { approvalId } = await seedAction();
    registry.result = { ok: true, data: {} };
    await svc.decide({ approvalId, orgId, decision: 'approve' });

    await assert.rejects(
      () => svc.decide({ approvalId, orgId, decision: 'deny' }),
      ConflictException,
    );
  });

  it('expired-at-decide-time: throws GoneException, marks approval expired + action denied', async () => {
    const { actionId, approvalId } = await seedAction({ expiresInMs: -3_600_000 });

    await assert.rejects(
      () => svc.decide({ approvalId, orgId, decision: 'approve' }),
      GoneException,
    );

    const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    assert.equal(a!.decision, 'expired');

    const [ac] = await db.select().from(actions).where(eq(actions.id, actionId));
    assert.equal(ac!.status, 'denied');

    assert.equal(registry.invocations.length, 0);
  });

  it('not-found: decide on unknown approval throws NotFoundException', async () => {
    await assert.rejects(
      () =>
        svc.decide({
          approvalId: randomUUID(),
          orgId,
          decision: 'approve',
        }),
      NotFoundException,
    );
  });

  it('approve on a Slack-posted approval calls chat.update with the stored channel+ts', async () => {
    const { approvalId, actionId } = await seedAction();
    await db
      .update(approvals)
      .set({ slackChannel: 'C123', slackTs: '1700000000.123456' })
      .where(eq(approvals.id, approvalId));

    const slackStub = new StubSlack();
    registry.result = { ok: true, data: { updated: true } };
    const svcWithSlack = new ApprovalsService(
      db,
      audit,
      registry as unknown as ConnectorRegistry,
      slackStub as unknown as SlackService,
    );

    const result = await svcWithSlack.decide({
      approvalId,
      orgId,
      decision: 'approve',
      decidedByEmail: 'alice@dejavas.test',
    });
    assert.equal(result.action_status, 'executed');

    assert.equal(slackStub.updates.length, 1);
    assert.equal(slackStub.updates[0]!.channel, 'C123');
    assert.equal(slackStub.updates[0]!.ts, '1700000000.123456');

    // sanity: action did transition (no rollback regression)
    const [ac] = await db.select().from(actions).where(eq(actions.id, actionId));
    assert.equal(ac!.status, 'executed');
  });

  it('deny on a non-Slack approval skips chat.update', async () => {
    const { approvalId } = await seedAction();
    const slackStub = new StubSlack();
    const svcWithSlack = new ApprovalsService(
      db,
      audit,
      registry as unknown as ConnectorRegistry,
      slackStub as unknown as SlackService,
    );
    await svcWithSlack.decide({ approvalId, orgId, decision: 'deny' });
    assert.equal(slackStub.updates.length, 0);
  });

  it("cross-org access: decide on another org's approval throws NotFoundException", async () => {
    const { approvalId } = await seedAction();

    const slug = `test2-${randomUUID().slice(0, 8)}`;
    const [otherOrg] = await db
      .insert(orgs)
      .values({ name: 'Other', slug })
      .returning();

    try {
      await assert.rejects(
        () =>
          svc.decide({
            approvalId,
            orgId: otherOrg!.id,
            decision: 'approve',
          }),
        NotFoundException,
      );
    } finally {
      await db.delete(orgs).where(eq(orgs.id, otherOrg!.id));
    }
  });
});

describe('ApprovalsService.list / getOne', () => {
  let orgId: string;
  let agentId: string;
  let svc: ApprovalsService;

  beforeEach(async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug: `test-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;
    const [agent] = await db
      .insert(agents)
      .values({ orgId, name: 'list-agent' })
      .returning();
    agentId = agent!.id;
    svc = new ApprovalsService(
      db,
      audit,
      new StubRegistry() as unknown as ConnectorRegistry,
      new StubSlack() as unknown as SlackService,
    );
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('list: returns only pending approvals for the org', async () => {
    const [a1] = await db
      .insert(actions)
      .values({
        orgId,
        agentId,
        tool: 'test.one',
        params: {},
        status: 'awaiting_approval',
      })
      .returning();
    const [pending] = await db
      .insert(approvals)
      .values({
        actionId: a1!.id,
        requiredRole: 'approver',
        decision: 'pending',
      })
      .returning();

    const [a2] = await db
      .insert(actions)
      .values({
        orgId,
        agentId,
        tool: 'test.two',
        params: {},
        status: 'denied',
      })
      .returning();
    await db.insert(approvals).values({
      actionId: a2!.id,
      requiredRole: 'approver',
      decision: 'denied',
      decidedAt: new Date(),
    });

    const result = await svc.list(orgId);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.approval_id, pending!.id);
    assert.equal(result.items[0]!.tool, 'test.one');
    assert.equal(result.items[0]!.agent_name, 'list-agent');
  });

  it('getOne: returns full view with agent_name + tool + params', async () => {
    const [a] = await db
      .insert(actions)
      .values({
        orgId,
        agentId,
        tool: 'hubspot.deals.update',
        params: { dealId: 'd1', amount: 5000 },
        status: 'awaiting_approval',
      })
      .returning();
    const [approval] = await db
      .insert(approvals)
      .values({
        actionId: a!.id,
        requiredRole: 'approver',
        decision: 'pending',
      })
      .returning();

    const view = await svc.getOne(orgId, approval!.id);
    assert.equal(view.tool, 'hubspot.deals.update');
    assert.equal(view.agent_name, 'list-agent');
    assert.deepEqual(view.params, { dealId: 'd1', amount: 5000 });
    assert.equal(view.decision, 'pending');
  });

  it('getOne: throws NotFoundException for unknown id', async () => {
    await assert.rejects(
      () => svc.getOne(orgId, randomUUID()),
      NotFoundException,
    );
  });
});
