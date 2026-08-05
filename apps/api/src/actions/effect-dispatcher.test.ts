// The claim these tests exist to make binary:
//
//   Approve one irreversible operation. Crash the orchestrator before, during,
//   and after the provider's response. Retry ten times. The effect happens NO
//   MORE THAN ONCE, and an outcome we never learned is quarantined rather than
//   blindly repeated. Replay the incident offline and the recorded result comes
//   back without a single new request reaching the provider.
//
// A permissions gateway cannot make this claim, because it is not a claim about
// permission. Everything here is measured against a fake provider that counts
// the effects that ACTUALLY exist on its side — not the calls we think we made.
//
// Requires Postgres on $DATABASE_URL.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ConfigService } from '@nestjs/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { schema, orgs, agents, actions, auditLog, effectReceipts } from '@agentbase/db';
import type {
  Connector,
  ConnectorInvokeContext,
  ConnectorResult,
  IdempotencyMode,
} from '@agentbase/connector-hubspot';
import { EffectDispatcher } from './effect-dispatcher.service.js';
import { EffectReceiptsService } from './effect-receipts.service.js';
import { RequestHashMismatchError, requestHash } from './effect-commit.js';
import { AuditService } from '../audit/audit.service.js';

const DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://agentbase:agentbase@localhost:5433/agentbase';

/**
 * Stands in for GitHub / Stripe / Terraform. Two things make it a fair test:
 *
 *  - `committed` is the set of effects that genuinely exist on its side. This
 *    is the number the claim is about. Counting our own calls would be
 *    self-serving.
 *  - it honours the idempotency key the way a real provider does: the same key
 *    returns the first effect instead of creating a second one.
 */
class FakeProvider implements Connector {
  readonly name = 'fake-github';
  /** Effects that actually exist, keyed by the idempotency key that made them. */
  readonly committed = new Map<string, string>();
  /** Every request that reached the provider, duplicates included. */
  readonly requests: Array<string | undefined> = [];
  /** Where to inject a failure on the NEXT call. */
  crash: 'none' | 'before_effect' | 'after_effect' = 'none';

  async invoke(
    _tool: string,
    _params: Record<string, unknown>,
    ctx?: ConnectorInvokeContext,
  ): Promise<ConnectorResult> {
    const key = ctx?.idempotencyKey;
    this.requests.push(key);

    if (this.crash === 'before_effect') {
      throw new Error('connection reset before the provider processed it');
    }

    // Provider-side idempotency: the same key never makes a second effect.
    // No key means the provider CANNOT dedupe, so every call is a fresh
    // effect — which is exactly what a real one does, and what makes the
    // at-most-once assertion falsifiable rather than decorative.
    const dedupeKey = key ?? randomUUID();
    const existing = this.committed.get(dedupeKey);
    if (existing) {
      return { ok: true, data: { deleted: true, deduped: true }, providerRef: existing };
    }

    const ref = `sha-${this.committed.size + 1}`;
    this.committed.set(dedupeKey, ref);

    if (this.crash === 'after_effect') {
      // The branch is gone. We will never learn that.
      throw new Error('socket closed after the provider committed');
    }
    return { ok: true, data: { deleted: true }, providerRef: ref };
  }

  supports(): boolean {
    return true;
  }

