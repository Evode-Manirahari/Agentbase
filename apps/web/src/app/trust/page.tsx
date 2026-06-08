import { AGENT_PERMISSION_PROFILES } from '@agentbase/shared';
import type { ReactNode } from 'react';
import {
  Card,
  EmptyState,
  ErrorBox,
  H1,
  StatusPill,
  Subtitle,
} from '../../components/nav';
import {
  buildSecurityPacket,
  loadTrustEvidence,
  type EvidenceAction,
  type RiskLevel,
} from './evidence';

export const dynamic = 'force-dynamic';

interface SearchParams {
  agent_id?: string;
}

export default async function TrustPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  let evidence: Awaited<ReturnType<typeof loadTrustEvidence>> | null = null;
  let error: unknown = null;

  try {
    evidence = await loadTrustEvidence(sp.agent_id);
  } catch (err) {
    error = err;
  }

  const exportHref = evidence?.selected_agent_id
    ? `/trust/export?agent_id=${encodeURIComponent(evidence.selected_agent_id)}`
    : '/trust/export';

  return (
    <div className="max-w-7xl">
      <H1>Security Evidence Room</H1>
      <Subtitle>
        A security-review packet for agent identity, policy decisions, approvals,
        connector execution, and audit evidence across the revenue stack.
      </Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      {evidence ? (
        <>
          <Card className="mb-6 p-4">
            <form method="GET" className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
                Evidence scope
                <select
                  name="agent_id"
                  defaultValue={evidence.selected_agent_id ?? 'all'}
                  className="min-w-[260px] rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
                >
                  <option value="all">All agents</option>
                  {evidence.agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent-fg)] hover:opacity-90"
              >
                Load evidence
              </button>
              <a
                href={exportHref}
                className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Export security packet
              </a>
              <span className="ml-auto text-xs text-[var(--color-muted)] mono">
                generated {new Date(evidence.generated_at).toLocaleString()}
              </span>
            </form>
          </Card>

          <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
            <Metric label="Actions" value={String(evidence.summary.total_actions)} />
            <Metric
              label="High risk"
              value={String(evidence.summary.risk_counts.high)}
              tone={evidence.summary.risk_counts.high > 0 ? 'warn' : 'neutral'}
            />
            <Metric
              label="Approvals required"
              value={String(evidence.summary.approval_counts.required)}
            />
            <Metric
              label="Active connectors"
              value={String(evidence.summary.configured_connectors)}
            />
          </div>

          <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
            <AgentTrustProfile evidence={evidence} />
            <PolicyCard evidence={evidence} />
            <ConnectorCard evidence={evidence} />
          </div>

          <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
            <RiskCard evidence={evidence} />
            <ApprovalCard evidence={evidence} />
            <HistoryCard evidence={evidence} />
          </div>

          <Card className="overflow-hidden">
            <div className="border-b border-[var(--color-border)] px-4 py-3">
              <div className="text-sm font-medium">Action evidence timeline</div>
              <div className="text-xs text-[var(--color-muted)]">
                Every row ties an action to risk, policy, approval, connector,
                and audit evidence.
              </div>
            </div>
            {evidence.actions.length === 0 ? (
              <div className="p-4">
                <EmptyState>No actions match this evidence scope.</EmptyState>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-[1180px] w-full text-sm">
                  <thead className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">When</th>
                      <th className="px-4 py-2 text-left font-medium">Agent</th>
                      <th className="px-4 py-2 text-left font-medium">Risk</th>
                      <th className="px-4 py-2 text-left font-medium">Tool</th>
                      <th className="px-4 py-2 text-left font-medium">Decision</th>
                      <th className="px-4 py-2 text-left font-medium">Status</th>
                      <th className="px-4 py-2 text-left font-medium">Approval</th>
                      <th className="px-4 py-2 text-left font-medium">Connector</th>
                      <th className="px-4 py-2 text-left font-medium">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evidence.actions.map((action) => (
                      <EvidenceRow key={action.id} action={action} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <details className="mt-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)]">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              Preview JSON security packet
            </summary>
            <pre className="max-h-[480px] overflow-auto border-t border-[var(--color-border)] p-4 text-xs text-[var(--color-muted)]">
              {JSON.stringify(buildSecurityPacket(evidence), null, 2)}
            </pre>
          </details>
        </>
      ) : null}
    </div>
  );
}

function AgentTrustProfile({
  evidence,
}: {
  evidence: Awaited<ReturnType<typeof loadTrustEvidence>>;
}) {
  const agent = evidence.selected_agent;
  const profile = agent
    ? AGENT_PERMISSION_PROFILES[agent.permission_profile]
    : null;

  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-medium">Agent trust profile</div>
      {agent ? (
        <dl className="space-y-3 text-sm">
          <Fact label="Agent" value={agent.name} />
          <Fact label="Status" value={<StatusPill status={agent.status} />} />
          <Fact label="Permission profile" value={profile?.label ?? agent.permission_profile} />
          <Fact label="Profile summary" value={profile?.summary ?? 'custom'} />
          <Fact label="API key prefix" value={agent.api_key_prefix ?? 'not issued'} mono />
          <Fact label="Created" value={new Date(agent.created_at).toLocaleString()} />
        </dl>
      ) : (
        <p className="text-sm text-[var(--color-muted)]">
          Showing organization-wide evidence across all registered agents.
        </p>
      )}
    </Card>
  );
}

function PolicyCard({
  evidence,
}: {
  evidence: Awaited<ReturnType<typeof loadTrustEvidence>>;
}) {
  const policy = evidence.active_policy;
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-medium">Policy in force</div>
      <dl className="space-y-3 text-sm">
        <Fact label="Name" value={policy.name ?? 'fallback policy'} />
        <Fact
          label="Version"
          value={policy.version === null ? 'fallback' : `v${policy.version}`}
          mono
        />
        <Fact label="Mode" value={policy.is_fallback ? 'fallback' : 'active'} />
        <Fact
          label="Rules"
          value={String(policy.document?.rules.length ?? 0)}
          mono
        />
      </dl>
    </Card>
  );
}

