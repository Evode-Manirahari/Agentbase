// Integration tests against real Redis. Default URL matches docker-compose.dev:
// redis://localhost:6380. Each test uses a unique (orgId, agentId, tool) tuple
// so the keyspace is isolated and no flush is needed.

import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { RateLimitService } from './rate-limit.service.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

let redis: Redis;

before(async () => {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
});

after(async () => {
  await redis.quit();
});

function configFor(env: Record<string, string>): ConfigService {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
}

function newService(env: Record<string, string> = {}): RateLimitService {
  return new RateLimitService(redis, configFor(env));
}

describe('RateLimitService', () => {
  it('allows under the limit, blocks at the limit, returns retry_after_sec', async () => {
    const svc = newService({ RATE_LIMIT_TOOL_PER_MIN: '3', RATE_LIMIT_AGENT_PER_MIN: '100' });
    const orgId = randomUUID();
    const agentId = randomUUID();
    const tool = 't.under_limit';

    for (let i = 0; i < 3; i++) {
      const r = await svc.check({ orgId, agentId, tool });
      assert.equal(r.ok, true, `request ${i + 1} should be allowed`);
    }
    const blocked = await svc.check({ orgId, agentId, tool });
    assert.equal(blocked.ok, false);
    if (blocked.ok === false) {
      assert.equal(blocked.scope, 'tool');
      assert.equal(blocked.limit, 3);
      assert.equal(blocked.retry_after_sec, 60);
    }
  });

  it('per-tool limit is independent: same agent, different tool, both fresh budgets', async () => {
    const svc = newService({ RATE_LIMIT_TOOL_PER_MIN: '2', RATE_LIMIT_AGENT_PER_MIN: '100' });
    const orgId = randomUUID();
    const agentId = randomUUID();

    for (let i = 0; i < 2; i++) {
      assert.equal((await svc.check({ orgId, agentId, tool: 'tool.A' })).ok, true);
    }
    assert.equal((await svc.check({ orgId, agentId, tool: 'tool.A' })).ok, false);
    // tool.B has its own budget — first call still passes.
    assert.equal((await svc.check({ orgId, agentId, tool: 'tool.B' })).ok, true);
  });

  it('per-agent limit catches abuse spread across many tools', async () => {
    const svc = newService({ RATE_LIMIT_TOOL_PER_MIN: '100', RATE_LIMIT_AGENT_PER_MIN: '3' });
    const orgId = randomUUID();
    const agentId = randomUUID();

    for (let i = 0; i < 3; i++) {
      const r = await svc.check({ orgId, agentId, tool: `tool.${i}` });
      assert.equal(r.ok, true);
    }
    const blocked = await svc.check({ orgId, agentId, tool: 'tool.4' });
    assert.equal(blocked.ok, false);
    if (blocked.ok === false) assert.equal(blocked.scope, 'agent');
  });

  it('different agents in same org have independent budgets', async () => {
    const svc = newService({ RATE_LIMIT_TOOL_PER_MIN: '1', RATE_LIMIT_AGENT_PER_MIN: '100' });
    const orgId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();

    assert.equal((await svc.check({ orgId, agentId: agentA, tool: 't.x' })).ok, true);
    assert.equal((await svc.check({ orgId, agentId: agentA, tool: 't.x' })).ok, false);
    // agentB starts fresh.
    assert.equal((await svc.check({ orgId, agentId: agentB, tool: 't.x' })).ok, true);
  });

  it('RATE_LIMIT_DISABLED=1 short-circuits all checks', async () => {
    const svc = newService({
      RATE_LIMIT_TOOL_PER_MIN: '1',
      RATE_LIMIT_AGENT_PER_MIN: '1',
      RATE_LIMIT_DISABLED: '1',
    });
    const orgId = randomUUID();
    const agentId = randomUUID();
    for (let i = 0; i < 5; i++) {
      assert.equal((await svc.check({ orgId, agentId, tool: 't.dis' })).ok, true);
    }
  });

  it('invalid env values fall back to defaults (60/600)', async () => {
    const svc = newService({
      RATE_LIMIT_TOOL_PER_MIN: 'not-a-number',
      RATE_LIMIT_AGENT_PER_MIN: '-5',
    });
    // Defaults of 60/600 are well above what the test triggers; any allowed
    // result confirms the parser didn't blow up.
    const r = await svc.check({
      orgId: randomUUID(),
      agentId: randomUUID(),
      tool: 't.fallback',
    });
    assert.equal(r.ok, true);
  });

  it('fail-open on Redis failure: uses a broken client, returns ok', async () => {
    const broken = {
      eval: async () => {
        throw new Error('connection refused');
      },
    } as unknown as Redis;
    const svc = new RateLimitService(
      broken,
      configFor({ RATE_LIMIT_TOOL_PER_MIN: '60', RATE_LIMIT_AGENT_PER_MIN: '600' }),
    );
    const r = await svc.check({
      orgId: randomUUID(),
      agentId: randomUUID(),
      tool: 't.broken',
    });
    assert.equal(r.ok, true);
  });
});