  /** Declared 'key' by default; individual tests override to widen coverage. */
  idempotency?: (tool: string) => IdempotencyMode = () => 'key';
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

function dispatcher(replay = false): EffectDispatcher {
  const config = {
    get: (k: string) =>
      k === 'AGENTBASE_REPLAY' ? (replay ? '1' : undefined) : undefined,
  } as unknown as ConfigService;
  return new EffectDispatcher(new EffectReceiptsService(db, audit), config);
}

describe('effect commit protocol', () => {
  let orgId: string;
  let agentId: string;
  let actionId: string;
  let provider: FakeProvider;
  let effects: EffectDispatcher;

  const TOOL = 'github.branches.delete';
  const PARAMS = { repo: 'acme/api', branch: 'release/v2' };

  beforeEach(async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug: `eff-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;
    const [agent] = await db
      .insert(agents)
      .values({ orgId, name: 'effects-agent' })
      .returning();
    agentId = agent!.id;
    const [action] = await db
      .insert(actions)
      .values({
        orgId,
        agentId,
        tool: TOOL,
        params: PARAMS,
        status: 'approved',
        requestHash: requestHash(TOOL, PARAMS),
        dispatchState: 'in_flight',
        dispatchedAt: new Date(),
      })
      .returning();
    actionId = action!.id;

    provider = new FakeProvider();
    effects = dispatcher();
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  function dispatch(d = effects) {
    return d.dispatch({
      actionId,
      tool: TOOL,
      params: PARAMS,
      approvedRequestHash: requestHash(TOOL, PARAMS),
      connector: provider,
    });
  }

  // -------------------------------------------------------------------
  // The headline claim.
  // -------------------------------------------------------------------

  it('commits once and records a receipt carrying the provider reference', async () => {
    const out = await dispatch();

    assert.equal(out.result.ok, true);
    assert.equal(provider.committed.size, 1, 'exactly one effect exists');

    const [receipt] = await db
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.actionId, actionId));
    assert.equal(receipt!.outcome, 'committed');
    assert.equal(receipt!.attempt, 1);
    assert.equal(receipt!.providerRef, 'sha-1', "the provider's own word for it");
    assert.ok(receipt!.idempotencyKeySent, 'the key that was on the wire is recorded');
    assert.ok(receipt!.settledAt);
  });

  it('a crash AFTER the effect landed is quarantined, not settled', async () => {
    provider.crash = 'after_effect';
    await assert.rejects(dispatch());

    // The branch is gone.
    assert.equal(provider.committed.size, 1);

    // And we do not claim to know that. Asserting `failed` here would be a lie
    // in the dangerous direction: it says nothing happened when something did.
    const [receipt] = await db
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.actionId, actionId));
    assert.equal(receipt!.outcome, 'indeterminate');
    assert.equal(receipt!.settledAt, null);
  });

  it('ten retries across every crash point produce at most one effect', async () => {
    // Walk the failure modes in the order they hurt: before the provider sees
    // it, after it commits but before we hear, then a clean run — then keep
    // retrying well past the point an agent would have given up.
    const script: Array<FakeProvider['crash']> = [
      'before_effect',
      'after_effect',
      'before_effect',
      'none',
      'none',
      'none',
      'after_effect',
      'none',
      'none',
      'none',
    ];

    let succeeded = 0;
    for (const crash of script) {
      provider.crash = crash;
      try {
        const out = await dispatch();
        if (out.result.ok) succeeded += 1;
      } catch {
        // A throw means we do not know. That is a legitimate outcome here.
      }
    }

    // THE CLAIM. Ten attempts, three crashes, one branch deletion.
    assert.equal(
      provider.committed.size,
      1,
      `expected exactly one committed effect, got ${provider.committed.size}`,
    );
    assert.ok(succeeded > 0, 'at least one attempt resolved to a known success');
    assert.ok(provider.requests.length >= 10, 'the retries really did reach out');

    // Every attempt shared one key — that is what collapsed them provider-side.
    const keys = new Set(provider.requests);
    assert.equal(keys.size, 1, 'all attempts carried the same idempotency key');

    // And the history is complete: one row per attempt, nothing overwritten.
    const history = await db
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.actionId, actionId));
    assert.equal(history.length, script.length);
    assert.deepEqual(
      history.map((h) => h.attempt).sort((a, b) => a - b),
      Array.from({ length: script.length }, (_, i) => i + 1),
      'attempts are numbered contiguously with no gaps or duplicates',
    );
  });

  it('concurrent dispatchers cannot take the same attempt number', async () => {
    // The unique (action_id, attempt) index is the claim. Without it two racing
    // dispatchers both write attempt 1 and one effect disappears from history.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => dispatch()),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length > 0);

    assert.equal(provider.committed.size, 1, 'still exactly one effect');

    const history = await db
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.actionId, actionId));
    const attempts = history.map((h) => h.attempt);
    assert.equal(
      new Set(attempts).size,
      attempts.length,
      'no two attempts share a number',
    );
  });

  // -------------------------------------------------------------------
  // Replay.
  // -------------------------------------------------------------------

  it('replay returns the recorded receipt and reaches no provider at all', async () => {
    await dispatch();
    assert.equal(provider.requests.length, 1);
    const liveRequests = provider.requests.length;

    const out = await dispatch(dispatcher(true));

    assert.equal(out.replayed, true);
    assert.equal(out.result.ok, true);
    assert.equal(out.result.providerRef, 'sha-1', 'the original reference, verbatim');
    // THE SECOND CLAIM. Not one new request.
    assert.equal(
      provider.requests.length,
      liveRequests,
      'replay must not touch the provider',
    );
    assert.equal(provider.committed.size, 1);
  });

  it('replay of an effect that never committed refuses to go and find out', async () => {
    provider.crash = 'after_effect';
    await assert.rejects(dispatch());
    const before = provider.requests.length;

    const out = await dispatch(dispatcher(true));

    assert.equal(out.replayed, true);
    assert.equal(out.result.ok, false);
    assert.equal(out.result.error?.code, 'no_receipt');
    // The effect may well exist — but replay is not allowed to ask.
    assert.equal(provider.requests.length, before);
  });

  it('replay mode is a hard switch, not a per-call argument', async () => {
    const replaying = dispatcher(true);
    assert.equal(replaying.isReplay(), true);
    assert.equal(dispatcher(false).isReplay(), false);

    // Even with a live connector in hand it cannot reach one.
    await dispatch(replaying);
    assert.equal(provider.requests.length, 0);
  });

  // -------------------------------------------------------------------
  // Approval binding.
  // -------------------------------------------------------------------

  it('refuses to commit when the request no longer matches what was approved', async () => {
    await assert.rejects(
      effects.dispatch({
        actionId,
        tool: TOOL,
        // A human approved release/v2. This is main.
        params: { repo: 'acme/api', branch: 'main' },
        approvedRequestHash: requestHash(TOOL, PARAMS),
        connector: provider,
      }),
      RequestHashMismatchError,
    );

    assert.equal(provider.requests.length, 0, 'nothing reached the provider');
    const history = await db
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.actionId, actionId));
    assert.equal(history.length, 0, 'no attempt was even opened');
  });

  it('a null approved hash is grandfathered, not blocked', async () => {
    // Rows predating the column must not deadlock every pending approval.
    const out = await effects.dispatch({
      actionId,
      tool: TOOL,
      params: PARAMS,
      approvedRequestHash: null,
      connector: provider,
    });
    assert.equal(out.result.ok, true);
  });

  // -------------------------------------------------------------------
  // The guarantee is conditional on the provider, and says so.
  // -------------------------------------------------------------------

  describe('idempotency mode', () => {
    it('sends no key to a provider that does not honour one', async () => {
      // Attaching a key here would record a guarantee we do not have.
      const noDedupe = new FakeProvider();
      noDedupe.idempotency = () => 'none';
      await effects.dispatch({
        actionId,
        tool: TOOL,
        params: PARAMS,
        approvedRequestHash: null,
        connector: noDedupe,
      });
      assert.equal(noDedupe.requests[0], undefined, 'no key on the wire');

      const [r] = await db
        .select()
        .from(effectReceipts)
        .where(eq(effectReceipts.actionId, actionId));
      assert.equal(r!.idempotencyMode, 'none');
      assert.equal(r!.idempotencyKeySent, null);
    });

    it('an undeclared connector is treated as none, not assumed safe', async () => {
      const undeclared = new FakeProvider();
      delete (undeclared as Partial<FakeProvider>).idempotency;
      await effects.dispatch({
        actionId,
        tool: TOOL,
        params: PARAMS,
        approvedRequestHash: null,
        connector: undeclared,
      });
      const [r] = await db
        .select()
        .from(effectReceipts)
        .where(eq(effectReceipts.actionId, actionId));
      assert.equal(r!.idempotencyMode, 'none', 'pessimistic default');
    });

    it('records the mode that was in force at the time of the attempt', async () => {
      await dispatch(); // FakeProvider declares 'key'
      const [r] = await db
        .select()
        .from(effectReceipts)
        .where(eq(effectReceipts.actionId, actionId));
      assert.equal(r!.idempotencyMode, 'key');
      assert.ok(r!.idempotencyKeySent);
    });

    it('without provider dedupe, retries really do duplicate — which is why the guard exists', async () => {
      const noDedupe = new FakeProvider();
      noDedupe.idempotency = () => 'none';
      for (let i = 0; i < 3; i++) {
        await effects.dispatch({
          actionId,
          tool: TOOL,
          params: PARAMS,
          approvedRequestHash: null,
          connector: noDedupe,
        });
      }
      // Not a bug in the protocol — a fact about the provider. The protocol's
      // job is to refuse to retry into it, not to pretend it is safe.
      assert.equal(noDedupe.committed.size, 3);
    });
  });

  // -------------------------------------------------------------------
  // Ending a quarantine. An indeterminate state with no exit is a leak, not
  // a safety property — a human has to be able to say what they found.
  // -------------------------------------------------------------------

  describe('operator resolution', () => {
    let receipts: EffectReceiptsService;

    beforeEach(() => {
      receipts = new EffectReceiptsService(db, audit);
    });

    async function quarantined(): Promise<string> {
      provider.crash = 'after_effect';
      await assert.rejects(dispatch());
      const [r] = await db
        .select()
        .from(effectReceipts)
        .where(eq(effectReceipts.actionId, actionId));
      assert.equal(r!.outcome, 'indeterminate');
      return r!.id;
    }

    it('surfaces an indeterminate attempt on the operator queue', async () => {
      await quarantined();
      const queue = await receipts.indeterminateForOrg(orgId);
      assert.equal(queue.length, 1);
      assert.equal(queue[0]!.action_id, actionId);
      assert.equal(queue[0]!.tool, TOOL);
      assert.ok(queue[0]!.idempotency_key_sent, 'the operator can see the key to search on');
    });

    it('resolving committed settles the receipt and the action, without re-dispatching', async () => {
      const receiptId = await quarantined();
      const requestsBefore = provider.requests.length;

      await receipts.resolve({
        orgId,
        receiptId,
        outcome: 'committed',
        providerRef: 'sha-1',
        operatorId: 'alice@agentbase.test',
        note: 'confirmed deleted in the GitHub UI',
      });

      // Critically: resolving is NOT a retry. If the effect already landed,
      // attempting it again is the exact failure this whole protocol prevents.
      assert.equal(provider.requests.length, requestsBefore);

      const [r] = await db
        .select()
        .from(effectReceipts)
        .where(eq(effectReceipts.id, receiptId));
      assert.equal(r!.outcome, 'committed');
      assert.equal(r!.providerRef, 'sha-1');
      assert.ok(r!.settledAt);

      const [a] = await db.select().from(actions).where(eq(actions.id, actionId));
      assert.equal(a!.status, 'executed');
      assert.equal(a!.dispatchState, 'settled');
    });

    it('resolving failed marks the action failed', async () => {
      const receiptId = await quarantined();
      await receipts.resolve({
        orgId,
        receiptId,
        outcome: 'failed',
        operatorId: 'alice@agentbase.test',
      });
      const [a] = await db.select().from(actions).where(eq(actions.id, actionId));
      assert.equal(a!.status, 'failed');
      assert.equal(a!.dispatchState, 'settled');
    });

    it('leaves an audit event naming the human who decided', async () => {
      const receiptId = await quarantined();
      await receipts.resolve({
        orgId,
        receiptId,
        outcome: 'committed',
        operatorId: 'alice@agentbase.test',
      });
      const events = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.orgId, orgId));
      const resolved = events.filter((e) => e.eventType === 'effect.resolved');
      assert.equal(resolved.length, 1);
      assert.equal(resolved[0]!.actorId, 'alice@agentbase.test');
    });

    it('two operators resolving the same attempt: one wins, one gets a conflict', async () => {
      const receiptId = await quarantined();
      const outcomes = await Promise.allSettled([
        receipts.resolve({
          orgId,
          receiptId,
          outcome: 'committed',
          operatorId: 'alice@agentbase.test',
        }),
        receipts.resolve({
          orgId,
          receiptId,
          outcome: 'failed',
          operatorId: 'bob@agentbase.test',
        }),
      ]);
      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((o) => o.status === 'rejected').length, 1);
    });

    it('refuses to resolve an attempt that already settled itself', async () => {
      await dispatch(); // clean run — settles `committed` on its own
      const [r] = await db
        .select()
        .from(effectReceipts)
        .where(eq(effectReceipts.actionId, actionId));
      await assert.rejects(
        receipts.resolve({
          orgId,
          receiptId: r!.id,
          outcome: 'failed',
          operatorId: 'alice@agentbase.test',
        }),
        ConflictException,
      );
    });

    it('cannot resolve another tenant’s receipt', async () => {
      const receiptId = await quarantined();
      const [other] = await db
        .insert(orgs)
        .values({ name: 'Other', slug: `oth-${randomUUID().slice(0, 8)}` })
        .returning();
      try {
        await assert.rejects(
          receipts.resolve({
            orgId: other!.id,
            receiptId,
            outcome: 'committed',
            operatorId: 'mallory@evil.test',
          }),
          NotFoundException,
        );
      } finally {
        await db.delete(orgs).where(eq(orgs.id, other!.id));
      }
    });

    it('history is scoped to the owning tenant', async () => {
      await quarantined();
      assert.equal((await receipts.historyForOrg(orgId, actionId)).length, 1);
      const [other] = await db
        .insert(orgs)
        .values({ name: 'Other', slug: `oth-${randomUUID().slice(0, 8)}` })
        .returning();
      try {
        assert.equal(
          (await receipts.historyForOrg(other!.id, actionId)).length,
          0,
          'another org sees nothing',
        );
      } finally {
        await db.delete(orgs).where(eq(orgs.id, other!.id));
      }
    });
  });

  it('a missing connector opens no attempt', async () => {
    const out = await effects.dispatch({
      actionId,
      tool: TOOL,
      params: PARAMS,
      approvedRequestHash: null,
      connector: null,
    });
    assert.equal(out.result.ok, false);
    assert.equal(out.result.error?.code, 'no_connector');
    const history = await db
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.actionId, actionId));
    assert.equal(history.length, 0);
  });
});
