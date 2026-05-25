import { api, type MetricsOverview } from '../lib/api';
import { Card, ErrorBox, H1, StatusPill, Subtitle } from '../components/nav';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  let agents = 0;
  let pendingApprovals = 0;
  let recentActions: Awaited<ReturnType<typeof api.actions.list>>['items'] = [];
  let policy: Awaited<ReturnType<typeof api.policies.active>> | null = null;
  let metrics: MetricsOverview | null = null;
  let error: unknown = null;
  try {
    const [a, ap, ac, p, m] = await Promise.all([
      api.agents.list(),
      api.approvals.list(),
      api.actions.list(8),
      api.policies.active(),
      api.metrics.overview(24),
    ]);
    agents = a.items.length;
    pendingApprovals = ap.items.length;
    recentActions = ac.items;
    policy = p;
    metrics = m;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-6xl">
      <H1>Overview</H1>
      <Subtitle>
        Cross-stack governance for revenue agents before they touch CRM, email,
        and sales tools.{' '}
        <a href="/campaigns" className="underline hover:text-[var(--color-accent)]">
          Start a governed run →
        </a>
      </Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      <ControlPlaneBrief />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <Stat label="Agents" value={agents} />
        <Stat
          label="Pending approvals"
          value={pendingApprovals}
          highlight={pendingApprovals > 0}
        />
        <Stat
          label="Active policy"
          value={policy?.is_fallback ? 'fallback' : `v${policy?.version ?? '—'}`}
        />
        <Stat
          label="Actions (24h)"
          value={metrics?.total ?? 0}
          sub={metrics ? denyRateLine(metrics) : undefined}
        />
      </div>

      {metrics ? <MetricsBoard metrics={metrics} /> : null}

      <Card className="mt-8">
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

function ControlPlaneBrief() {
  return (
    <Card className="mb-6 p-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
        <BriefItem
          label="Identity"
          value="Every sales agent gets a scoped identity and revocable API key."
        />
        <BriefItem
          label="Governance"
          value="Policies decide which Salesforce, Gmail, Slack, Outreach, and enrichment actions run, pause, or stop."
        />
        <BriefItem
          label="Monitoring"
          value="Approvals, connector outcomes, and audit exports give RevOps, security, and IT one evidence trail."
        />
      </div>
    </Card>
  );
}

function BriefItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-[var(--color-muted)] uppercase tracking-wider mb-1">
        {label}
      </div>
      <div>{value}</div>
    </div>
  );
}

function MetricsBoard({ metrics }: { metrics: MetricsOverview }) {
  const s = metrics.by_status;
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Card className="p-4">
        <div className="text-xs text-[var(--color-muted)] uppercase tracking-wider mb-2">
          Last {metrics.window_hours}h breakdown
        </div>
        <BreakdownBar
          segments={[
            { label: 'executed', count: s.executed, color: 'bg-emerald-500' },
            {
              label: 'awaiting',
              count: s.awaiting_approval,
              color: 'bg-amber-500',
            },
            { label: 'failed', count: s.failed, color: 'bg-rose-500' },
            { label: 'denied', count: s.denied, color: 'bg-zinc-500' },
          ]}
          total={metrics.total}
        />
        {metrics.rate_limited_count > 0 ? (
          <div className="text-xs text-amber-400 mt-3">
            {metrics.rate_limited_count} rate-limited in window
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <div className="text-xs text-[var(--color-muted)] uppercase tracking-wider mb-2">
          Top tools
        </div>
        {metrics.top_tools.length === 0 ? (
          <div className="text-xs text-[var(--color-muted)]">no activity</div>
        ) : (
          <ul className="text-sm space-y-1">
            {metrics.top_tools.map((t) => (
              <li key={t.tool} className="flex justify-between gap-2">
                <code className="mono text-xs truncate">{t.tool}</code>
                <span className="mono text-xs text-[var(--color-muted)]">
                  {t.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <div className="text-xs text-[var(--color-muted)] uppercase tracking-wider mb-2">
          Top agents
        </div>
        {metrics.top_agents.length === 0 ? (
          <div className="text-xs text-[var(--color-muted)]">no activity</div>
        ) : (
          <ul className="text-sm space-y-1">
            {metrics.top_agents.map((a) => (
              <li key={a.agent_id} className="flex justify-between gap-2">
                <span className="truncate">{a.agent_name}</span>
                <span className="mono text-xs text-[var(--color-muted)]">
                  {a.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function BreakdownBar({
  segments,
  total,
}: {
  segments: { label: string; count: number; color: string }[];
  total: number;
}) {
  if (total === 0) {
    return <div className="text-xs text-[var(--color-muted)]">no activity</div>;
  }
  return (
    <div>
      <div className="flex h-3 rounded overflow-hidden bg-[var(--color-bg)]">
        {segments.map((s) => {
          const pct = (s.count / total) * 100;
          if (pct === 0) return null;
          return (
            <div
              key={s.label}
              className={s.color}
              style={{ width: `${pct}%` }}
              title={`${s.label}: ${s.count}`}
            />
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-3 text-xs">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${s.color}`} />
            <span className="text-[var(--color-muted)] capitalize">{s.label}</span>
            <span className="mono ml-auto">{s.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function denyRateLine(m: MetricsOverview): string {
  if (m.total === 0) return 'no activity';
  const pct = (m.deny_rate * 100).toFixed(1);
  return `${pct}% denied`;
}

function Stat({
  label,
  value,
  highlight = false,
  sub,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
  sub?: string | undefined;
}) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-[var(--color-muted)] uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className={`text-2xl font-semibold ${highlight ? 'text-amber-400' : ''}`}>
        {value}
      </div>
      {sub ? (
        <div className="text-xs text-[var(--color-muted)] mt-1">{sub}</div>
      ) : null}
    </Card>
  );
}
