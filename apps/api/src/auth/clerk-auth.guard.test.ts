// Unit tests for ClerkAuthGuard. The "valid token" path requires a real
// Clerk-issued JWT, which we can't generate offline — so we cover the
// dev-mode bypass and the rejection paths (missing/malformed token and
// invalid token shape). The signing-verification path is exercised in
// production by the @clerk/backend SDK itself.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ClerkAuthGuard } from './clerk-auth.guard.js';

class FakeConfig {
  constructor(private readonly env: Record<string, string | undefined> = {}) {}
  get<T = string>(key: string): T | undefined {
    return this.env[key] as T | undefined;
  }
}

function makeContext(headers: Record<string, string>): ExecutionContext {
  const req = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('ClerkAuthGuard — dev mode bypass', () => {
  it('passes any request through when CLERK_SECRET_KEY is unset', async () => {
    const guard = new ClerkAuthGuard(
      new FakeConfig() as unknown as ConfigService,
    );
    const ctx = makeContext({});
    assert.equal(await guard.canActivate(ctx), true);
  });

  it('passes through even without an Authorization header', async () => {
    const guard = new ClerkAuthGuard(
      new FakeConfig() as unknown as ConfigService,
    );
    const ctx = makeContext({ 'user-agent': 'curl' });
    assert.equal(await guard.canActivate(ctx), true);
  });

  it('treats an empty CLERK_SECRET_KEY as unset', async () => {
    const guard = new ClerkAuthGuard(
      new FakeConfig({ CLERK_SECRET_KEY: '' }) as unknown as ConfigService,
    );
    assert.equal(await guard.canActivate(makeContext({})), true);
  });
});

describe('ClerkAuthGuard — enforced mode (CLERK_SECRET_KEY set)', () => {
  // Use an obviously-fake secret. We never expect verifyToken to succeed
  // here — these tests exercise the request-shape rejection paths that
  // run before any network call to Clerk.
  function enforcedGuard() {
    return new ClerkAuthGuard(
      new FakeConfig({
        CLERK_SECRET_KEY: 'sk_test_fake_for_unit_tests_only',
      }) as unknown as ConfigService,
    );
  }

  it('rejects requests with no Authorization header', async () => {
    const guard = enforcedGuard();
    await assert.rejects(
      () => guard.canActivate(makeContext({})),
      UnauthorizedException,
    );
  });

  it('rejects Authorization without Bearer prefix', async () => {
    const guard = enforcedGuard();
    await assert.rejects(
      () =>
        guard.canActivate(makeContext({ authorization: 'Token abc.def.ghi' })),
      UnauthorizedException,
    );
  });

  it('rejects an empty Bearer token', async () => {
    const guard = enforcedGuard();
    await assert.rejects(
      () => guard.canActivate(makeContext({ authorization: 'Bearer ' })),
      UnauthorizedException,
    );
  });

  it('rejects a malformed JWT (verifyToken fails)', async () => {
    const guard = enforcedGuard();
    await assert.rejects(
      () =>
        guard.canActivate(
          makeContext({ authorization: 'Bearer not.a.real.jwt' }),
        ),
      UnauthorizedException,
    );
  });
});
