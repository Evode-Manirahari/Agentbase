import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';
import { Card, EmptyState, ErrorBox, H1, StatusPill, Subtitle } from '../../components/nav';

export const dynamic = 'force-dynamic';

async function decideAction(formData: FormData) {
  'use server';
  const id = String(formData.get('approval_id') ?? '');
  const decision = String(formData.get('decision') ?? '') as 'approve' | 'deny';
  const email = String(formData.get('email') ?? '').trim() || undefined;
  const notes = String(formData.get('notes') ?? '').trim() || undefined;
  if (!id || (decision !== 'approve' && decision !== 'deny')) return;
  await api.approvals.decide(id, {
    decision,
    ...(email ? { decided_by_email: email } : {}),
    ...(notes ? { notes } : {}),
  });
  revalidatePath('/approvals');
  revalidatePath('/');
  revalidatePath('/actions');
  revalidatePath('/audit');
}

export default async function ApprovalsPage() {
  let items: Awaited<ReturnType<typeof api.approvals.list>>['items'] = [];
  let error: unknown = null;
  try {
    items = (await api.approvals.list()).items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-5xl">
      <H1>Approvals</H1>
      <Subtitle>Pending actions waiting for human sign-off.</Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      {items.length === 0 ? (
        <EmptyState>Inbox zero. No pending approvals.</EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {items.map((it) => (
            <Card key={it.approval_id} className="p-4">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <StatusPill status="pending" />
                    <span className="text-sm font-medium mono">{it.tool}</span>
                  </div>
                  <div className="text-xs text-[var(--color-muted)]">
                    by <span className="text-[var(--color-text)]">{it.agent_name}</span> ·
                    requested {new Date(it.created_at).toLocaleString()} · expires{' '}
                    {it.expires_at ? new Date(it.expires_at).toLocaleString() : 'never'}
                  </div>
                  {it.policy_decision?.reason && (
                    <div className="text-xs text-amber-400 mt-1">
                      reason: {it.policy_decision.reason}
                    </div>
                  )}
                </div>
              </div>

              <pre className="text-xs mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-3 overflow-x-auto mb-3">
                {JSON.stringify(it.params, null, 2)}
              </pre>

              <form action={decideAction} className="flex flex-wrap gap-2 items-end">
                <input type="hidden" name="approval_id" value={it.approval_id} />
                <input
                  type="email"
                  name="email"
                  placeholder="your@email.com"
                  required
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm flex-1 min-w-[200px] focus:outline-none focus:border-[var(--color-accent)]"
                />
                <input
                  type="text"
                  name="notes"
                  placeholder="optional notes"
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm flex-1 min-w-[200px] focus:outline-none focus:border-[var(--color-accent)]"
                />
                <button
                  type="submit"
                  name="decision"
                  value="approve"
                  className="px-4 py-2 rounded-md text-sm font-medium bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25"
                >
                  Approve
                </button>
                <button
                  type="submit"
                  name="decision"
                  value="deny"
                  className="px-4 py-2 rounded-md text-sm font-medium bg-rose-500/15 border border-rose-500/40 text-rose-300 hover:bg-rose-500/25"
                >
                  Deny
                </button>
              </form>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
