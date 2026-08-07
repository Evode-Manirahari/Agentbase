'use client';

import { useActionState, useMemo, useState } from 'react';
import { Card, StatusPill } from '../../components/nav';
import type { ApprovalRow } from '../../lib/api';
import {
  bulkDecideAction,
  decideOneAction,
  type BulkDecideState,
} from './actions';

const initialBulk: BulkDecideState = { result: null, error: null };

export function ApprovalsList({ items }: { items: ApprovalRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkState, bulkAction, bulkPending] = useActionState(
    bulkDecideAction,
    initialBulk,
  );

  const allSelected = items.length > 0 && selected.size === items.length;
  const noneSelected = selected.size === 0;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }
  function selectAll() {
    setSelected(new Set(items.map((it) => it.approval_id)));
  }
  function clear() {
    setSelected(new Set());
  }

  return (
    <div className="flex flex-col gap-4">
      <BulkBar
        items={items}
        selected={selected}
        allSelected={allSelected}
        onSelectAll={selectAll}
        onClear={clear}
        action={bulkAction}
        pending={bulkPending}
        state={bulkState}
        disabled={noneSelected}
      />

      {items.map((it) => (
        <Card key={it.approval_id} className="p-4">
          <div className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={selected.has(it.approval_id)}
              onChange={() => toggle(it.approval_id)}
              className="mt-1 h-4 w-4 rounded border border-[var(--color-border)] bg-[var(--color-bg)] accent-[var(--color-accent)]"
              aria-label={`Select approval ${it.approval_id}`}
            />
            <div className="flex-1">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <StatusPill status="pending" />
                    <span className="text-sm font-medium mono">{it.tool}</span>
                  </div>
                  <div className="text-xs text-[var(--color-muted)]">
                    by{' '}
                    <span className="text-[var(--color-text)]">{it.agent_name}</span> ·
                    requested {new Date(it.created_at).toLocaleString()} · expires{' '}
                    {it.expires_at
                      ? new Date(it.expires_at).toLocaleString()
                      : 'never'}
                  </div>
                  {it.effect_assessment && (
                    // The consequence, stated before the buttons. Someone about
                    // to approve is deciding whether an EFFECT is acceptable,
                    // and the params below state the command without stating
                    // what it does. Rendered only when the gate actually
                    // assessed it — a default here would be a claim nobody made.
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="mono rounded border border-[var(--color-border)] px-2 py-0.5">
                        {it.effect_assessment.effectClass}
                      </span>
                      <span
                        className={
                          it.effect_assessment.reversible
                            ? 'rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-300'
                            : 'rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-rose-300'
                        }
                      >
                        {it.effect_assessment.reversible
                          ? 'reversible'
                          : 'cannot be undone'}
                      </span>
                      <span className="text-[var(--color-muted)]">
                        {it.effect_assessment.summary}
                      </span>
                    </div>
                  )}
                  {it.policy_decision?.reason && (
                    <div className="text-xs text-amber-400 mt-1">
                      reason: {it.policy_decision.reason}
                    </div>
                  )}
                  {it.slack_channel && it.slack_ts ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-muted)]">
                      <span className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-300">
                        Slack posted
                      </span>
                      <span className="mono">{it.slack_channel}</span>
                    </div>
                  ) : null}
                </div>
              </div>

              <pre className="text-xs mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded p-3 overflow-x-auto mb-3">
                {JSON.stringify(it.params, null, 2)}
              </pre>

              <form
                action={decideOneAction}
                className="flex flex-wrap gap-2 items-end"
              >
                <input
                  type="hidden"
                  name="approval_id"
                  value={it.approval_id}
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
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function BulkBar({
  items,
  selected,
  allSelected,
  onSelectAll,
  onClear,
  action,
  pending,
  state,
  disabled,
}: {
  items: ApprovalRow[];
  selected: Set<string>;
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  action: (formData: FormData) => void;
  pending: boolean;
  state: BulkDecideState;
  disabled: boolean;
}) {
  const selectedItems = useMemo(
    () => items.filter((it) => selected.has(it.approval_id)),
    [items, selected],
  );

  return (
    <form
      action={action}
      className="sticky top-0 z-10 rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-3 flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={allSelected ? onClear : onSelectAll}
          className="px-2 py-1 text-xs rounded-md border border-[var(--color-border)] hover:border-[var(--color-accent)]"
        >
          {allSelected ? 'Clear selection' : `Select all (${items.length})`}
        </button>
        <span className="text-xs text-[var(--color-muted)]">
          {selected.size} selected
        </span>
        <div className="flex-1" />
        <input
          type="text"
          name="notes"
          placeholder="optional notes (applied to all)"
          disabled={disabled}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm flex-1 min-w-[200px] focus:outline-none focus:border-[var(--color-accent)] disabled:opacity-40"
        />
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={disabled || pending}
          className="px-4 py-2 rounded-md text-sm font-medium bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? 'Approving…' : `Approve ${selected.size || ''}`.trim()}
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          disabled={disabled || pending}
          className="px-4 py-2 rounded-md text-sm font-medium bg-rose-500/15 border border-rose-500/40 text-rose-300 hover:bg-rose-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? 'Denying…' : `Deny ${selected.size || ''}`.trim()}
        </button>
      </div>

      {selectedItems.map((it) => (
        <input
          key={it.approval_id}
          type="hidden"
          name="approval_id"
          value={it.approval_id}
        />
      ))}

      {state.error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/5 p-2 text-xs text-rose-300">
          {state.error}
        </div>
      ) : null}
      {state.result ? <BulkSummary state={state} /> : null}
    </form>
  );
}

function BulkSummary({ state }: { state: BulkDecideState }) {
  if (!state.result) return null;
  const { decided, skipped_already_decided, failed } = state.result.summary;
  const failedItems = state.result.items.filter(
    (it): it is Extract<typeof it, { outcome: 'failed' }> =>
      it.outcome === 'failed',
  );
  return (
    <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2 text-xs text-emerald-300">
      <div>
        <span className="mono">decided={decided}</span> ·{' '}
        <span className="mono">skipped={skipped_already_decided}</span> ·{' '}
        <span className="mono">failed={failed}</span>
      </div>
      {failedItems.length > 0 ? (
        <ul className="mt-1 mono text-[10px] text-rose-300 space-y-0.5">
          {failedItems.map((it) => (
            <li key={it.approval_id}>
              {it.approval_id.slice(0, 8)} — {it.error.code}: {it.error.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
