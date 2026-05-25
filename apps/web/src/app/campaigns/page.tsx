import Link from 'next/link';
import { api, type AgentRunResult } from '../../lib/api';
import { Card, EmptyState, ErrorBox, H1, Subtitle } from '../../components/nav';
import { CampaignForm } from './campaign-form';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  let agents: Awaited<ReturnType<typeof api.agents.list>>['items'] = [];
  let jobs: Awaited<ReturnType<typeof api.campaigns.jobs>>['items'] = [];
  let runs: AgentRunResult[] = [];
  let error: unknown = null;
  try {
    const [a, j, r] = await Promise.all([
      api.agents.list(),
      api.campaigns.jobs(),
      api.campaigns.listRuns(25),
    ]);
    agents = a.items;
    jobs = j.items;
    runs = r.items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-5xl">
      <H1>Agent runs</H1>
      <Subtitle>
        Launch governed revenue-agent jobs. Each tool call is mediated by
        identity, policy, approval routing, connector dispatch, and audit.
      </Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      <Card className="p-4 mt-4">
        <CampaignForm agents={agents} jobs={jobs} />
      </Card>

      <div className="mt-8">
        <div className="text-sm font-medium mb-2">Recent agent runs</div>
        {runs.length === 0 ? (
          <EmptyState>No runs yet.</EmptyState>
        ) : (
          <Card>
            <table className="w-full text-sm">
              <thead className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">When</th>
                  <th className="text-left px-4 py-2 font-medium">Job</th>
                  <th className="text-left px-4 py-2 font-medium">Lead</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium">Run</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const lead =
                    typeof run.context['email'] === 'string'
                      ? (run.context['email'] as string)
                      : '—';
                  return (
                    <tr
                      key={run.id}
                      className="border-t border-[var(--color-border)] align-top"
                    >
                      <td className="px-4 py-2 mono text-xs text-[var(--color-muted)] whitespace-nowrap">
                        {new Date(run.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-2 mono text-xs">{run.job_key}</td>
                      <td className="px-4 py-2 text-xs">{lead}</td>
                      <td className="px-4 py-2">
                        <RunStatusBadge status={run.status} />
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/campaigns/${run.id}` as never}
                          className="text-xs underline hover:text-[var(--color-accent)]"
                        >
                          view
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  );
}

function RunStatusBadge({ status }: { status: AgentRunResult['status'] }) {
  const tone =
    status === 'completed'
      ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
      : status === 'paused'
        ? 'border-amber-500/30 bg-amber-500/5 text-amber-300'
        : status === 'pending' || status === 'running'
          ? 'border-sky-500/30 bg-sky-500/5 text-sky-300'
          : 'border-rose-500/30 bg-rose-500/5 text-rose-300';
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs ${tone} mono`}>
      {status}
    </span>
  );
}
