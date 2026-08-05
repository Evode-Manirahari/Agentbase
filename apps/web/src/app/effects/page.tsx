import { api } from '../../lib/api';
import { Card, EmptyState, ErrorBox, H1, Subtitle } from '../../components/nav';
import { resolveEffectAction } from './actions';

export const dynamic = 'force-dynamic';

interface SearchParams {
  status?: string | string[];
  message?: string | string[];
}

function first(v: string | string[] | undefined): string | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * The operator queue for effects whose outcome nobody knows.
 *
 * The commit protocol refuses to guess: an attempt that never settled stays
 * `indeterminate` and is never auto-retried, because retrying an unknown send
 * is how a customer gets two emails. That honesty is only a safety property if
 * a human can act on it — a quarantine with no exit is just a leak. This is
 * the exit.
 */
export default async function EffectsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const status = first(sp.status);
  const message = first(sp.message);

  let items: Awaited<ReturnType<typeof api.effects.indeterminate>>['items'] = [];
  let error: unknown = null;
  try {
    items = (await api.effects.indeterminate(200)).items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-6xl">
      <H1>Effects</H1>
      <Subtitle>
        Dispatches that started and never settled. The request went out and the
        answer never came back, so the effect may or may not exist. Nothing here
        is retried automatically — resolving one means recording what you found
        at the provider, not sending it again.
      </Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      {status ? (
        <div
          className={`mb-4 rounded border p-3 text-sm ${
            status === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-300'
          }`}
        >
          {message ?? status}
        </div>
      ) : null}

      {items.length === 0 && !error ? (
        <EmptyState>
          Nothing in quarantine. An attempt lands here only when a dispatch is
          interrupted before the provider answers — an empty queue is the
          normal state.
        </EmptyState>
      ) : null}

      <div className="flex flex-col gap-4">
        {items.map((it) => (
          <Card key={it.receipt_id}>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                outcome unknown
              </span>
              <span className="text-sm font-medium mono">{it.tool}</span>
              <span className="text-xs text-[var(--color-muted)]">
                attempt {it.attempt} · {it.connector} · started{' '}
                {new Date(it.started_at).toLocaleString()}
              </span>
            </div>

            {/* The mode decides whether re-sending is even an option, so it is
                stated here rather than left for the operator to infer. */}
            <div className="mb-2 text-xs text-[var(--color-muted)]">
              {it.idempotency_mode === 'none' ? (
                <span className="text-rose-300">
                  This provider cannot deduplicate a retry — re-sending would
                  risk a second effect. Establish what happened instead.
                </span>
              ) : (
                <span>
                  Retry-safe mode: <span className="mono">{it.idempotency_mode}</span>
                </span>
              )}
            </div>

            {it.idempotency_key_sent ? (
              <div className="mb-2 text-xs">
                <span className="text-[var(--color-muted)]">
                  Search the provider for this key:{' '}
                </span>
                <span className="mono break-all">{it.idempotency_key_sent}</span>
              </div>
            ) : null}

            <pre className="text-xs mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-3 overflow-x-auto mb-3">
              {JSON.stringify(it.params, null, 2)}
            </pre>

            <form
              action={resolveEffectAction}
              className="flex flex-wrap gap-2 items-end"
            >
              <input type="hidden" name="receipt_id" value={it.receipt_id} />
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[var(--color-muted)]">
                  Provider reference (if you found one)
                </span>
                <input
                  name="provider_ref"
                  placeholder="ch_3Q… / sha…"
                  className="px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-sm mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs flex-1 min-w-[200px]">
                <span className="text-[var(--color-muted)]">What you found</span>
                <input
                  name="note"
                  placeholder="confirmed in the Stripe dashboard"
                  className="px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-sm"
                />
              </label>
              <button
                type="submit"
                name="outcome"
                value="committed"
                className="px-3 py-1.5 rounded-md text-sm border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
              >
                It happened
              </button>
              <button
                type="submit"
                name="outcome"
                value="failed"
                className="px-3 py-1.5 rounded-md text-sm border border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
              >
                It did not happen
              </button>
            </form>
          </Card>
        ))}
      </div>
    </div>
  );
}
