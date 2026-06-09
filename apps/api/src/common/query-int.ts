/**
 * Parse a numeric query param and clamp it to [min, max]. Non-numeric input
 * (e.g. ?limit=abc) falls back to `fallback` instead of letting NaN flow
 * into a SQL LIMIT clause.
 */
export function clampQueryInt(
  raw: string | undefined,
  opts: { fallback: number; min: number; max: number },
): number {
  const parsed = Number(raw ?? opts.fallback);
  const safe = Number.isFinite(parsed) ? Math.trunc(parsed) : opts.fallback;
  return Math.min(Math.max(safe, opts.min), opts.max);
}
