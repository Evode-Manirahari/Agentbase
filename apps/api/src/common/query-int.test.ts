// Unit tests for clampQueryInt — the shared query-param parser used by every
// list endpoint. The regression that motivated it: ?limit=abc produced NaN,
// which flowed into SQL LIMIT.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { clampQueryInt } from './query-int.js';

const OPTS = { fallback: 100, min: 1, max: 500 };

describe('clampQueryInt', () => {
  it('returns the fallback when the param is missing', () => {
    assert.equal(clampQueryInt(undefined, OPTS), 100);
  });

  it('parses a plain integer inside the range', () => {
    assert.equal(clampQueryInt('50', OPTS), 50);
  });

  it('clamps values above max', () => {
    assert.equal(clampQueryInt('9999', OPTS), 500);
  });

  it('clamps zero and negatives up to min', () => {
    assert.equal(clampQueryInt('0', OPTS), 1);
    assert.equal(clampQueryInt('-5', OPTS), 1);
  });

  it('falls back on non-numeric input instead of producing NaN', () => {
    assert.equal(clampQueryInt('abc', OPTS), 100);
  });

  it('treats an empty string as 0 and clamps it to min', () => {
    assert.equal(clampQueryInt('', OPTS), 1);
  });

  it('falls back on Infinity', () => {
    assert.equal(clampQueryInt('Infinity', OPTS), 100);
  });

  it('truncates decimals', () => {
    assert.equal(clampQueryInt('12.9', OPTS), 12);
  });
});
