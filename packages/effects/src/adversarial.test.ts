// The classifier reads strings an agent chose. Its whole value is that it
// cannot be talked into calling something safe, so the cases that matter are
// not the tidy ones — they are the inputs designed to slip a `publish` past it
// or to make it fall over.
//
// Nothing here found a bug. It is written down so a future change to the
// tokenizer has to keep these properties rather than rediscover them.
//
// Control characters are written as escapes, never as literals: a NUL or an
// RTL override pasted into source is invisible in review, which is the same
// property that makes them worth testing.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyCommandLine } from './classifier.js';

const NUL = '\u0000';
const RTL_OVERRIDE = '\u202e';
const NBSP = '\u00a0';

describe('adversarial input fails closed', () => {
  const mustBeUnknown: Array<[string, string]> = [
    ['a NUL inside the program name', `npm${NUL}publish`],
    ['a NUL used as a separator', `npm publish${NUL}ls`],
    ['an RTL override before the verb', `npm ${RTL_OVERRIDE}publish`],
    ['operators with no commands', '&&&&||;;;|||'],
    ['nothing at all', ''],
    ['only whitespace', '   \t  '],
  ];

  for (const [name, cmd] of mustBeUnknown) {
    it(`${name} → unknown, never safe`, () => {
      const a = classifyCommandLine(cmd);
      assert.equal(a.effectClass, 'unknown', name);
      assert.equal(a.reversible, false, name);
    });
  }
});

describe('a publish cannot be hidden', () => {
  // Every one of these is `npm publish` wearing a disguise. Grading any of
  // them `read` would be the failure that matters.
  const disguises: Array<[string, string]> = [
    ['a non-breaking space', `npm${NBSP}publish`],
    ['a tab', 'npm\tpublish'],
    ['leading and repeated spaces', '        npm     publish'],
    ['a newline as the separator', 'ls\nnpm publish'],
    ['trailing after a read', 'git status && npm publish'],
    ['behind a shell wrapper', 'bash -c "npm publish"'],
    ['behind two shell wrappers', 'bash -c "bash -c \\"npm publish\\""'],
  ];

  for (const [name, cmd] of disguises) {
    it(`${name} still grades publish`, () => {
      assert.equal(classifyCommandLine(cmd).effectClass, 'publish', name);
    });
  }
});

describe('pathological input does not hang or throw', () => {
  // A classifier that throws is a gate that stops gating: assessEffect catches
  // it and denies, so the failure is safe but total. One that HANGS is worse —
  // it holds the request open. The bounds below are loose on purpose; the
  // point is that they exist at all.
  const pathological: Array<[string, string]> = [
    ['a 200k argument', 'ls ' + 'a'.repeat(200_000)],
    ['5k nested quotes', '"'.repeat(5_000) + 'npm publish'],
    ['20k chained segments', Array(20_000).fill('ls').join(' && ')],
    ['50k backslashes', '\\'.repeat(50_000) + ' npm publish'],
    ['an unterminated quote', 'git commit -m "unterminated'],
  ];

  for (const [name, cmd] of pathological) {
    it(`${name} completes quickly`, () => {
      const t0 = Date.now();
      const a = classifyCommandLine(cmd);
      const ms = Date.now() - t0;
      assert.ok(a.effectClass, name);
      assert.ok(ms < 2_000, `${name} took ${ms}ms`);
    });
  }

  it('nested shell unwrapping is bounded by its own escaping', () => {
    // classifyCommandLine → classifyCommandRule → classifyCommandLine has no
    // explicit depth limit. It does not need one: each level must escape the
    // level below, so the string doubles. Reaching the ~10k frames a stack
    // overflow needs would require a string larger than memory. Depth 16 is
    // already over 100kB — and the publish is still found through all of it.
    let cmd = 'npm publish';
    for (let d = 0; d < 16; d++) cmd = `bash -c ${JSON.stringify(cmd)}`;
    assert.ok(cmd.length > 100_000, 'escaping really does grow the string');
    const t0 = Date.now();
    assert.equal(classifyCommandLine(cmd).effectClass, 'publish');
    assert.ok(Date.now() - t0 < 2_000);
  });
});
