import { api } from '../../lib/api';
import { Card, EmptyState, ErrorBox, H1, Subtitle } from '../../components/nav';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  let items: Awaited<ReturnType<typeof api.audit.list>>['items'] = [];
  let error: unknown = null;
  try {
    items = (await api.audit.list(200)).items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-6xl">
      <H1>Audit log</H1>
      <Subtitle>Every state transition. Source of truth for compliance.</Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      {items.length === 0 ? (
        <EmptyState>No audit events yet.</EmptyState>
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
                      {new Date(e.createdAt).toLocaleTimeString()}
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
