import type React from 'react';
import { api, type MetricsOverview, type MetricsTimeseries } from '../lib/api';
import { Card, ErrorBox, H1, StatusPill, Subtitle } from '../components/nav';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  let agents = 0;
  let pendingApprovals = 0;
  let recentActions: Awaited<ReturnType<typeof api.actions.list>>['items'] = [];
  let policy: Awaited<ReturnType<typeof api.policies.active>> | null = null;
  let metrics: MetricsOverview | null = null;
  let timeseries: MetricsTimeseries | null = null;
  let error: unknown = null;
  try {
    const [a, ap, ac, p, m, t] = await Promise.all([
      api.agents.list(),
      api.approvals.list(),
      api.actions.list(8),
      api.policies.active(),
      api.metrics.overview(24),
      api.metrics.timeseries(168),
    ]);
    agents = a.items.length;
    pendingApprovals = ap.items.length;
    recentActions = ac.items;
    policy = p;
    metrics = m;
    timeseries = t;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-6xl">
      <H1>Overview</H1>
      <Subtitle>
        Commit an agent&apos;s irreversible actions exactly once wherever the
        provider deduplicates, prove what happened, and survive a crash in the
        middle.{' '}
        <a href="/effects" className="underline hover:text-[var(--color-accent)]">
          See the quarantine →
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

      {metrics ? <PolicyAndApprovalRow metrics={metrics} /> : null}

      {timeseries ? <TimeseriesBoard ts={timeseries} /> : null}

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
          value="Every action is graded by consequence — effect class plus whether it can be undone."
        />
        <BriefItem
          label="Governance"
          value="Policy matches on what an action does, so a command nobody anticipated is still gated."
        />
        <BriefItem
          label="Monitoring"
          value="One receipt per attempt with the provider’s own reference. An interrupted dispatch stays unknown until a human resolves it."
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
        {metrics.indeterminate_count > 0 ? (
          // The one number on this page that needs a person. Everything else
          // is a rate to watch; this is a queue to clear, and it is excluded
          // from the failure bar above precisely because it is not a failure.
          <a
            href="/effects"
            className="mt-3 block rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 hover:bg-amber-500/20"
          >
            {metrics.indeterminate_count} dispatch
            {metrics.indeterminate_count === 1 ? '' : 'es'} with an unknown
            outcome — not retried, awaiting a human. Resolve →
          </a>
        ) : null}
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

function PolicyAndApprovalRow({ metrics }: { metrics: MetricsOverview }) {
  const a = metrics.approval_stats;
  const hasApprovalData = a.require_approval_total > 0;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
      <Card className="p-4">
        <div className="text-xs text-[var(--color-muted)] uppercase tracking-wider mb-2">
          Approval throughput (last {metrics.window_hours}h)
        </div>
        {hasApprovalData ? (
          <>
            <div className="flex items-baseline gap-2">
              <div className="text-2xl font-semibold">
                {metrics.approval_rate === null
                  ? '—'
                  : `${(metrics.approval_rate * 100).toFixed(0)}%`}
              </div>
              <div className="text-xs text-[var(--color-muted)]">approved</div>
            </div>
            <div className="text-xs text-[var(--color-muted)] mt-2 space-y-0.5">
              <div className="flex justify-between">
                <span>approved by human</span>
                <span className="mono">{a.approved}</span>
              </div>
              <div className="flex justify-between">
                <span>denied by human</span>
                <span className="mono">{a.denied}</span>
              </div>
              <div className="flex justify-between">
                <span>still awaiting</span>
                <span className="mono">{a.pending}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="text-xs text-[var(--color-muted)]">
            No approval-required actions in this window.
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="text-xs text-[var(--color-muted)] uppercase tracking-wider mb-2">
          Top policy hits
        </div>
        {metrics.top_policy_rules.length === 0 ? (
          <div className="text-xs text-[var(--color-muted)]">
            No policy decisions recorded.
          </div>
        ) : (
          <ul className="text-sm space-y-1">
            {metrics.top_policy_rules.map((r) => (
              <li
                key={`${r.reason}::${r.effect}`}
                className="flex items-center justify-between gap-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <EffectDot effect={r.effect} />
                  <span className="truncate" title={r.reason}>
                    {r.reason}
                  </span>
                </div>
                <span className="mono text-xs text-[var(--color-muted)]">
                  {r.count}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function EffectDot({ effect }: { effect: 'allow' | 'require_approval' | 'deny' }) {
  const color =
    effect === 'allow'
      ? 'bg-emerald-500'
      : effect === 'require_approval'
        ? 'bg-amber-500'
        : 'bg-rose-500';
  const label =
    effect === 'allow' ? 'allow' : effect === 'require_approval' ? 'gate' : 'deny';
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`}
      title={label}
    />
  );
}

function TimeseriesBoard({ ts }: { ts: MetricsTimeseries }) {
  const days = ts.buckets.length;
  const max = Math.max(
    1,
    ...ts.series.flatMap((s) => s.counts),
  );
  const hasAny = ts.series.some((s) => s.counts.some((n) => n > 0));

  return (
    <Card className="mt-4 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-xs text-[var(--color-muted)] uppercase tracking-wider">
          Actions per day, per agent
        </div>
        <div className="text-xs text-[var(--color-muted)]">last {days}d</div>
      </div>
      {!hasAny ? (
        <div className="text-xs text-[var(--color-muted)]">
          No activity in this window.
        </div>
      ) : (
        <div className="space-y-2">
          {ts.series.map((s, idx) => (
            <div key={s.agent_id} className="flex items-center gap-3">
              <div
                className="text-xs truncate w-32 shrink-0"
                title={s.agent_name}
              >
                {s.agent_name}
              </div>
              <div className="flex-1 grid gap-0.5" style={gridStyle(days)}>
                {s.counts.map((n, i) => (
                  <div
                    key={i}
                    className="h-6 rounded-sm relative"
                    style={{
                      backgroundColor: agentColor(idx, n === 0 ? 0 : n / max),
                    }}
                    title={`${ts.buckets[i]}: ${n}`}
                  >
                    {n > 0 ? (
                      <span className="absolute inset-0 flex items-center justify-center text-[10px] mono text-zinc-900">
                        {n}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="grid gap-0.5 mt-1 pl-[8.75rem]" style={gridStyle(days)}>
            {ts.buckets.map((b) => (
              <div
                key={b}
                className="text-[10px] text-[var(--color-muted)] text-center mono"
              >
                {b.slice(5)}
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function gridStyle(cols: number): React.CSSProperties {
  return { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
}

// Stable per-agent hue so the same agent gets the same colour across reloads.
// Opacity encodes intensity so the eye can scan for hotspots.
function agentColor(seriesIdx: number, intensity: number): string {
  const hues = [200, 280, 30, 140, 0, 60, 320, 180];
  const hue = hues[seriesIdx % hues.length];
  const alpha = intensity === 0 ? 0.08 : 0.3 + intensity * 0.7;
  return `hsl(${hue} 80% 60% / ${alpha})`;
}
