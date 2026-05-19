'use client';

import { useActionState } from 'react';
import { startCampaignAction, type RunCampaignState } from './actions';
import type { AgentRow, CampaignJobSummary } from '../../lib/api';

const initial: RunCampaignState = { error: null };

export function CampaignForm({
  agents,
  jobs,
}: {
  agents: AgentRow[];
  jobs: CampaignJobSummary[];
}) {
  const [state, action, pending] = useActionState(startCampaignAction, initial);
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

        <Field label="Lead emails (one per line, comma- or semicolon-separated, max 50)">
          <textarea
            name="emails"
            required
            rows={5}
            spellCheck={false}
            placeholder={'cto@globex.com\nvp-eng@acme.io\nrevops@initech.com'}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm mono"
          />
        </Field>

        <Field label="Notes (applied to every lead in the batch)">
          <textarea
            name="notes"
            rows={3}
            placeholder={
              'e.g. "Downloaded our pricing PDF this morning. Hit our docs from a Google search for `Salesforce AI agent governance`. Series B fintech."'
            }
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
          />
        </Field>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || activeAgents.length === 0 || jobs.length === 0}
            className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? 'Starting…' : 'Run campaign'}
          </button>
          <span className="text-xs text-[var(--color-muted)]">
            Enqueues one agent run per lead and redirects to the batch view.
            Each run dispatches Apollo + HubSpot + Gmail through Dejavas;
            <span className="mono"> gmail.send</span> pauses for human approval in Slack.
          </span>
        </div>
      </form>

      {state.error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-300">
          {state.error}
        </div>
      ) : null}
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
