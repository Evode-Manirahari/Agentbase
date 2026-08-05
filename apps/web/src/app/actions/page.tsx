import { api } from '../../lib/api';
import { Card, EmptyState, ErrorBox, H1, StatusPill, Subtitle } from '../../components/nav';
import { retryActionAction, runHubspotLeadWorkflowAction } from './actions';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

interface SearchParams {
  demo?: string | string[];
  message?: string | string[];
}

export default async function ActionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const demoStatus = firstParam(sp.demo);
  const demoMessage = firstParam(sp.message);
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
      <Subtitle>
        Every agent action attempted across CRM, email, enrichment, and sales
        tools, with the policy decision and connector result.
      </Subtitle>

      {error ? <ErrorBox error={error} /> : null}
      {demoStatus ? (
        <div
          className={`mb-4 rounded border p-3 text-sm ${
            demoStatus === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
              : demoStatus === 'awaiting_approval'
                ? 'border-amber-500/30 bg-amber-500/5 text-amber-300'
                : 'border-rose-500/30 bg-rose-500/5 text-rose-300'
          }`}
        >
          {demoMessage ?? 'HubSpot workflow finished'}
        </div>
      ) : null}

      <Card className="mb-6 p-4">
        <div className="mb-3 text-sm font-medium">Governed HubSpot workflow</div>
        <form action={runHubspotLeadWorkflowAction} className="grid grid-cols-1 md:grid-cols-6 gap-3">
          <Field label="Email" className="md:col-span-2">
            <input
              required
              name="email"
              type="email"
              defaultValue="demo-lead@example.com"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            />
          </Field>
          <Field label="First" className="md:col-span-1">
            <input
              name="firstname"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Last" className="md:col-span-1">
            <input
              name="lastname"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Company" className="md:col-span-2">
            <input
              name="company"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Deal" className="md:col-span-3">
            <input
              required
              name="dealname"
              defaultValue="Inbound pilot"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Amount" className="md:col-span-1">
            <input
              name="amount"
              type="number"
              min="0"
              step="1"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Stage" className="md:col-span-2">
            <input
              name="dealstage"
              placeholder="appointmentscheduled"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            />
          </Field>
          <Field label="Note" className="md:col-span-5">
            <input
              name="note"
              placeholder="Inbound demo request"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
            />
          </Field>
          <div className="md:col-span-1 flex items-end">
            <button
              type="submit"
              className="w-full px-3 py-2 rounded-md text-xs font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90"
            >
              Run
            </button>
          </div>
        </form>
      </Card>

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
                // An unknown dispatch is NOT a failure. The sweeper marks it
                // `failed` because the action did not complete, but the
                // external effect may well exist — so this row must not read
                // as "it did not happen", and Retry must not be offered as if
                // it were safe. Resolving it lives on /effects.
                const outcomeUnknown = a.dispatch_state === 'unknown';
                // Retry is only meaningful for failed actions whose original
                // policy decision was 'allow' — anything else needs operator
                // intervention upstream (policy change, approval, etc.).
                const canRetry =
                  a.status === 'failed' && effect === 'allow' && !outcomeUnknown;
                return (
                  <tr key={a.id} className="border-t border-[var(--color-border)] align-top">
                    <td className="px-4 py-2 mono text-xs text-[var(--color-muted)] whitespace-nowrap">
                      {new Date(a.created_at).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{a.agent_name}</td>
                    <td className="px-4 py-2 mono text-xs">{a.tool}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {outcomeUnknown ? (
                        <span
                          className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300"
                          title="The request went out and the answer never came back. The effect may or may not exist."
                        >
                          outcome unknown
                        </span>
                      ) : (
                        <StatusPill status={a.status} />
                      )}
                      {a.effect_assessment && !a.effect_assessment.reversible ? (
                        <div className="mt-1 text-[10px] text-rose-300">
                          {a.effect_assessment.effectClass} · irreversible
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 mono text-xs text-[var(--color-muted)]">{effect}</td>
                    <td className="px-4 py-2 text-xs text-[var(--color-muted)]">
                      {errCode ? <span className="text-rose-400">{errCode}</span> : reason ?? '—'}
                    </td>
                    <td className="px-4 py-2">
                      {outcomeUnknown ? (
                        <a
                          href="/effects"
                          className="text-xs text-amber-300 hover:underline"
                        >
                          resolve →
                        </a>
                      ) : a.dispatch_state !== 'not_dispatched' ? (
                        // Anything that was dispatched has a receipt trail, and
                        // the trail is the evidence — reachable from the row it
                        // belongs to rather than only by knowing the URL.
                        <a
                          href={`/effects/${a.id}`}
                          className="text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)] hover:underline"
                        >
                          evidence →
                        </a>
                      ) : canRetry ? (
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

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      {children}
    </label>
  );
}
