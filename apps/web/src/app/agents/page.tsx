import { api } from '../../lib/api';
import {
  Card,
  EmptyState,
  ErrorBox,
  H1,
  StatusPill,
  Subtitle,
} from '../../components/nav';
import { RegisterForm } from './register-form';
import { RevokeForm } from './revoke-form';

export const dynamic = 'force-dynamic';

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
        <RegisterForm />
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
                <th className="text-left px-4 py-2 font-medium">Action</th>
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
                  <td className="px-4 py-2">
                    {a.status === 'active' ? (
                      <RevokeForm agentId={a.id} agentName={a.name} />
                    ) : (
                      <span className="text-xs text-[var(--color-muted)]">
                        {a.revoked_at ? new Date(a.revoked_at).toLocaleString() : '—'}
                      </span>
                    )}
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
