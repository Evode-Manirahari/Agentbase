import { api } from '../../lib/api';
import { Card, EmptyState, ErrorBox, H1, StatusPill, Subtitle } from '../../components/nav';

export const dynamic = 'force-dynamic';

export default async function ActionsPage() {
  let items: Awaited<ReturnType<typeof api.actions.list>>['items'] = [];
  let error: unknown = null;
  try {
    items = (await api.actions.list(200)).items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-6xl">
      <H1>Actions</H1>
      <Subtitle>Every action attempted, with the policy decision and connector result.</Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      {items.length === 0 ? (
        <EmptyState>No actions yet.</EmptyState>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2 font-medium">When</th>
                <th className="text-left px-4 py-2 font-medium">Agent</th>
                <th className="text-left px-4 py-2 font-medium">Tool</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">Effect</th>
                <th className="text-left px-4 py-2 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => {
                const effect = (a.policy_decision as { effect?: string } | null)?.effect ?? '—';
                const errCode =
                  (a.result as { error?: { code?: string } } | null)?.error?.code ?? null;
                const reason =
                  (a.policy_decision as { reason?: string } | null)?.reason ?? null;
                return (
                  <tr key={a.id} className="border-t border-[var(--color-border)] align-top">
                    <td className="px-4 py-2 mono text-xs text-[var(--color-muted)] whitespace-nowrap">
                      {new Date(a.created_at).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{a.agent_name}</td>
                    <td className="px-4 py-2 mono text-xs">{a.tool}</td>
                    <td className="px-4 py-2">
                      <StatusPill status={a.status} />
                    </td>
                    <td className="px-4 py-2 mono text-xs text-[var(--color-muted)]">{effect}</td>
                    <td className="px-4 py-2 text-xs text-[var(--color-muted)]">
                      {errCode ? <span className="text-rose-400">{errCode}</span> : reason ?? '—'}
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
