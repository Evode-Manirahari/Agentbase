import { api } from '../../../lib/api';
import { Card, EmptyState, ErrorBox, H1, Subtitle } from '../../../components/nav';

export const dynamic = 'force-dynamic';

/**
 * The evidence trail for one action.
 *
 * `effect_receipts` is described everywhere as the artifact that answers "what
 * actually happened out there?" — and until this page it could only be read
 * with curl. An audit record a human cannot open is not an audit record.
 *
 * One row per ATTEMPT, oldest first, so an action that was tried, went
 * indeterminate, and was later resolved by a person reads as the sequence it
 * was rather than a single final verdict.
 */
export default async function ActionEvidencePage({
  params,
}: {
  params: Promise<{ actionId: string }>;
}) {
  const { actionId } = await params;

  let items: Awaited<ReturnType<typeof api.effects.forAction>>['items'] = [];
  let error: unknown = null;
  try {
    items = (await api.effects.forAction(actionId)).items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-4xl">
      <H1>Evidence trail</H1>
      <Subtitle>
        Every dispatch attempt made for this action, oldest first, with what the
        provider said. An attempt is written before the request leaves, so a
        crash mid-call leaves a row here rather than nothing.
      </Subtitle>

      <div className="mb-4 text-xs mono text-[var(--color-muted)] break-all">
        action {actionId}
      </div>

      {error ? <ErrorBox error={error} /> : null}

      {items.length === 0 && !error ? (
        <EmptyState>
          No dispatch attempts recorded. The action was denied, is still awaiting
          approval, or predates the commit protocol — in none of those cases did
          anything leave the machine.
        </EmptyState>
      ) : null}

      <div className="flex flex-col gap-3">
        {items.map((r) => {
          const stored = (r.receipt ?? {}) as {
            ok?: boolean;
            error?: { code?: string; message?: string };
            resolved_by_operator?: string;
            note?: string | null;
          };
          return (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span className="text-xs text-[var(--color-muted)] mono">
                  attempt {r.attempt}
                </span>
                <OutcomePill outcome={r.outcome} />
                <span className="text-xs text-[var(--color-muted)]">
                  {r.connectorName} · started{' '}
                  {new Date(r.startedAt).toLocaleString()}
                  {r.settledAt
                    ? ` · settled ${new Date(r.settledAt).toLocaleString()}`
                    : ' · never settled'}
                </span>
              </div>

              <div className="grid gap-1 text-xs">
                {r.providerRef ? (
                  <div>
                    <span className="text-[var(--color-muted)]">
                      provider reference{' '}
                    </span>
                    <span className="mono break-all">{r.providerRef}</span>
                    <span className="text-[var(--color-muted)]">
                      {' '}
                      — their word for it, not ours
                    </span>
                  </div>
                ) : null}
                {r.idempotencyKeySent ? (
                  <div>
                    <span className="text-[var(--color-muted)]">key sent </span>
                    <span className="mono break-all">{r.idempotencyKeySent}</span>
                  </div>
                ) : (
                  <div className="text-[var(--color-muted)]">
                    no idempotency key was sent — this provider does not honour one
                  </div>
                )}
                <div className="text-[var(--color-muted)]">
                  retry safety at the time: <span className="mono">{r.idempotencyMode}</span>
                </div>
                {stored.resolved_by_operator ? (
                  // A human verdict is the only thing that ends an
                  // indeterminate attempt, so it is named rather than folded
                  // into the outcome.
                  <div className="text-amber-300">
                    resolved by {stored.resolved_by_operator}
                    {stored.note ? ` — ${stored.note}` : ''}
                  </div>
                ) : null}
                {stored.error?.code ? (
                  <div className="text-rose-300">
                    {stored.error.code}
                    {stored.error.message ? ` — ${stored.error.message}` : ''}
                  </div>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function OutcomePill({ outcome }: { outcome: string }) {
  const cls =
    outcome === 'committed'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
      : outcome === 'failed'
        ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  const label = outcome === 'indeterminate' ? 'outcome unknown' : outcome;
  return (
    <span className={`rounded border px-2 py-0.5 text-xs ${cls}`}>{label}</span>
  );
}
