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
import { ConfigService } from '@nestjs/config';
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
  users,
} from '@agentbase/db';
import type { Connector, ConnectorResult } from '@agentbase/connector-hubspot';
import { ApprovalsService } from './approvals.service.js';
import type { AgentRunsService } from '../agent-runtime/agent-runs.service.js';

// Tests don't exercise the resume hook — they just need a no-op stub so
// the ApprovalsService constructor signature is satisfied.
const noopAgentRuns = {
  async notifyActionResolved() {
    /* noop */
  },
} as unknown as AgentRunsService;
import { AuditService } from '../audit/audit.service.js';
import type { ConnectorRegistry } from '../connectors/connector-registry.js';
import type { SlackService } from '../slack/slack.service.js';
import { EffectDispatcher } from '../actions/effect-dispatcher.service.js';
import { EffectReceiptsService } from '../actions/effect-receipts.service.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://agentbase:agentbase@localhost:5433/agentbase';

class StubRegistry {
  invocations: { tool: string; params: Record<string, unknown> }[] = [];
  result: ConnectorResult = {
    ok: false,
    error: { code: 'stub_default', message: 'stub default' },
  };
  // Widens the dispatch window so concurrent decide() calls overlap.
  delayMs = 0;
  // Records the orgId dispatch was scoped to, so we can prove an approved
  // action runs against the tenant's own credentials.
  orgScopedCalls: string[] = [];
  resolve(_tool: string): Connector {
    return {
      name: 'stub',
      supports: () => true,
      invoke: async (tool, params) => {
        this.invocations.push({ tool, params });
        if (this.delayMs > 0) {
          await new Promise((r) => setTimeout(r, this.delayMs));
        }
        return this.result;
      },
    };
  }
}

