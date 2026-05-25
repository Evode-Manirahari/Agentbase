import { api } from '../../lib/api';
import { Card, EmptyState, ErrorBox, H1, Subtitle } from '../../components/nav';

export const dynamic = 'force-dynamic';

const ACTOR_TYPES = ['agent', 'user', 'system'] as const;

interface SearchParams {
  actor_type?: string;
  event_type?: string;
  since?: string;
  until?: string;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const actor = trim(sp.actor_type);
  const event = trim(sp.event_type);
  const since = trim(sp.since);
  const until = trim(sp.until);
  const sinceIso = since ? toIso(since) : undefined;
  const untilIso = until ? toIso(until) : undefined;

  let items: Awaited<ReturnType<typeof api.audit.list>>['items'] = [];
  let eventTypes: string[] = [];
  let error: unknown = null;
  try {
    const [list, types] = await Promise.all([
      api.audit.list({
        limit: 200,
        ...(actor ? { actor_type: actor } : {}),
        ...(event ? { event_type: event } : {}),
        ...(sinceIso ? { since: sinceIso } : {}),
        ...(untilIso ? { until: untilIso } : {}),
      }),
      api.audit.eventTypes(),
    ]);
    items = list.items;
    eventTypes = types.items;
  } catch (e) {
    error = e;
  }

  const hasFilters = !!(actor || event || since || until);

  const exportQuery = new URLSearchParams();
  if (actor) exportQuery.set('actor_type', actor);
  if (event) exportQuery.set('event_type', event);
  if (sinceIso) exportQuery.set('since', sinceIso);
  if (untilIso) exportQuery.set('until', untilIso);

  function exportHref(format: 'csv' | 'json'): string {
    const qs = new URLSearchParams(exportQuery);
    qs.set('format', format);
    return `/audit/export?${qs.toString()}`;
  }

  return (
    <div className="max-w-6xl">
      <H1>Audit log</H1>
      <Subtitle>
        Every identity, policy, approval, connector, and execution event. Source
        of truth for security review and compliance export.
      </Subtitle>

      <Card className="mb-6 p-4">
        <form method="GET" className="flex flex-wrap gap-3 items-end">
          <Field label="Actor">
            <select
              name="actor_type"
              defaultValue={actor ?? ''}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            >
              <option value="">any</option>
              {ACTOR_TYPES.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Event">
            <select
              name="event_type"
              defaultValue={event ?? ''}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm mono text-xs min-w-[220px]"
            >
              <option value="">any</option>
              {eventTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Since (UTC)">
            <input
              type="datetime-local"
              name="since"
              defaultValue={since ?? ''}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm mono text-xs"
            />
          </Field>

          <Field label="Until (UTC)">
            <input
              type="datetime-local"
              name="until"
              defaultValue={until ?? ''}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm mono text-xs"
            />
          </Field>

          <button
            type="submit"
            className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90"
          >
            Filter
          </button>
          {hasFilters && (
            <a
              href="/audit"
              className="px-3 py-2 rounded-md text-xs border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Clear
            </a>
          )}
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-[var(--color-muted)]">
              {items.length} {items.length === 1 ? 'event' : 'events'}
            </span>
            <a
              href={exportHref('csv')}
              className="px-3 py-2 rounded-md text-xs border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Download CSV
            </a>
            <a
              href={exportHref('json')}
              className="px-3 py-2 rounded-md text-xs border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Download JSON
            </a>
          </div>
        </form>
      </Card>

      {error ? <ErrorBox error={error} /> : null}

      {items.length === 0 ? (
        <EmptyState>
          {hasFilters ? 'No events match these filters.' : 'No audit events yet.'}
        </EmptyState>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2 font-medium">When</th>
                <th className="text-left px-4 py-2 font-medium">Actor</th>
                <th className="text-left px-4 py-2 font-medium">Event</th>
                <th className="text-left px-4 py-2 font-medium">Tool</th>
                <th className="text-left px-4 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const tool = (e.payload as { tool?: string }).tool ?? '—';
                const errCode =
                  (e.payload as { error?: { code?: string } }).error?.code ?? null;
                return (
                  <tr key={e.id} className="border-t border-[var(--color-border)] align-top">
                    <td className="px-4 py-2 mono text-xs text-[var(--color-muted)] whitespace-nowrap">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 mono text-xs whitespace-nowrap">
                      {e.actorType}
                    </td>
                    <td className="px-4 py-2 mono text-xs whitespace-nowrap">
                      {e.eventType}
                    </td>
                    <td className="px-4 py-2 mono text-xs">{tool}</td>
                    <td className="px-4 py-2 text-xs text-[var(--color-muted)]">
                      {errCode ? <span className="text-rose-400">{errCode}</span> : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
      {label}
      {children}
    </label>
  );
}

function trim(v: string | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

// datetime-local inputs don't include a timezone. We treat the value as local
// time and convert to ISO so the API can compare to UTC timestamps.
function toIso(local: string): string | undefined {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}
