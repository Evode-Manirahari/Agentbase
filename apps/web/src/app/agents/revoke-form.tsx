'use client';

import { useState, useTransition } from 'react';
import { revokeAgentAction } from './actions';

export interface RevokeFormProps {
  agentId: string;
  agentName: string;
}

export function RevokeForm({ agentId, agentName }: RevokeFormProps) {
  const [confirmName, setConfirmName] = useState('');
  const [email, setEmail] = useState('');
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const nameMatches = confirmName.trim() === agentName;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const canSubmit = nameMatches && emailValid && !pending;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-3 py-1 rounded-md text-xs font-medium bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20"
      >
        Revoke…
      </button>
    );
  }

  return (
    <form
      action={(fd) => startTransition(() => revokeAgentAction(fd))}
      className="flex flex-col gap-2 max-w-md"
    >
      <input type="hidden" name="agent_id" value={agentId} />
      <div className="text-xs text-rose-300">
        Type{' '}
        <code className="mono px-1 rounded bg-[var(--color-bg)] border border-[var(--color-border)]">
          {agentName}
        </code>{' '}
        to confirm. Revocation is immediate and cannot be undone.
      </div>
      <input
        type="text"
        value={confirmName}
        onChange={(e) => setConfirmName(e.target.value)}
        placeholder={agentName}
        autoComplete="off"
        spellCheck={false}
        className={`rounded-md border bg-[var(--color-bg)] px-2 py-1 text-xs mono focus:outline-none ${
          nameMatches
            ? 'border-emerald-500/40'
            : confirmName.length
              ? 'border-rose-500/40'
              : 'border-[var(--color-border)]'
        }`}
      />
      <input
        type="email"
        name="revoked_by_email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="your@email.com"
        required
        className={`rounded-md border bg-[var(--color-bg)] px-2 py-1 text-xs focus:outline-none ${
          emailValid
            ? 'border-emerald-500/40'
            : email.length
              ? 'border-rose-500/40'
              : 'border-[var(--color-border)]'
        }`}
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="px-3 py-1 rounded-md text-xs font-medium bg-rose-500/15 border border-rose-500/40 text-rose-300 hover:bg-rose-500/25 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {pending ? 'Revoking…' : 'Revoke permanently'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setConfirmName('');
            setEmail('');
          }}
          className="px-3 py-1 rounded-md text-xs border border-[var(--color-border)] text-[var(--color-muted)] hover:bg-[var(--color-bg)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
