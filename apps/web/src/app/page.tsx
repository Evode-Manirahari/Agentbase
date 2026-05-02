import { api } from '../lib/api';
import { Card, ErrorBox, H1, StatusPill, Subtitle } from '../components/nav';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  let agents = 0;
  let pendingApprovals = 0;
  let recentActions: Awaited<ReturnType<typeof api.actions.list>>['items'] = [];
  let policy: Awaited<ReturnType<typeof api.policies.active>> | null = null;
  let error: unknown = null;
  try {
    const [a, ap, ac, p] = await Promise.all([
      api.agents.list(),
      api.approvals.list(),
      api.actions.list(8),
      api.policies.active(),
    ]);
    agents = a.items.length;
    pendingApprovals = ap.items.length;
    recentActions = ac.items;
    policy = p;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-5xl">
      <H1>Overview</H1>
      <Subtitle>Live state of the control plane.</Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      <div className="grid grid-cols-4 gap-4 mb-8">
        <Stat label="Agents" value={agents} />
        <Stat label="Pending approvals" value={pendingApprovals} highlight={pendingApprovals > 0} />
        <Stat
          label="Active policy"
          value={policy?.is_fallback ? 'fallback' : `v${policy?.version ?? '—'}`}
        />
        <Stat label="Recent actions" value={recentActions.length} />
      </div>

      <Card>
        <div className="px-4 py-3 border-b border-[var(--color-border)] text-sm font-medium">
          Recent actions
        </div>
        {recentActions.length === 0 ? (
          <div className="px-4 py-8 text-sm text-[var(--color-muted)] text-center">
            No actions yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2 font-medium">When</th>
                <th className="text-left px-4 py-2 font-medium">Agent</th>
                <th className="text-left px-4 py-2 font-medium">Tool</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {recentActions.map((a) => (
                <tr key={a.id} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2 mono text-xs text-[var(--color-muted)]">
                    {new Date(a.created_at).toLocaleTimeString()}
                  </td>
                  <td className="px-4 py-2">{a.agent_name}</td>
                  <td className="px-4 py-2 mono text-xs">{a.tool}</td>
                  <td className="px-4 py-2">
                    <StatusPill status={a.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
}) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-[var(--color-muted)] uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className={`text-2xl font-semibold ${highlight ? 'text-amber-400' : ''}`}>
        {value}
      </div>
    </Card>
  );
}
