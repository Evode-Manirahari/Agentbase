'use client';

import { useActionState } from 'react';
import type { ConnectorStatus } from '../../lib/api';
import {
  saveConnectorCredentialsAction,
  type ConnectorFormState,
} from './actions';

const initialState: ConnectorFormState = { status: 'idle' };

export function CredentialForm({ connector }: { connector: ConnectorStatus }) {
  const [state, formAction, pending] = useActionState(
    saveConnectorCredentialsAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="provider" value={connector.provider} />
      <div className="grid grid-cols-2 gap-3">
        {connector.fields.map((field) => (
          <label
            key={field.key}
            className="flex flex-col gap-1 text-xs text-[var(--color-muted)]"
          >
            {field.label}
            <input
              type={field.secret ? 'password' : 'text'}
              name={field.key}
              placeholder={field.placeholder}
              required={!field.key.endsWith('_id')}
              autoComplete="off"
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] placeholder-[var(--color-muted)] focus:outline-none focus:border-[var(--color-accent)]"
            />
          </label>
        ))}
      </div>
      {state.status === 'error' ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/5 text-rose-300 p-2 text-xs">
          {state.message}
        </div>
      ) : null}
      {state.status === 'success' ? (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/5 text-emerald-300 p-2 text-xs">
          {state.message}
        </div>
      ) : null}
      <div>
        <button
          type="submit"
          disabled={pending}
          className="px-3 py-2 rounded-md text-xs font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? 'Saving...' : 'Save credentials'}
        </button>
      </div>
    </form>
  );
}
