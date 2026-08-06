// Identity and authorization for decisions. Both were previously taken on
// trust: the approval endpoint read the decider's email out of the request
// body, and `approvals.required_role` was stored, selected, and never compared
// to anyone. That made approval a workflow step rather than an authorization
// boundary — the opposite of what it is sold as.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { schema, orgs, users } from '@agentbase/db';
import {
  requireRole,
  resolveActor,
  resolveSlackActor,
  roleSatisfies,
  type Actor,
} from './actor.js';

const DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://agentbase:agentbase@localhost:5433/agentbase';

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

before(() => {
  client = postgres(DB_URL, { max: 5 });
  db = drizzle(client, { schema });
});

after(async () => {
  await client.end();
});

function req(clerkUserId?: string): never {
  return (clerkUserId ? { clerkUser: { userId: clerkUserId } } : {}) as never;
}

describe('role lattice', () => {
  it('admin >= approver >= viewer', () => {
    assert.ok(roleSatisfies('admin', 'viewer'));
    assert.ok(roleSatisfies('admin', 'approver'));
    assert.ok(roleSatisfies('admin', 'admin'));
    assert.ok(roleSatisfies('approver', 'viewer'));
    assert.ok(roleSatisfies('approver', 'approver'));
    assert.ok(roleSatisfies('viewer', 'viewer'));
  });

  it('does not run the other way', () => {
    assert.equal(roleSatisfies('viewer', 'approver'), false);
    assert.equal(roleSatisfies('viewer', 'admin'), false);
    assert.equal(roleSatisfies('approver', 'admin'), false);
  });

  it('requireRole names the actor and the shortfall', () => {
    const viewer: Actor = {
      userId: 'u1',
      email: 'v@x.test',
      role: 'viewer',
      devPassthrough: false,
    };
    assert.throws(
      () => requireRole(viewer, 'approver', 'deciding approval a1'),
      (e: Error) =>
        /deciding approval a1/.test(e.message) &&
        /v@x.test/.test(e.message) &&
        e instanceof ForbiddenException,
    );
  });
});

describe('resolveActor', () => {
  let orgId: string;

  beforeEach(async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Actor', slug: `act-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('resolves a verified session to the org member', async () => {
    const clerkId = `clerk-${randomUUID().slice(0, 8)}`;
    await db.insert(users).values({
      orgId,
      email: 'approver@x.test',
      role: 'approver',
      clerkId,
    });

    const actor = await resolveActor(db, req(clerkId), orgId);
    assert.equal(actor.email, 'approver@x.test');
    assert.equal(actor.role, 'approver');
    assert.equal(actor.devPassthrough, false);
  });

  it('rejects a session authenticated against a DIFFERENT org', async () => {
    // Denied rather than auto-provisioned. Creating the membership on first
    // use would make cross-org access a matter of guessing a URL.
    const clerkId = `clerk-${randomUUID().slice(0, 8)}`;
    const [other] = await db
      .insert(orgs)
      .values({ name: 'Other', slug: `oth-${randomUUID().slice(0, 8)}` })
      .returning();
    await db.insert(users).values({
      orgId: other!.id,
      email: 'elsewhere@x.test',
      role: 'admin',
      clerkId,
    });
    try {
      await assert.rejects(
        resolveActor(db, req(clerkId), orgId),
        UnauthorizedException,
      );
    } finally {
      await db.delete(orgs).where(eq(orgs.id, other!.id));
    }
  });

  it('marks dev passthrough instead of impersonating a real person', async () => {
    // Without a session the guard lets the request through in dev mode. The
    // audit trail says `dev-passthrough` rather than naming someone who did
    // not act, and role checks are skipped because there is no identity.
    const actor = await resolveActor(db, req(), orgId);
    assert.equal(actor.devPassthrough, true);
    assert.equal(actor.email, 'dev-passthrough');
    assert.doesNotThrow(() => requireRole(actor, 'admin', 'anything'));
  });
});

describe('resolveSlackActor', () => {
  let orgId: string;

  beforeEach(async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Slack', slug: `slk-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('maps a verified Slack email to the org member and their role', async () => {
    await db.insert(users).values({
      orgId,
      email: 'slack@x.test',
      role: 'approver',
      clerkId: `clerk-${randomUUID().slice(0, 8)}`,
    });
    const actor = await resolveSlackActor(db, orgId, 'slack@x.test');
    assert.equal(actor.role, 'approver');
    assert.equal(actor.devPassthrough, false, 'a Slack click is never passthrough');
  });

  it('refuses when Slack gives no verified email', async () => {
    // The signature proves the request came from Slack. It says nothing about
    // who clicked, and a decision that cannot be attributed cannot be made.
    await assert.rejects(
      resolveSlackActor(db, orgId, null),
      ForbiddenException,
    );
  });

  it('refuses an email that is not a user in this org', async () => {
    // No auto-provisioning: anyone who can see the channel would otherwise
    // become a decider on first click.
    await assert.rejects(
      resolveSlackActor(db, orgId, 'stranger@x.test'),
      ForbiddenException,
    );
  });
});
