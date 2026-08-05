// The bug this prevents is not a wrong value — it is an omission, and an
// omission in this list is invisible. AUDIT_EVENT_TYPES is what the webhook
// form offers, so an event missing from it cannot be subscribed to. It had
// already drifted five events behind the API, including
// `action.dispatch_unknown` — the one that tells an operator a dispatch needs
// a human. A quarantine nobody can be notified about is only marginally better
// than no quarantine.
//
// A comment saying "keep in sync" did not keep it in sync. This does.

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_EVENT_TYPES, DEFAULT_WEBHOOK_EVENTS } from '@agentbase/shared';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    // Test files carry deliberately fake event names as fixtures; scanning
    // them would demand the catalog contain strings that are not real events.
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Every `eventType: '…'` literal the API ships. */
function emittedEventTypes(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/eventType:\s*'([a-z0-9_.]+)'/g)) {
      found.add(m[1]!);
    }
  }
  return found;
}

describe('audit event catalog', () => {
  it('finds the emitted events at all (guards the scanner itself)', () => {
    // If the regex or the walk breaks, every other assertion here passes
    // vacuously — which is exactly how this kind of test rots.
    const emitted = emittedEventTypes();
    assert.ok(
      emitted.size >= 10,
      `expected to find many event types, found ${emitted.size}`,
    );
    assert.ok(emitted.has('action.denied'), 'a known event should be detected');
  });

  it('covers every event type the API emits', () => {
    const emitted = emittedEventTypes();
    const catalog = new Set<string>(AUDIT_EVENT_TYPES);
    const missing = [...emitted].filter((e) => !catalog.has(e)).sort();
    assert.deepEqual(
      missing,
      [],
      `these events are emitted but cannot be subscribed to: ${missing.join(', ')}`,
    );
  });

  it('the quarantine alert is subscribable', () => {
    // Named explicitly rather than left to the coverage check, because this is
    // the one whose absence silently breaks the operator workflow.
    assert.ok(
      (AUDIT_EVENT_TYPES as readonly string[]).includes('action.dispatch_unknown'),
    );
  });

  it('defaults wake someone for the effects that need a human', () => {
    assert.ok(
      (DEFAULT_WEBHOOK_EVENTS as readonly string[]).includes(
        'action.dispatch_unknown',
      ),
      'a default that omits the quarantine alert teaches operators to ignore the queue',
    );
  });

  it('has no duplicates', () => {
    assert.equal(new Set(AUDIT_EVENT_TYPES).size, AUDIT_EVENT_TYPES.length);
  });

  it('every default is a real event', () => {
    const catalog = new Set<string>(AUDIT_EVENT_TYPES);
    for (const e of DEFAULT_WEBHOOK_EVENTS) {
      assert.ok(catalog.has(e), `${e} is defaulted but not in the catalog`);
    }
  });
});
