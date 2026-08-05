'use client';

import { useActionState, useState } from 'react';
import { createWebhookAction, type CreateState } from './actions';
import { KNOWN_EVENTS, DEFAULT_WEBHOOK_EVENTS } from './events';

const initialState: CreateState = { status: 'idle' };

export function CreateWebhookForm() {
  const [state, formAction, pending] = useActionState(
    createWebhookAction,
    initialState,
  );
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [wildcard, setWildcard] = useState(false);

  const showBanner = state.status === 'success' && !dismissed;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {showBanner && state.status === 'success' ? (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4">
          <div className="flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-emerald-300 mb-1">
                Webhook{' '}
                <span className="font-semibold">{state.subscription.name}</span>{' '}
                created
              </div>
              <p className="text-xs text-[var(--color-muted)] mb-3">
                Copy the signing secret now — it won&apos;t be shown again.
                Receivers verify requests by computing
                HMAC-SHA256(<code>${'{'}timestamp{'}'}.${'{'}body{'}'}</code>) with
                this secret and comparing to the
                <code>x-agentbase-signature</code> header.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] text-xs break-all mono text-[var(--color-text)]">
                  {state.subscription.secret}
                </code>
                <button
                  type="button"
                  onClick={() => copy(state.subscription.secret)}
                  className="px-3 py-2 rounded-md text-xs font-medium border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 whitespace-nowrap"
                >
                  {copied ? 'Copied ✓' : 'Copy'}
                </button>
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
              title="Dismiss (the secret cannot be recovered after this)"
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

      <form action={formAction} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Name"
            name="name"
            placeholder="pagerduty-prod"
            required
          />
          <Field
            label="URL"
            name="url"
            placeholder="https://hooks.example.com/incoming"
            required
          />
        </div>

        <div>
          <div className="text-xs text-[var(--color-muted)] mb-2">Events</div>
          <label className="inline-flex items-center gap-2 text-sm text-[var(--color-muted)] mb-2">
            <input
              type="checkbox"
              name="wildcard"
              checked={wildcard}
              onChange={(e) => setWildcard(e.target.checked)}
            />
            <span>All events (<code className="mono text-xs">*</code>)</span>
          </label>
          {!wildcard && (
            <div className="grid grid-cols-2 gap-1 text-xs">
              {KNOWN_EVENTS.map((ev) => (
                <label
                  key={ev}
                  className="inline-flex items-center gap-2 text-[var(--color-muted)]"
                >
                  <input
                    type="checkbox"
                    name="events"
                    value={ev}
                    defaultChecked={(
                      DEFAULT_WEBHOOK_EVENTS as readonly string[]
                    ).includes(ev)}
                  />
                  <code className="mono text-xs">{ev}</code>
                </label>
              ))}
            </div>
          )}
        </div>

        <div>
          <button
            type="submit"
            disabled={pending}
            className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending ? 'Creating…' : 'Create webhook'}
          </button>
        </div>
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
    <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
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
