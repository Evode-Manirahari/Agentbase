'use client';

import { useActionState } from 'react';
import { runCampaignAction, type RunCampaignState } from './actions';
import { TranscriptView } from './transcript-view';
import type { AgentRow, CampaignJobSummary } from '../../lib/api';

const initial: RunCampaignState = { result: null, error: null };

export function CampaignForm({
  agents,
  jobs,
}: {
  agents: AgentRow[];
  jobs: CampaignJobSummary[];
}) {
  const [state, action, pending] = useActionState(runCampaignAction, initial);
  const activeAgents = agents.filter((a) => a.status === 'active');
  const selectedJob = jobs[0];

  return (
    <div className="flex flex-col gap-6">
      <form
        action={action}
        className="rounded border border-[var(--color-border)] p-4 flex flex-col gap-3"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Job">
            <select
              name="job_key"
              required
              defaultValue={selectedJob?.key ?? ''}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            >
              {jobs.length === 0 ? (
                <option value="">no jobs registered</option>
              ) : (
                jobs.map((j) => (
                  <option key={j.key} value={j.key}>
                    {j.label}
                  </option>
                ))
              )}
            </select>
          </Field>

          <Field label="Agent identity">
            <select
              name="agent_id"
              required
              defaultValue={activeAgents[0]?.id ?? ''}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            >
              {activeAgents.length === 0 ? (
                <option value="">no active agents — register one first</option>
              ) : (
                activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.permission_profile})
                  </option>
                ))
              )}
            </select>
          </Field>
        </div>

        <Field label="Lead email">
          <input
            name="email"
            type="email"
            required
            placeholder="lead@example.com"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
          />
        </Field>

        <Field label="Notes (optional context for the agent)">
          <textarea
            name="notes"
            rows={3}
            placeholder="Where the lead came from, what they asked for, any history."
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
          />
        </Field>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || activeAgents.length === 0 || jobs.length === 0}
            className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? 'Running…' : 'Run campaign'}
          </button>
          <span className="text-xs text-[var(--color-muted)]">
            The agent calls Apollo + HubSpot + Gmail through Dejavas. Risky writes
            (gmail.send) will pause for human approval in Slack.
          </span>
        </div>
      </form>

      {state.error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {state.error}
        </div>
      ) : null}

      {state.result ? <TranscriptView result={state.result} /> : null}
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
