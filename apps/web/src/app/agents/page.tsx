import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';
import {
  Card,
  EmptyState,
  ErrorBox,
  H1,
  StatusPill,
  Subtitle,
} from '../../components/nav';

export const dynamic = 'force-dynamic';

async function registerAgentAction(formData: FormData) {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || undefined;
  if (!name) return;
  await api.agents.register({ name, ...(description ? { description } : {}) });
  revalidatePath('/agents');
  revalidatePath('/');
}

export default async function AgentsPage() {
  let items: Awaited<ReturnType<typeof api.agents.list>>['items'] = [];
  let error: unknown = null;
  try {
    items = (await api.agents.list()).items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-5xl">
      <H1>Agents</H1>
      <Subtitle>Each agent has an identity and a scoped API key.</Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      <Card className="mb-6 p-4">
        <form action={registerAgentAction} className="flex gap-3 items-end flex-wrap">
          <Field label="Name" name="name" placeholder="research-agent" required />
          <Field label="Description (optional)" name="description" placeholder="researches and updates leads" />
          <button
            type="submit"
            className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90"
          >
            Register
          </button>
        </form>
      </Card>

      {items.length === 0 ? (
        <EmptyState>No agents yet — register one above.</EmptyState>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Status</th>
                <th className="text-left px-4 py-2 font-medium">API key prefix</th>
                <th className="text-left px-4 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="border-t border-[var(--color-border)]">
                  <td className="px-4 py-2">
                    <div>{a.name}</div>
                    {a.description && (
                      <div className="text-xs text-[var(--color-muted)]">{a.description}</div>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <StatusPill status={a.status} />
                  </td>
                  <td className="px-4 py-2 mono text-xs">{a.api_key_prefix ?? '—'}</td>
                  <td className="px-4 py-2 mono text-xs text-[var(--color-muted)]">
                    {new Date(a.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
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
