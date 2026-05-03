import { api } from '../../lib/api';
import { Card, EmptyState, ErrorBox, H1, StatusPill, Subtitle } from '../../components/nav';
import { retryActionAction } from './actions';

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
                <th className="text-left px-4 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => {
                const decision = a.policy_decision as {
                  effect?: string;
                  reason?: string;
                } | null;
                const effect = decision?.effect ?? '—';
                const reason = decision?.reason ?? null;
                const errCode =
                  (a.result as { error?: { code?: string } } | null)?.error?.code ?? null;
                // Retry is only meaningful for failed actions whose original
                // policy decision was 'allow' — anything else needs operator
                // intervention upstream (policy change, approval, etc.).
                const canRetry = a.status === 'failed' && effect === 'allow';
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
                    <td className="px-4 py-2">
                      {canRetry ? (
                        <form action={retryActionAction}>
                          <input type="hidden" name="action_id" value={a.id} />
                          <button
                            type="submit"
                            className="text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                            title="Re-invoke the connector with the same params. Audit log records the operator and outcome."
                          >
                            Retry
                          </button>
                        </form>
                      ) : (
                        <span className="text-xs text-[var(--color-muted)]">—</span>
                      )}
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
