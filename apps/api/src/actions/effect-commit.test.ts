// Hashing decides two things that matter: whether a human's approval still
// applies to the request about to go out, and whether a retry is the SAME
// request to the provider or a new one. Both fail silently if the hash is
// unstable, so these are pinned hard.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  canonicalize,
  providerIdempotencyKey,
  requestHash,
  assertRequestUnchanged,
  RequestHashMismatchError,
} from './effect-commit.js';

describe('canonicalize', () => {
  it('is insensitive to key order at every depth', () => {
    assert.equal(
      canonicalize({ b: 1, a: { d: 2, c: 3 } }),
      canonicalize({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it('preserves array order — [a,b] is not [b,a]', () => {
    assert.notEqual(canonicalize({ x: [1, 2] }), canonicalize({ x: [2, 1] }));
  });

  it('treats an explicit undefined the way JSON does', () => {
    assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
  });

  it('distinguishes null from missing', () => {
    assert.notEqual(canonicalize({ a: 1, b: null }), canonicalize({ a: 1 }));
  });

  it('distinguishes types that stringify similarly', () => {
    assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: '1' }));
    assert.notEqual(canonicalize({ a: true }), canonicalize({ a: 'true' }));
  });

  it('handles nesting and empties', () => {
    assert.equal(canonicalize({}), '{}');
    assert.equal(canonicalize([]), '[]');
    assert.equal(canonicalize({ a: [{ b: 1 }] }), '{"a":[{"b":1}]}');
  });
});

describe('requestHash', () => {
  const params = { repo: 'acme/api', branch: 'release/v2' };

  it('is stable across key ordering', () => {
    assert.equal(
      requestHash('github.branches.delete', { branch: 'release/v2', repo: 'acme/api' }),
      requestHash('github.branches.delete', params),
    );
  });

  it('changes when any parameter changes', () => {
    assert.notEqual(
      requestHash('github.branches.delete', params),
      requestHash('github.branches.delete', { ...params, branch: 'main' }),
    );
  });

  it('changes when the tool changes even with identical params', () => {
    assert.notEqual(
      requestHash('github.branches.delete', params),
      requestHash('github.branches.archive', params),
    );
  });

  it('is a hex sha256', () => {
    assert.match(requestHash('t', {}), /^[0-9a-f]{64}$/);
  });

  it('separates tool from params so the boundary cannot be forged', () => {
    // A NUL delimiter cannot occur in a tool name, so no tool/params pair can
    // be re-cut to produce another pair's hash. Without a delimiter these two
    // would concatenate to the same string.
    assert.notEqual(requestHash('a', { x: 1 }), requestHash('a{"x":1}', {}));
  });
});

describe('providerIdempotencyKey', () => {
  it('is stable for one action — that is what collapses retries', () => {
    const id = '3f2a1b4c-0000-4000-8000-000000000001';
    assert.equal(providerIdempotencyKey(id), providerIdempotencyKey(id));
  });

  it('differs per action, so two deliberate identical effects both land', () => {
    assert.notEqual(
      providerIdempotencyKey('3f2a1b4c-0000-4000-8000-000000000001'),
      providerIdempotencyKey('3f2a1b4c-0000-4000-8000-000000000002'),
    );
  });

  it('is prefixed and bounded for providers that cap key length', () => {
    const k = providerIdempotencyKey('3f2a1b4c-0000-4000-8000-000000000001');
    assert.ok(k.startsWith('agb_'));
    assert.equal(k.length, 36);
  });
});

describe('assertRequestUnchanged', () => {
  const tool = 'github.branches.delete';
  const params = { repo: 'acme/api', branch: 'release/v2' };

  it('passes when the request is what was approved', () => {
    assert.doesNotThrow(() =>
      assertRequestUnchanged('a1', requestHash(tool, params), tool, params),
    );
  });

  it('passes when params are reordered but equal', () => {
    assert.doesNotThrow(() =>
      assertRequestUnchanged('a1', requestHash(tool, params), tool, {
        branch: 'release/v2',
        repo: 'acme/api',
      }),
    );
  });

  it('throws when a parameter was swapped after approval', () => {
    assert.throws(
      () =>
        assertRequestUnchanged('a1', requestHash(tool, params), tool, {
          ...params,
          branch: 'main',
        }),
      RequestHashMismatchError,
    );
  });

  it('grandfathers rows that predate the column', () => {
    assert.doesNotThrow(() => assertRequestUnchanged('a1', null, tool, params));
  });
});
