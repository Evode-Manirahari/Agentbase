// Pure tests for SlackSignatureGuard — exercises HMAC verify and replay window.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import {
  ServiceUnavailableException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { SlackSignatureGuard } from './slack-signature.guard.js';

class FakeConfig {
  constructor(private readonly map: Record<string, string | undefined> = {}) {}
  get<T = string>(key: string): T | undefined {
    return this.map[key] as T | undefined;
  }
}

function makeContext(
  headers: Record<string, string>,
  rawBody: Buffer | undefined,
): ExecutionContext {
  const req = { headers, rawBody };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function sign(secret: string, ts: string, body: string): string {
  const base = `v0:${ts}:${body}`;
  return `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
}

function nowSec(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe('SlackSignatureGuard', () => {
  it('throws ServiceUnavailableException when SLACK_SIGNING_SECRET unset', () => {
    const guard = new SlackSignatureGuard(new FakeConfig() as unknown as ConfigService);
    const ctx = makeContext({}, Buffer.from(''));
    assert.throws(() => guard.canActivate(ctx), ServiceUnavailableException);
  });

  it('throws UnauthorizedException when raw body is missing', () => {
    const guard = new SlackSignatureGuard(
      new FakeConfig({ SLACK_SIGNING_SECRET: 's' }) as unknown as ConfigService,
    );
    const ctx = makeContext(
      {
        'x-slack-request-timestamp': nowSec(),
        'x-slack-signature': 'v0=abc',
      },
      undefined,
    );
    assert.throws(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('throws UnauthorizedException when signature header is missing', () => {
    const guard = new SlackSignatureGuard(
      new FakeConfig({ SLACK_SIGNING_SECRET: 's' }) as unknown as ConfigService,
    );
    const ctx = makeContext(
      { 'x-slack-request-timestamp': nowSec() },
      Buffer.from('payload=test'),
    );
    assert.throws(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('throws UnauthorizedException when timestamp is older than 5 minutes', () => {
    const secret = 'test-secret';
    const guard = new SlackSignatureGuard(
      new FakeConfig({ SLACK_SIGNING_SECRET: secret }) as unknown as ConfigService,
    );
    const oldTs = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const body = 'payload=test';
    const sig = sign(secret, oldTs, body);
    const ctx = makeContext(
      {
        'x-slack-request-timestamp': oldTs,
        'x-slack-signature': sig,
      },
      Buffer.from(body),
    );
    assert.throws(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('throws UnauthorizedException on signature mismatch (wrong secret)', () => {
    const secret = 'real-secret';
    const guard = new SlackSignatureGuard(
      new FakeConfig({ SLACK_SIGNING_SECRET: secret }) as unknown as ConfigService,
    );
    const ts = nowSec();
    const body = 'payload=test';
    const wrongSig = sign('attacker-secret', ts, body);
    const ctx = makeContext(
      {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': wrongSig,
      },
      Buffer.from(body),
    );
    assert.throws(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('throws UnauthorizedException when body has been tampered with', () => {
    const secret = 'test-secret';
    const guard = new SlackSignatureGuard(
      new FakeConfig({ SLACK_SIGNING_SECRET: secret }) as unknown as ConfigService,
    );
    const ts = nowSec();
    const originalBody = 'payload=original';
    const sig = sign(secret, ts, originalBody);
    const ctx = makeContext(
      {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      Buffer.from('payload=tampered'),
    );
    assert.throws(() => guard.canActivate(ctx), UnauthorizedException);
  });

  it('returns true when signature is valid and timestamp is fresh', () => {
    const secret = 'test-secret';
    const guard = new SlackSignatureGuard(
      new FakeConfig({ SLACK_SIGNING_SECRET: secret }) as unknown as ConfigService,
    );
    const ts = nowSec();
    const body = 'payload=%7B%22type%22%3A%22block_actions%22%7D';
    const sig = sign(secret, ts, body);
    const ctx = makeContext(
      {
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      Buffer.from(body),
    );
    assert.equal(guard.canActivate(ctx), true);
  });

  it('throws UnauthorizedException for non-numeric timestamp', () => {
    const secret = 'test-secret';
    const guard = new SlackSignatureGuard(
      new FakeConfig({ SLACK_SIGNING_SECRET: secret }) as unknown as ConfigService,
    );
    const body = 'payload=test';
    const sig = sign(secret, 'not-a-number', body);
    const ctx = makeContext(
      {
        'x-slack-request-timestamp': 'not-a-number',
        'x-slack-signature': sig,
      },
      Buffer.from(body),
    );
    assert.throws(() => guard.canActivate(ctx), UnauthorizedException);
  });
});
