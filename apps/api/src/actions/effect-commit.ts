import { createHash } from 'node:crypto';

// The commit protocol for irreversible external effects.
//
// A permissions gateway answers "may this agent call this tool?". That question
// is settled before anything leaves the machine. This module answers the one
// that comes after: the call was permitted and a human approved it — now how do
// we commit it exactly once, prove what happened, and survive a crash at any
// point in between?
//
// The hard part is that there is a window, however small, where we have sent a
// request and do not yet know its fate. No amount of transactional discipline
// on our side closes that window, because it is on the far side of the network.
// So the protocol does not pretend to close it. It does three things instead:
//
//   1. Make the retry safe when it can — by handing the provider a
//      deterministic idempotency key derived from the request itself, so a
//      second attempt is the SAME request rather than a new one.
//   2. Refuse to guess when it cannot — an attempt whose outcome we never
//      learned is recorded `indeterminate` and never auto-retried.
//   3. Prove what happened afterwards — an append-only receipt per attempt,
//      carrying the provider's own reference.

/**
 * Canonical JSON: object keys sorted at every depth, so two structurally equal
 * param objects hash identically regardless of key insertion order. Arrays keep
 * their order — `[a, b]` and `[b, a]` are genuinely different requests.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // Drop undefined so `{a:1}` and `{a:1,b:undefined}` agree — JSON.stringify
    // would already elide b, and we must match that or the hash lies.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/**
 * Identity of a request: what a human approves, and what the provider
 * idempotency key is derived from. Two requests with this same hash are the
 * same intent and must produce at most one effect.
 */
export function requestHash(tool: string, params: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${tool}\u0000${canonicalize(params)}`)
    .digest('hex');
}

/**
 * The key handed to the PROVIDER, not the one callers hand to us.
 *
 * Derived from the action id rather than the request hash, deliberately: two
 * separate actions that happen to carry identical params are two intentional
 * effects and must both land. Retries of ONE action share an id, so they share
 * this key and collapse provider-side into a single effect.
 */
export function providerIdempotencyKey(actionId: string): string {
  return `agb_${createHash('sha256').update(actionId).digest('hex').slice(0, 32)}`;
}

/** Thrown when an approved action's params no longer match what was approved. */
export class RequestHashMismatchError extends Error {
  constructor(
    readonly actionId: string,
    readonly approved: string,
    readonly actual: string,
  ) {
    super(
      `action ${actionId} was approved for request ${approved.slice(0, 12)}… ` +
        `but is being dispatched as ${actual.slice(0, 12)}… — refusing to commit`,
    );
    this.name = 'RequestHashMismatchError';
  }
}

/**
 * Bind an approval to the exact request a human read.
 *
 * A human approving "delete branch `release/v2`" approved those params, not the
 * row id that happened to hold them. Anything that can mutate an action between
 * approval and dispatch — a bug, a replayed message, a hostile write — has to
 * get past this.
 *
 * Actions predating the column carry a null hash; those are grandfathered
 * rather than blocked, because failing closed on historical rows would break
 * every pending approval on deploy. New rows always carry one.
 */
export function assertRequestUnchanged(
  actionId: string,
  approvedHash: string | null,
  tool: string,
  params: Record<string, unknown>,
): void {
  if (approvedHash === null) return;
  const actual = requestHash(tool, params);
  if (actual !== approvedHash) {
    throw new RequestHashMismatchError(actionId, approvedHash, actual);
  }
}