// A registry that exposes resolveForOrg, like the real one does once
// org-scoped connector credentials are configured.
class StubOrgScopedRegistry extends StubRegistry {
  async resolveForOrg(orgId: string, tool: string): Promise<Connector> {
    this.orgScopedCalls.push(orgId);
    return this.resolve(tool);
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

// Builds the effect dispatcher the services now depend on. `replay` flips the
// hard mode switch that makes it incapable of reaching a connector.
function makeEffects(replay = false): EffectDispatcher {
  const config = {
    get: (k: string) =>
      k === 'AGENTBASE_REPLAY' ? (replay ? '1' : undefined) : undefined,
  } as unknown as ConfigService;
  return new EffectDispatcher(new EffectReceiptsService(db), config);
}

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
      noopAgentRuns,
      makeEffects(),
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
      decidedByEmail: 'alice@agentbase.test',
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
      decidedByEmail: 'alice@agentbase.test',
    });

    assert.equal(result.decision, 'approved');
    assert.equal(result.action_status, 'executed');

    assert.equal(registry.invocations.length, 1);
    assert.equal(registry.invocations[0]!.tool, 'test.tool');
    assert.deepEqual(registry.invocations[0]!.params, { key: 'value' });

    const [ac] = await db.select().from(actions).where(eq(actions.id, actionId));
    assert.equal(ac!.status, 'executed');
    // The approved dispatch is a real external effect and must be tracked as
    // one, not left on the `not_dispatched` default.
    assert.equal(ac!.dispatchState, 'settled');
    assert.ok(ac!.dispatchedAt, 'an approved dispatch records when it started');
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

  it('approve marks the dispatch in_flight before the connector is called', async () => {
    // A human just approved a high-value action; this is the most consequential
    // dispatch in the system. If it crashes mid-call the row must be visible to
    // reconcileStaleDispatches(), which only ever looks at `in_flight`.
    const { actionId, approvalId } = await seedAction();
    let stateDuringInvoke: string | null = null;
    registry.resolve = () => ({
      name: 'probe',
      supports: () => true,
      invoke: async () => {
        const [row] = await db
          .select()
          .from(actions)
          .where(eq(actions.id, actionId));
        stateDuringInvoke = row?.dispatchState ?? null;
        return { ok: true, data: {} };
      },
    });

    await svc.decide({
      approvalId,
      orgId,
      decision: 'approve',
      decidedByEmail: 'alice@agentbase.test',
    });

    assert.equal(stateDuringInvoke, 'in_flight');
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

  it('expired-at-decide-time: records an approval.expired audit event with system actor', async () => {
    const { approvalId } = await seedAction({ expiresInMs: -3_600_000 });

    await assert.rejects(
      () => svc.decide({ approvalId, orgId, decision: 'approve' }),
      GoneException,
    );

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const ev = events.find((e) => e.eventType === 'approval.expired');
    assert.ok(ev, 'expected an approval.expired audit event');
    assert.equal(ev!.actorType, 'system');
    assert.equal(ev!.actorId, 'decide_expiry_check');
    const payload = ev!.payload as { approvalId: string; tool: string };
    assert.equal(payload.approvalId, approvalId);
    assert.equal(payload.tool, 'test.tool');
  });

  it('approve with no resolving connector: action ends failed with no_connector', async () => {
    const { actionId, approvalId } = await seedAction();
    const emptyRegistry = { resolve: () => null };
    const svcNoConnector = new ApprovalsService(
      db,
      audit,
      emptyRegistry as unknown as ConnectorRegistry,
      new StubSlack() as unknown as SlackService,
      noopAgentRuns,
      makeEffects(),
    );

    const result = await svcNoConnector.decide({
      approvalId,
      orgId,
      decision: 'approve',
      decidedByEmail: 'alice@agentbase.test',
    });

    // The human approval is still recorded — only the dispatch failed.
    assert.equal(result.decision, 'approved');
    assert.equal(result.action_status, 'failed');

    const [ac] = await db.select().from(actions).where(eq(actions.id, actionId));
    assert.equal(ac!.status, 'failed');
    const stored = ac!.result as { ok: boolean; error: { code: string } };
    assert.equal(stored.ok, false);
    assert.equal(stored.error.code, 'no_connector');

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const failed = events.find((e) => e.eventType === 'action.failed');
    assert.ok(failed);
    assert.equal((failed!.payload as { connector: string | null }).connector, null);
  });

  it('decider upsert: the same email across two decisions maps to one users row', async () => {
    const first = await seedAction();
    const second = await seedAction();
    registry.result = { ok: true, data: {} };

    await svc.decide({
      approvalId: first.approvalId,
      orgId,
      decision: 'approve',
      decidedByEmail: 'repeat@agentbase.test',
    });
    await svc.decide({
      approvalId: second.approvalId,
      orgId,
      decision: 'deny',
      decidedByEmail: 'repeat@agentbase.test',
    });

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.orgId, orgId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.email, 'repeat@agentbase.test');
    assert.equal(rows[0]!.role, 'approver');

    const [a1] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, first.approvalId));
    const [a2] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, second.approvalId));
    assert.equal(a1!.decidedByUserId, rows[0]!.id);
    assert.equal(a2!.decidedByUserId, rows[0]!.id);
  });

  it('decide without an email leaves decidedByUserId null and audits actor as unknown', async () => {
    const { approvalId } = await seedAction();

    await svc.decide({ approvalId, orgId, decision: 'deny' });

    const [a] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    assert.equal(a!.decidedByUserId, null);

    const events = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId));
    const ev = events.find((e) => e.eventType === 'approval.denied');
    assert.equal(ev!.actorId, 'unknown');
  });

  it('bulkDecide surfaces an expired approval as a failed item with code expired', async () => {
    const live = await seedAction();
    const expired = await seedAction({ expiresInMs: -3_600_000 });
    registry.result = { ok: true, data: {} };

    const out = await svc.bulkDecide({
      orgId,
      approvalIds: [live.approvalId, expired.approvalId],
      decision: 'approve',
      decidedByEmail: 'rev@agentbase.test',
    });

    assert.equal(out.summary.decided, 1);
    assert.equal(out.summary.failed, 1);
    const failed = out.items.find((it) => it.outcome === 'failed');
    if (!failed || failed.outcome !== 'failed') throw new Error('expected failed item');
    assert.equal(failed.approval_id, expired.approvalId);
    assert.equal(failed.error.code, 'expired');
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
      noopAgentRuns,
      makeEffects(),
    );

    const result = await svcWithSlack.decide({
      approvalId,
      orgId,
      decision: 'approve',
      decidedByEmail: 'alice@agentbase.test',
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
      noopAgentRuns,
      makeEffects(),
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

  it('bulkDecide approves N pending approvals and reports a summary', async () => {
    const seeds = await Promise.all([seedAction(), seedAction(), seedAction()]);
    const ids = seeds.map((s) => s.approvalId);
    registry.result = { ok: true, data: { ok: true } };

    const out = await svc.bulkDecide({
      orgId,
      approvalIds: ids,
      decision: 'approve',
      decidedByEmail: 'rev@agentbase.test',
    });

    assert.equal(out.summary.decided, 3);
    assert.equal(out.summary.failed, 0);
    assert.equal(out.summary.skipped_already_decided, 0);
    assert.equal(out.items.length, 3);
    for (const item of out.items) {
      if (item.outcome !== 'decided') {
        throw new Error(`expected decided, got ${item.outcome}`);
      }
      assert.equal(item.action_status, 'executed');
    }
  });

  it('bulkDecide surfaces already-decided rows as skipped, not failed', async () => {
    const seeds = await Promise.all([seedAction(), seedAction()]);
    registry.result = { ok: true, data: { ok: true } };

    // Decide the first one individually first.
    await svc.decide({
      approvalId: seeds[0]!.approvalId,
      orgId,
      decision: 'approve',
      decidedByEmail: 'rev@agentbase.test',
    });

    const out = await svc.bulkDecide({
      orgId,
      approvalIds: [seeds[0]!.approvalId, seeds[1]!.approvalId],
      decision: 'approve',
      decidedByEmail: 'rev@agentbase.test',
    });

    assert.equal(out.summary.decided, 1);
    assert.equal(out.summary.skipped_already_decided, 1);
    assert.equal(out.summary.failed, 0);
  });

  it('bulkDecide reports per-id failure (unknown id) without blocking the rest', async () => {
    const { approvalId } = await seedAction();
    registry.result = { ok: true, data: { ok: true } };

    const out = await svc.bulkDecide({
      orgId,
      approvalIds: [approvalId, randomUUID()],
      decision: 'approve',
      decidedByEmail: 'rev@agentbase.test',
    });

    assert.equal(out.summary.decided, 1);
    assert.equal(out.summary.failed, 1);
    const failed = out.items.find((it) => it.outcome === 'failed');
    if (!failed || failed.outcome !== 'failed') throw new Error('expected failed item');
    assert.equal(failed.error.code, 'not_found');
  });

  // ---------------------------------------------------------------------
  // Effect safety on the human-approval path.
  // ---------------------------------------------------------------------

  it('concurrent approvals of the same action dispatch the connector once', async () => {
    const { approvalId } = await seedAction();
    registry.delayMs = 120;
    registry.result = { ok: true, data: {} };

    // Two approvers (or one impatient double-click) land at the same instant.
    const outcomes = await Promise.allSettled([
      svc.decide({
        approvalId,
        orgId,
        decision: 'approve',
        decidedByEmail: 'alice@agentbase.test',
      }),
      svc.decide({
        approvalId,
        orgId,
        decision: 'approve',
        decidedByEmail: 'bob@agentbase.test',
      }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, 'exactly one decide should win');
    assert.equal(
      registry.invocations.length,
      1,
      `expected one dispatch, got ${registry.invocations.length}`,
    );
  });

  it('an approve racing a deny produces one outcome and at most one dispatch', async () => {
    const { approvalId, actionId } = await seedAction();
    registry.delayMs = 80;
    registry.result = { ok: true, data: {} };

    const outcomes = await Promise.allSettled([
      svc.decide({
        approvalId,
        orgId,
        decision: 'approve',
        decidedByEmail: 'alice@agentbase.test',
      }),
      svc.decide({
        approvalId,
        orgId,
        decision: 'deny',
        decidedByEmail: 'bob@agentbase.test',
      }),
    ]);

    assert.equal(
      outcomes.filter((o) => o.status === 'fulfilled').length,
      1,
      'exactly one decision should stick',
    );

    const [a] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    const [act] = await db.select().from(actions).where(eq(actions.id, actionId));

    // Whichever won, the recorded decision and the dispatch must agree: a
    // denied approval must never have called the connector.
    if (a!.decision === 'denied') {
      assert.equal(registry.invocations.length, 0);
      assert.equal(act!.status, 'denied');
    } else {
      assert.equal(a!.decision, 'approved');
      assert.equal(registry.invocations.length, 1);
    }
  });

  it('dispatches an approved action through the org-scoped resolver', async () => {
    const orgScoped = new StubOrgScopedRegistry();
    orgScoped.result = { ok: true, data: {} };
    const scopedSvc = new ApprovalsService(
      db,
      audit,
      orgScoped as unknown as ConnectorRegistry,
      new StubSlack() as unknown as SlackService,
      noopAgentRuns,
      makeEffects(),
    );
    const { approvalId } = await seedAction();

    await scopedSvc.decide({
      approvalId,
      orgId,
      decision: 'approve',
      decidedByEmail: 'alice@agentbase.test',
    });

    // The tenant's own credentials, not process env fallback.
    assert.deepEqual(orgScoped.orgScopedCalls, [orgId]);
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
      noopAgentRuns,
      makeEffects(),
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
        slackChannel: 'C123',
        slackTs: '1700000000.123456',
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
    assert.equal(result.items[0]!.slack_channel, 'C123');
    assert.equal(result.items[0]!.slack_ts, '1700000000.123456');
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
        slackChannel: 'C456',
        slackTs: '1800000000.654321',
      })
      .returning();

    const view = await svc.getOne(orgId, approval!.id);
    assert.equal(view.tool, 'hubspot.deals.update');
    assert.equal(view.agent_name, 'list-agent');
    assert.deepEqual(view.params, { dealId: 'd1', amount: 5000 });
    assert.equal(view.decision, 'pending');
    assert.equal(view.slack_channel, 'C456');
    assert.equal(view.slack_ts, '1800000000.654321');
  });

  it('getOne: throws NotFoundException for unknown id', async () => {
    await assert.rejects(
      () => svc.getOne(orgId, randomUUID()),
      NotFoundException,
    );
  });

  it('list: respects the limit parameter', async () => {
    for (let i = 0; i < 3; i++) {
      const [a] = await db
        .insert(actions)
        .values({
          orgId,
          agentId,
          tool: `test.limit.${i}`,
          params: {},
          status: 'awaiting_approval',
        })
        .returning();
      await db.insert(approvals).values({
        actionId: a!.id,
        requiredRole: 'approver',
        decision: 'pending',
      });
    }

    const limited = await svc.list(orgId, 2);
    assert.equal(limited.items.length, 2);
    const all = await svc.list(orgId);
    assert.equal(all.items.length, 3);
  });

  it('getOne: exposes decided_by_email after a decision', async () => {
    const [a] = await db
      .insert(actions)
      .values({
        orgId,
        agentId,
        tool: 'test.decided',
        params: {},
        status: 'awaiting_approval',
        policyDecision: { effect: 'require_approval' } as Record<string, unknown>,
      })
      .returning();
    const [approval] = await db
      .insert(approvals)
      .values({
        actionId: a!.id,
        requiredRole: 'approver',
        decision: 'pending',
        expiresAt: new Date(Date.now() + 3_600_000),
      })
      .returning();

    await svc.decide({
      approvalId: approval!.id,
      orgId,
      decision: 'deny',
      decidedByEmail: 'who@agentbase.test',
    });

    const view = await svc.getOne(orgId, approval!.id);
    assert.equal(view.decision, 'denied');
    assert.equal(view.decided_by_email, 'who@agentbase.test');
    assert.ok(view.decided_at);
  });
});
