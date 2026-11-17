import assert from 'node:assert/strict';
import { runAudit } from './audit.js';
import type { AuditResult } from './audit.js';
import type { DetectOptions } from './classify.js';
import { normalizeRetellCall } from './normalize-retell.js';
import type { NormalizedCall } from './types.js';

// The call builders live in samples.ts because `booking-audit demo` ships them.
// Tests use the same ones, so the demo cannot drift from what is tested.
export { agent, cleanCall, invoke, result, retellCall, threadCall, user } from './samples.js';

export const AUTO: DetectOptions = { bookingTools: null, identityKeys: null };

export function normalize(raw: unknown): NormalizedCall {
  const call = normalizeRetellCall(raw);
  assert.ok(call, 'fixture should normalize');
  return call;
}

export function audit(raws: unknown[], opts: DetectOptions = AUTO): AuditResult {
  return runAudit(raws.map(normalize), opts);
}
