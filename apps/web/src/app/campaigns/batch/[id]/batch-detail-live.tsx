'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type {
  AgentRunResult,
  CampaignBatchDetail,
} from '../../../../lib/api';

const POLL_INTERVAL_MS = 2000;

export function BatchDetailLive({
  initialBatch,
}: {
  initialBatch: CampaignBatchDetail;
}) {
  const [batch, setBatch] = useState(initialBatch);
  const [error, setError] = useState<string | null>(null);

  const allTerminal = batch.runs.every((r) =>
    r.status === 'completed' || r.status === 'failed',
  );
  // Keep polling while ANY run is still pending/running/paused. A paused
  // run can flip back to running the moment a Slack approval lands.
  const stopPolling = allTerminal;

  useEffect(() => {
    if (stopPolling) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const resp = await fetch(`/campaigns/api/batches/${batch.batch_id}`, {
          cache: 'no-store',
        });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const next = (await resp.json()) as CampaignBatchDetail;
        if (!cancelled) setBatch(next);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    const t = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [batch.batch_id, stopPolling]);

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-300">
          Live update error: {error}. Last-known state below.
        </div>
      ) : null}
      <StatusSummary summary={batch.status_summary} total={batch.run_count} />
      <RunTable runs={batch.runs} />
    </div>
  );
}

function StatusSummary({
  summary,
  total,
}: {
  summary: CampaignBatchDetail['status_summary'];
  total: number;
}) {
  const segments = [
    { label: 'completed', count: summary.completed, color: 'bg-emerald-500' },
    { label: 'paused', count: summary.paused, color: 'bg-amber-500' },
    {
      label: 'running',
      count: summary.running + summary.pending,
      color: 'bg-sky-500',
    },
    { label: 'failed', count: summary.failed, color: 'bg-rose-500' },
  ];
  return (
    <div className="rounded border border-[var(--color-border)] p-3">
      <div className="text-xs text-[var(--color-muted)] uppercase tracking-wider mb-2">
        Batch progress · {total} run{total === 1 ? '' : 's'}
      </div>
      <div className="flex h-3 rounded overflow-hidden bg-[var(--color-bg)]">
        {segments.map((s) => {
          const pct = total === 0 ? 0 : (s.count / total) * 100;
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-1 mt-3 text-xs">
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

function RunTable({ runs }: { runs: AgentRunResult[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
        <tr>
          <th className="text-left px-3 py-2 font-medium">Lead</th>
          <th className="text-left px-3 py-2 font-medium">Status</th>
          <th className="text-left px-3 py-2 font-medium">Last tool</th>
          <th className="text-left px-3 py-2 font-medium">Open</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const email =
            typeof run.context['email'] === 'string'
              ? (run.context['email'] as string)
              : '—';
          const lastToolCall = [...run.transcript]
            .reverse()
            .find((t) => t.type === 'tool_call');
          const lastTool =
            lastToolCall?.type === 'tool_call'
              ? lastToolCall.agentbase_tool
              : '—';
          return (
            <tr
              key={run.id}
              className="border-t border-[var(--color-border)] align-top"
            >
              <td className="px-3 py-2 mono text-xs">{email}</td>
              <td className="px-3 py-2">
                <RunStatusBadge status={run.status} />
              </td>
              <td className="px-3 py-2 mono text-xs text-[var(--color-muted)]">
                {lastTool}
              </td>
              <td className="px-3 py-2">
                <Link
                  href={`/campaigns/${run.id}` as never}
                  className="text-xs underline hover:text-[var(--color-accent)]"
                >
                  transcript
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
    <span
      className={`inline-block rounded border px-2 py-0.5 text-xs ${tone} mono`}
    >
      {status}
    </span>
  );
}
