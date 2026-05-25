// Integration tests for ApiKeyGuard — require Postgres on $DATABASE_URL.

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
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { schema, orgs, agents, agentApiKeys } from '@agentbase/db';
import { ApiKeyGuard, type AuthedAgent } from './api-key.guard.js';
import { AgentsService } from '../agents/agents.service.js';
import { AuditService } from '../audit/audit.service.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://agentbase:agentbase@localhost:5433/agentbase';

interface FakeReq {
  headers: Record<string, string>;
  agent?: AuthedAgent;
}

function makeContext(headers: Record<string, string>): {
  ctx: ExecutionContext;
  req: FakeReq;
} {
  const req: FakeReq = { headers };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let agentsSvc: AgentsService;
let guard: ApiKeyGuard;

before(() => {
  client = postgres(DB_URL, { max: 5 });
  db = drizzle(client, { schema });
  const audit = new AuditService(db);
  agentsSvc = new AgentsService(db, audit);
  guard = new ApiKeyGuard(db);
});

after(async () => {
  await client.end();
});

describe('ApiKeyGuard — header shape', () => {
  it('rejects requests with no Authorization header', async () => {
    const { ctx } = makeContext({});
    await assert.rejects(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('rejects Authorization without Bearer prefix', async () => {
    const { ctx } = makeContext({ authorization: 'agb_anything-here-long-enough' });
    await assert.rejects(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('rejects Bearer with malformed key (no agb_ prefix)', async () => {
    const { ctx } = makeContext({
      authorization: 'Bearer not-a-agentbase-key-but-long-enough-to-try',
    });
    await assert.rejects(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('rejects Bearer with valid prefix but too short', async () => {
    const { ctx } = makeContext({ authorization: 'Bearer agb_short' });
    await assert.rejects(() => guard.canActivate(ctx), UnauthorizedException);
  });
});

describe('ApiKeyGuard — DB lookup', () => {
  let orgId: string;

  beforeEach(async () => {
    const slug = `gd-${randomUUID().slice(0, 8)}`;
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Test', slug })
      .returning();
    orgId = org!.id;
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('rejects a valid-shape key whose hash is not in the DB', async () => {
    const fake = `agb_${randomUUID().replace(/-/g, '')}-and-some-extra-padding`;
    const { ctx } = makeContext({ authorization: `Bearer ${fake}` });
    await assert.rejects(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('rejects a key whose row has revokedAt set', async () => {
    const reg = await agentsSvc.register({ orgId, name: 'tmp' });
    await db
      .update(agentApiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(agentApiKeys.agentId, reg.agent_id));

    const { ctx } = makeContext({ authorization: `Bearer ${reg.api_key}` });
    await assert.rejects(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('rejects when the agent.status is revoked', async () => {
    const reg = await agentsSvc.register({ orgId, name: 'will-revoke' });
    await db
      .update(agents)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(agents.id, reg.agent_id));

    const { ctx } = makeContext({ authorization: `Bearer ${reg.api_key}` });
    await assert.rejects(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('rejects when the agent.status is disabled', async () => {
    const reg = await agentsSvc.register({ orgId, name: 'will-disable' });
    await db
      .update(agents)
      .set({ status: 'disabled' })
      .where(eq(agents.id, reg.agent_id));

    const { ctx } = makeContext({ authorization: `Bearer ${reg.api_key}` });
    await assert.rejects(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('accepts a valid key for an active agent and populates req.agent', async () => {
    const reg = await agentsSvc.register({ orgId, name: 'live' });
    const { ctx, req } = makeContext({ authorization: `Bearer ${reg.api_key}` });

    const ok = await guard.canActivate(ctx);
    assert.equal(ok, true);
    assert.ok(req.agent);
    assert.equal(req.agent!.agentId, reg.agent_id);
    assert.equal(req.agent!.orgId, orgId);
    assert.match(req.agent!.apiKeyId, /^[0-9a-f-]{36}$/i);
  });

  it('two agents in the same org each authenticate to their own row', async () => {
    const a = await agentsSvc.register({ orgId, name: 'a' });
    const b = await agentsSvc.register({ orgId, name: 'b' });

    const { ctx: ctxA, req: reqA } = makeContext({
      authorization: `Bearer ${a.api_key}`,
    });
    await guard.canActivate(ctxA);
    assert.equal(reqA.agent!.agentId, a.agent_id);

    const { ctx: ctxB, req: reqB } = makeContext({
      authorization: `Bearer ${b.api_key}`,
    });
    await guard.canActivate(ctxB);
    assert.equal(reqB.agent!.agentId, b.agent_id);

    assert.notEqual(reqA.agent!.apiKeyId, reqB.agent!.apiKeyId);
  });

  it('invoking AgentsService.revoke causes subsequent guard calls to 401', async () => {
    const reg = await agentsSvc.register({ orgId, name: 'flip' });

    // pre-revoke: works
    const { ctx: ctxOK } = makeContext({
      authorization: `Bearer ${reg.api_key}`,
    });
    assert.equal(await guard.canActivate(ctxOK), true);

    // revoke
    await agentsSvc.revoke({ orgId, agentId: reg.agent_id });

    // post-revoke: 401
    const { ctx: ctxBad } = makeContext({
      authorization: `Bearer ${reg.api_key}`,
    });
    await assert.rejects(() => guard.canActivate(ctxBad), UnauthorizedException);
  });
});
