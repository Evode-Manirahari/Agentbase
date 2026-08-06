// Authorization on the endpoint that ENDS a quarantine.
//
// This path had no test, which is how it shipped reading `req.auth` — a
// property the guard never sets — and recorded every resolution in enforced
// mode against the literal actor "operator", a user who does not exist. The
// fix to it also silently failed to apply once and was caught by lint rather
// than by a test. These pin the behaviour so neither can recur quietly.
//
// Needs Postgres on 5433: resolveActor() reads a real users row, and stubbing
// the database would test the stub rather than the org scoping.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { schema, orgs, users } from '@agentbase/db';
import type { Database } from '@agentbase/db';
import { EffectsController } from './effects.controller.js';
import type { EffectReceiptsService } from './effect-receipts.service.js';
import type { AgentsService } from '../agents/agents.service.js';

const DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://agentbase:agentbase@localhost:5433/agentbase';

const RECEIPT_UUID = '5c4b3a29-1807-4657-9483-a2b1c0d9e8f7';

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

before(() => {
  client = postgres(DB_URL, { max: 5 });
  db = drizzle(client, { schema });
});

after(async () => {
  await client.end();
});

class StubReceipts {
  resolveCalls: { operatorId: string; outcome: string; orgId: string }[] = [];

  async resolve(input: {
    orgId: string;
    receiptId: string;
    outcome: 'committed' | 'failed';
    operatorId: string;
  }) {
    this.resolveCalls.push({
      operatorId: input.operatorId,
      outcome: input.outcome,
      orgId: input.orgId,
    });
    return { actionId: 'act-1', attempt: 1 };
  }
}

function req(clerkUserId?: string): never {
  return (clerkUserId ? { clerkUser: { userId: clerkUserId } } : {}) as never;
}

describe('EffectsController.resolve — authorization', () => {
  let orgId: string;
  let receipts: StubReceipts;
  let controller: EffectsController;

  beforeEach(async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Effects', slug: `eff-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;

    receipts = new StubReceipts();
    controller = new EffectsController(
      receipts as unknown as EffectReceiptsService,
      { ensureDefaultOrg: async () => orgId } as unknown as AgentsService,
      db as unknown as Database,
    );
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  async function seed(role: 'admin' | 'approver' | 'viewer', targetOrg = orgId) {
    const clerkId = `clerk-${randomUUID().slice(0, 8)}`;
    await db.insert(users).values({
      orgId: targetOrg,
      email: `${role}@effects.test`,
      role,
      clerkId,
    });
    return clerkId;
  }

  it('attributes the resolution to the verified user, never to "operator"', async () => {
    // The regression itself: the operator recorded against the finding that
    // ends a quarantine must be the person who actually looked at the provider.
    const clerkId = await seed('approver');

    await controller.resolve(
      RECEIPT_UUID,
      { outcome: 'committed', provider_ref: 'prov-123' },
      req(clerkId),
    );

    assert.equal(receipts.resolveCalls.length, 1);
    const call = receipts.resolveCalls[0]!;
    assert.equal(call.operatorId, 'approver@effects.test');
    assert.notEqual(
      call.operatorId,
      'operator',
      'a resolution attributed to a user who does not exist is not evidence',
    );
    assert.equal(call.orgId, orgId);
  });

  it('refuses a viewer, and does not resolve the effect', async () => {
    // Declaring an unknown effect committed or failed is a decision, not a
    // read: it is what closes the quarantine the protocol opened on purpose.
    const clerkId = await seed('viewer');

    await assert.rejects(
      controller.resolve(RECEIPT_UUID, { outcome: 'committed' }, req(clerkId)),
      ForbiddenException,
    );
    assert.equal(
      receipts.resolveCalls.length,
      0,
      'a refused decision must not reach the ledger',
    );
  });

  it('admin satisfies the approver requirement', async () => {
    const clerkId = await seed('admin');
    await controller.resolve(RECEIPT_UUID, { outcome: 'failed' }, req(clerkId));
    assert.equal(receipts.resolveCalls[0]!.operatorId, 'admin@effects.test');
  });

  it('refuses a session authenticated against a different org', async () => {
    const [other] = await db
      .insert(orgs)
      .values({ name: 'Other', slug: `oth-${randomUUID().slice(0, 8)}` })
      .returning();
    try {
      const clerkId = await seed('admin', other!.id);
      await assert.rejects(
        controller.resolve(RECEIPT_UUID, { outcome: 'committed' }, req(clerkId)),
        UnauthorizedException,
      );
      assert.equal(receipts.resolveCalls.length, 0);
    } finally {
      await db.delete(orgs).where(eq(orgs.id, other!.id));
    }
  });

  it('records dev passthrough rather than naming someone who did not act', async () => {
    await controller.resolve(RECEIPT_UUID, { outcome: 'committed' }, req());
    assert.equal(receipts.resolveCalls[0]!.operatorId, 'dev-passthrough');
  });
});
