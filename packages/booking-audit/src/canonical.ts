import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted at every depth, so two structurally equal
 * objects hash identically regardless of key order. Arrays keep their order.
 *
 * Same algorithm as `canonicalize` in apps/api/src/actions/effect-commit.ts.
 * Copied rather than imported so this package has zero runtime dependencies and
 * can be published alone. The audit's intent key is never compared with the
 * API's request hash today; unify the two when the commit endpoint starts
 * keying on booking intents.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
