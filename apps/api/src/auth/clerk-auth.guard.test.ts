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
import { UnauthenticatedProductionError } from './auth-mode.js';

class FakeConfig {
  constructor(private readonly env: Record<string, string | undefined> = {}) {}
  get<T = string>(key: string): T | undefined {
    return this.env[key] as T | undefined;
  }
}

function makeContext(
  headers: Record<string, string>,
  request: {
    method?: string;
    url?: string;
    routerPath?: string;
    routeOptions?: { url?: string };
  } = {},
): ExecutionContext {
  const req = { headers, ...request };
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

  it('treats a whitespace-only CLERK_SECRET_KEY as unset', async () => {
    const guard = new ClerkAuthGuard(
      new FakeConfig({ CLERK_SECRET_KEY: '   ' }) as unknown as ConfigService,
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

  it('returns machine-readable recovery guidance when an agent tries to self-register', async () => {
    const guard = enforcedGuard();
    let error: unknown;

    try {
      await guard.canActivate(
        makeContext({}, { method: 'POST', url: '/v1/agents' }),
      );
    } catch (err) {
      error = err;
    }

    assert.ok(error instanceof UnauthorizedException);
    assert.deepEqual(error.getResponse(), {
      error: 'agent_registration_requires_human_provisioning',
      message:
        'Agents cannot self-register without a Clerk session. A human operator must register the agent and provision a scoped agb_ key first.',
      recovery:
        'Have a human operator sign in to Agentbase, register the agent, and pass the scoped agb_ key to the agent.',
      docs_url:
        'https://github.com/Evode-Manirahari/Agentbase#smoke-test-the-loop',
    });
  });

  it('does not show agent-registration recovery guidance for other management routes', async () => {
    const guard = enforcedGuard();
    let error: unknown;

    try {
      await guard.canActivate(
        makeContext({}, { method: 'GET', url: '/v1/agents' }),
      );
    } catch (err) {
      error = err;
    }

    assert.ok(error instanceof UnauthorizedException);
    assert.deepEqual(error.getResponse(), {
      message: 'missing Clerk session token',
      error: 'Unauthorized',
      statusCode: 401,
    });
  });

  it('trims CLERK_SECRET_KEY before storing it', () => {
    const guard = new ClerkAuthGuard(
      new FakeConfig({
        CLERK_SECRET_KEY: '  sk_test_fake_for_unit_tests_only  ',
      }) as unknown as ConfigService,
    ) as unknown as { secretKey: string | null };
    assert.equal(guard.secretKey, 'sk_test_fake_for_unit_tests_only');
  });

  it('fails closed if enforced mode has no secret key', async () => {
    const guard = enforcedGuard() as unknown as {
      secretKey: string | null;
      canActivate(ctx: ExecutionContext): Promise<boolean>;
    };
    guard.secretKey = null;
    await assert.rejects(
      () => guard.canActivate(makeContext({ authorization: 'Bearer token' })),
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

describe('ClerkAuthGuard — production refusal', () => {
  it('throws at construction when NODE_ENV=production and CLERK_SECRET_KEY is missing', () => {
    assert.throws(
      () =>
        new ClerkAuthGuard(
          new FakeConfig({
            NODE_ENV: 'production',
          }) as unknown as ConfigService,
        ),
      UnauthenticatedProductionError,
    );
  });

  it('throws when production NODE_ENV has surrounding whitespace', () => {
    assert.throws(
      () =>
        new ClerkAuthGuard(
          new FakeConfig({
            NODE_ENV: ' production ',
          }) as unknown as ConfigService,
        ),
      UnauthenticatedProductionError,
    );
  });

  it('accepts AGENTBASE_ALLOW_UNAUTHENTICATED=1 as an explicit prod opt-in', () => {
    const guard = new ClerkAuthGuard(
      new FakeConfig({
        NODE_ENV: 'production',
        AGENTBASE_ALLOW_UNAUTHENTICATED: '1',
      }) as unknown as ConfigService,
    );
    // No throw at construction; behaves like dev passthrough at request time.
    return guard
      .canActivate(makeContext({}))
      .then((ok) => assert.equal(ok, true));
  });
});