function ConnectorCard({
  evidence,
}: {
  evidence: Awaited<ReturnType<typeof loadTrustEvidence>>;
}) {
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-medium">Connector posture</div>
      <div className="space-y-2">
        {evidence.connectors.map((connector) => (
          <div
            key={connector.provider}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="capitalize">{connector.provider}</span>
            <span className="text-xs text-[var(--color-muted)]">
              {connector.configured && connector.enabled
                ? `${connector.source ?? 'unknown'} / ${connector.auth_type ?? 'configured'}`
                : 'not active'}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RiskCard({
  evidence,
}: {
  evidence: Awaited<ReturnType<typeof loadTrustEvidence>>;
}) {
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-medium">Risk labels</div>
      <div className="grid grid-cols-3 gap-2">
        {(['low', 'medium', 'high'] as const).map((risk) => (
          <div
            key={risk}
            className="rounded-md border border-[var(--color-border)] p-3"
          >
            <div className="text-xs uppercase text-[var(--color-muted)]">{risk}</div>
            <div className="mt-1 text-2xl font-semibold">
              {evidence.summary.risk_counts[risk]}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ApprovalCard({
  evidence,
}: {
  evidence: Awaited<ReturnType<typeof loadTrustEvidence>>;
}) {
  const approvals = evidence.summary.approval_counts;
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-medium">Human approval evidence</div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Fact label="Required" value={String(approvals.required)} mono />
        <Fact label="Pending" value={String(approvals.pending)} mono />
        <Fact label="Approved" value={String(approvals.approved)} mono />
        <Fact label="Denied / expired" value={String(approvals.denied + approvals.expired)} mono />
      </dl>
    </Card>
  );
}

function HistoryCard({
  evidence,
}: {
  evidence: Awaited<ReturnType<typeof loadTrustEvidence>>;
}) {
  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-medium">Action history data</div>
      {evidence.summary.top_tools.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">No tool usage yet.</p>
      ) : (
        <div className="space-y-2">
          {evidence.summary.top_tools.map((item) => (
            <div
              key={item.tool}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="mono text-xs">{item.tool}</span>
              <span className="text-xs text-[var(--color-muted)]">{item.count}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function EvidenceRow({ action }: { action: EvidenceAction }) {
  const effect = policyEffect(action);
  const approval = action.approval;
  return (
    <tr className="border-t border-[var(--color-border)] align-top">
      <td className="whitespace-nowrap px-4 py-2 text-xs text-[var(--color-muted)] mono">
        {new Date(action.created_at).toLocaleString()}
      </td>
      <td className="px-4 py-2 text-sm">{action.agent_name}</td>
      <td className="px-4 py-2">
        <RiskPill level={action.risk.level} />
        <div className="mt-1 max-w-[180px] text-xs text-[var(--color-muted)]">
          {action.risk.reason}
        </div>
      </td>
      <td className="px-4 py-2 text-xs mono">{action.tool}</td>
      <td className="px-4 py-2 text-xs mono">{effect ?? '-'}</td>
      <td className="px-4 py-2">
        <StatusPill status={action.status} />
      </td>
      <td className="px-4 py-2 text-xs">
        {approval ? (
          <div className="space-y-1">
            <StatusPill status={approval.decision} />
            {approval.actor_id ? (
              <div className="mono text-[var(--color-muted)]">{approval.actor_id}</div>
            ) : null}
            {approval.approval_id ? (
              <div className="mono text-[var(--color-muted)]">{approval.approval_id}</div>
            ) : null}
          </div>
        ) : (
          <span className="text-[var(--color-muted)]">not required</span>
        )}
      </td>
      <td className="px-4 py-2 text-xs mono">
        {action.connector ?? connectorFromTool(action.tool)}
      </td>
      <td className="px-4 py-2 text-xs text-[var(--color-muted)]">
        {action.audit_events.length} audit event
        {action.audit_events.length === 1 ? '' : 's'}
        {resultCode(action) ? (
          <div className="mt-1 text-rose-400 mono">{resultCode(action)}</div>
        ) : null}
      </td>
    </tr>
  );
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'warn';
}) {
  return (
    <Card className="p-4">
      <div className="text-xs uppercase tracking-wider text-[var(--color-muted)]">
        {label}
      </div>
      <div
        className={`mt-1 text-3xl font-semibold ${
          tone === 'warn' ? 'text-amber-300' : ''
        }`}
      >
        {value}
      </div>
    </Card>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-[var(--color-muted)]">{label}</dt>
      <dd className={mono ? 'mono text-xs' : ''}>{value}</dd>
    </div>
  );
}

function RiskPill({ level }: { level: RiskLevel }) {
  const tone =
    level === 'high'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-400'
      : level === 'medium'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
        : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400';
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs mono ${tone}`}>
      {level}
    </span>
  );
}

function policyEffect(action: EvidenceAction): string | null {
  const effect = action.policy_decision?.effect;
  return typeof effect === 'string' ? effect : null;
}

function resultCode(action: EvidenceAction): string | null {
  const error = action.result?.error;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

function connectorFromTool(tool: string): string {
  return tool.split('.')[0] ?? 'unknown';
}
