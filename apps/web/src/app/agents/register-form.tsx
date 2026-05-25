'use client';

import { useActionState, useState } from 'react';
import { AGENT_PERMISSION_PROFILE_OPTIONS } from '@agentbase/shared';
import { registerAgentAction, type RegisterState } from './actions';

const initialRegisterState: RegisterState = { status: 'idle' };

export function RegisterForm() {
  const [state, formAction, pending] = useActionState(
    registerAgentAction,
    initialRegisterState,
  );
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const showBanner = state.status === 'success' && !dismissed;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore — clipboard not available
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {showBanner && state.status === 'success' ? (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-emerald-300 mb-1">
                Agent <span className="font-semibold">{state.name}</span> registered
              </div>
              <p className="text-xs text-[var(--color-muted)] mb-3">
                Copy the API key now — it won&apos;t be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-xs break-all mono text-[var(--color-text)]">
                  {state.api_key}
                </code>
                <button
                  type="button"
                  onClick={() => copy(state.api_key)}
                  className="px-3 py-2 rounded-md text-xs font-medium border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 whitespace-nowrap"
                >
                  {copied ? 'Copied ✓' : 'Copy'}
                </button>
              </div>
              <div className="text-xs text-[var(--color-muted)] mt-3 mono">
                agent_id: {state.agent_id}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setDismissed(true);
                setCopied(false);
              }}
              className="text-[var(--color-muted)] hover:text-white px-2"
              aria-label="Dismiss"
              title="Dismiss (the key cannot be recovered after this)"
            >
              ✕
            </button>
          </div>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/5 text-rose-300 p-3 text-sm">
          {state.message}
        </div>
      ) : null}

      <form action={formAction} className="flex gap-3 items-end flex-wrap">
        <Field
          label="Name"
          name="name"
          placeholder="research-agent"
          required
        />
        <Field
          label="Description (optional)"
          name="description"
          placeholder="researches and updates leads"
        />
        <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)] flex-1 min-w-[200px]">
          Permission profile
          <select
            name="permission_profile"
            defaultValue="sales_sdr"
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
          >
            {AGENT_PERMISSION_PROFILE_OPTIONS.map((profile) => (
              <option key={profile.key} value={profile.key}>
                {profile.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {pending ? 'Registering…' : 'Register'}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  placeholder,
  required = false,
}: {
  label: string;
  name: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)] flex-1 min-w-[200px]">
      {label}
      <input
        type="text"
        name={name}
        placeholder={placeholder}
        required={required}
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] placeholder-[var(--color-muted)] focus:outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}
