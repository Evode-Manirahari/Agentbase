// Full-stack wiring smoke test: boots AppModule, fakes only the LLM
// client, and runs one `agent.run` job end-to-end through the real
// BullMQ worker that QueueModule spins up at boot.
//
// This is the test that would have caught the silent-drop bug fixed in
// PR #28: when AgentRuntimeModule wasn't @Global, the worker's
// @Optional() injection of AgentRunProcessor resolved to undefined and
// every `agent.run` returned { skipped: true, reason: 'agent runtime
// not wired' }. Unit tests stubbed the worker out so the bug went
// unnoticed in CI for weeks.
//
// Requires Postgres on $DATABASE_URL and Redis on $REDIS_URL.

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { schema, orgs, agents, agentRuns } from '@dejavas/db';
import { AppModule } from '../app.module.js';
import { AgentRunsService } from './agent-runs.service.js';
import {
  LLM_CLIENT,
  type LlmChatResponse,
  type LlmClient,
} from './llm-client.js';

const DB_URL =
  process.env.DATABASE_URL ??
  'postgresql://dejavas:dejavas@localhost:5433/dejavas';

// Returns a single text block + end_turn so the agent loop terminates
// on iteration 1 with status 'completed'. No tool calls means no
// actions, no connectors, no policy evaluation — the test stays
// focused on the worker → processor → runtime wiring.
class FakeLlmClient implements LlmClient {
  public calls = 0;
  async chat(): Promise<LlmChatResponse> {
    this.calls += 1;
    return {
      content: [{ type: 'text', text: 'smoke-test ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }
}

const fakeLlm = new FakeLlmClient();

let app: INestApplicationContext;
let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;
let orgId: string | undefined;

before(async () => {
  client = postgres(DB_URL, { max: 5 });
  db = drizzle(client, { schema });

  // TestingModule extends NestApplicationContext, so we can init it
  // directly — no need to wrap it in a separate context. This also
  // boots QueueModule.onModuleInit, which is what starts the BullMQ
  // worker the test exercises.
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(LLM_CLIENT)
    .useValue(fakeLlm)
    .compile();

  app = moduleRef;
  await app.init();
});

after(async () => {
  if (orgId) {
    await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
    await db.delete(agents).where(eq(agents.orgId, orgId));
    await db.delete(orgs).where(eq(orgs.id, orgId));
  }
  await app?.close();
  await client?.end();
});

describe('agent-runtime wiring smoke', () => {
  it('runs an agent.run job end-to-end through the real worker', async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Smoke', slug: `smoke-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;
    const [agent] = await db
      .insert(agents)
      .values({ orgId, name: 'smoke-sdr' })
      .returning();
    const agentId = agent!.id;

    const runs = app.get(AgentRunsService);
    const created = await runs.create({
      orgId,
      agentId,
      jobKey: 'ai-sdr-outbound',
      context: { email: 'lead@example.com' },
    });

    // Poll the run row for a terminal state. The worker is the
    // in-process BullMQ Worker booted in QueueModule.onModuleInit;
    // with a fake LLM the loop terminates on iteration 1.
    const start = Date.now();
    const TIMEOUT_MS = 15_000;
    let final = created;
    while (Date.now() - start < TIMEOUT_MS) {
      final = await runs.get(orgId, created.id);
      if (final.status !== 'pending' && final.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // PR #28 regression guard: the silent-drop bug left rows stuck on
    // 'pending' forever because the worker returned early with
    // { skipped: true } before AgentRunProcessor.markRunning could
    // transition the row.
    assert.notEqual(
      final.status,
      'pending',
      'run stayed pending — worker silently dropped agent.run job (regression of PR #28)',
    );
    assert.notEqual(
      final.status,
      'running',
      'run stuck on running — worker never persisted a terminal result',
    );
    assert.equal(
      final.status,
      'completed',
      `expected completed, got ${final.status} (error=${final.error ?? 'none'})`,
    );
    assert.ok(
      fakeLlm.calls > 0,
      'fake LLM was never called — runtime did not run',
    );
  });
});
