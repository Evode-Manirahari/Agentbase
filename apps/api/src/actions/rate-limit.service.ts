import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { REDIS_CONNECTION } from '../queue/queue.tokens.js';

export interface RateLimitOk {
  ok: true;
}

export interface RateLimitBlocked {
  ok: false;
  scope: 'tool' | 'agent';
  limit: number;
  retry_after_sec: number;
}

export type RateLimitResult = RateLimitOk | RateLimitBlocked;

const WINDOW_MS = 60_000;

// Atomic sliding-window counter:
// 1. ZREMRANGEBYSCORE evicts entries older than the window
// 2. ZCARD counts what's left
// 3. If under limit, ZADD this request and refresh TTL
// 4. Returns count *after* potential ZADD (or current count if blocked)
//
// Lua keeps the four ops atomic — without it, two requests racing past
// the limit could both pass the ZCARD check before either ZADDs.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now_ms - window_ms)
local count = tonumber(redis.call('ZCARD', key))

if count >= limit then
  return { 0, count }
end

redis.call('ZADD', key, now_ms, member)
redis.call('PEXPIRE', key, window_ms + 1000)
return { 1, count + 1 }
`;

@Injectable()
export class RateLimitService {
  private readonly log = new Logger(RateLimitService.name);
  private readonly perToolPerMin: number;
  private readonly perAgentPerMin: number;
  private readonly disabled: boolean;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.perToolPerMin = num(config.get('RATE_LIMIT_TOOL_PER_MIN'), 60);
    this.perAgentPerMin = num(config.get('RATE_LIMIT_AGENT_PER_MIN'), 600);
    this.disabled = config.get<string>('RATE_LIMIT_DISABLED') === '1';
    if (this.disabled) {
      this.log.warn('RATE_LIMIT_DISABLED=1 — rate limiter is OFF');
    } else {
      this.log.log(
        `rate limits: ${this.perToolPerMin}/min/tool · ${this.perAgentPerMin}/min/agent`,
      );
    }
  }

  async check(input: {
    orgId: string;
    agentId: string;
    tool: string;
  }): Promise<RateLimitResult> {
    if (this.disabled) return { ok: true };

    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2, 10)}`;

    try {
      // Per-tool first — narrower scope catches single-endpoint abuse early.
      const toolKey = `agentbase:rl:tool:${input.orgId}:${input.agentId}:${input.tool}`;
      const toolRes = await this.run(toolKey, now, this.perToolPerMin, member);
      if (!toolRes.ok) {
        return {
          ok: false,
          scope: 'tool',
          limit: this.perToolPerMin,
          retry_after_sec: 60,
        };
      }

      const agentKey = `agentbase:rl:agent:${input.orgId}:${input.agentId}`;
      const agentRes = await this.run(agentKey, now, this.perAgentPerMin, member);
      if (!agentRes.ok) {
        return {
          ok: false,
          scope: 'agent',
          limit: this.perAgentPerMin,
          retry_after_sec: 60,
        };
      }
      return { ok: true };
    } catch (err) {
      // Fail-open: a Redis blip should not block legitimate traffic, but it
      // does log so ops notices.
      this.log.warn(`rate limit check failed; allowing request: ${(err as Error).message}`);
      return { ok: true };
    }
  }

  private async run(
    key: string,
    nowMs: number,
    limit: number,
    member: string,
  ): Promise<{ ok: boolean; count: number }> {
    const res = (await this.redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(nowMs),
      String(WINDOW_MS),
      String(limit),
      member,
    )) as [number, number];
    return { ok: res[0] === 1, count: res[1] };
  }
}

function num(raw: unknown, fallback: number): number {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
