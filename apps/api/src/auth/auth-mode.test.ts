import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  resolveAuthMode,
  UnauthenticatedProductionError,
  type AuthModeEnv,
} from './auth-mode.js';

function env(overrides: AuthModeEnv = {}): AuthModeEnv {
  return { ...overrides };
}

describe('resolveAuthMode', () => {
  it("returns 'enforced' when CLERK_SECRET_KEY is set", () => {
    assert.equal(
      resolveAuthMode(env({ NODE_ENV: 'production', CLERK_SECRET_KEY: 'sk_live_x' })),
      'enforced',
    );
    assert.equal(
      resolveAuthMode(env({ NODE_ENV: 'development', CLERK_SECRET_KEY: 'sk_test_x' })),
      'enforced',
    );
  });

  it("returns 'dev_passthrough' outside production when secret is absent", () => {
    assert.equal(resolveAuthMode(env()), 'dev_passthrough');
    assert.equal(
      resolveAuthMode(env({ NODE_ENV: 'development' })),
      'dev_passthrough',
    );
    assert.equal(resolveAuthMode(env({ NODE_ENV: 'test' })), 'dev_passthrough');
    // Empty-string secret is treated as unset.
    assert.equal(
      resolveAuthMode(env({ NODE_ENV: 'development', CLERK_SECRET_KEY: '' })),
      'dev_passthrough',
    );
    // Whitespace-only secret is treated as unset.
    assert.equal(
      resolveAuthMode(env({ NODE_ENV: 'development', CLERK_SECRET_KEY: '   ' })),
      'dev_passthrough',
    );
  });

  it('throws in production when secret is absent and escape hatch is not set', () => {
    assert.throws(
      () => resolveAuthMode(env({ NODE_ENV: 'production' })),
      UnauthenticatedProductionError,
    );
    assert.throws(
      () => resolveAuthMode(env({ NODE_ENV: 'Production' })),
      UnauthenticatedProductionError,
      'NODE_ENV check is case-insensitive',
    );
    assert.throws(
      () => resolveAuthMode(env({ NODE_ENV: ' production ' })),
      UnauthenticatedProductionError,
      'NODE_ENV check ignores surrounding whitespace',
    );
    assert.throws(
      () =>
        resolveAuthMode(
          env({
            NODE_ENV: 'production',
            DEJAVAS_ALLOW_UNAUTHENTICATED: '0',
          }),
        ),
      UnauthenticatedProductionError,
      "escape hatch must be exactly '1' to opt in",
    );
    assert.throws(
      () =>
        resolveAuthMode(
          env({
            NODE_ENV: 'production',
            DEJAVAS_ALLOW_UNAUTHENTICATED: 'true',
          }),
        ),
      UnauthenticatedProductionError,
      "escape hatch must be exactly '1', not 'true'",
    );
  });

  it("accepts DEJAVAS_ALLOW_UNAUTHENTICATED=1 as an explicit production opt-in", () => {
    assert.equal(
      resolveAuthMode(
        env({
          NODE_ENV: 'production',
          DEJAVAS_ALLOW_UNAUTHENTICATED: '1',
        }),
      ),
      'dev_passthrough',
    );
    // Whitespace-tolerant.
    assert.equal(
      resolveAuthMode(
        env({
          NODE_ENV: 'production',
          DEJAVAS_ALLOW_UNAUTHENTICATED: ' 1 ',
        }),
      ),
      'dev_passthrough',
    );
  });

  it('the secret always wins over the escape hatch', () => {
    assert.equal(
      resolveAuthMode(
        env({
          NODE_ENV: 'production',
          CLERK_SECRET_KEY: 'sk_live_y',
          DEJAVAS_ALLOW_UNAUTHENTICATED: '1',
        }),
      ),
      'enforced',
    );
  });
});
