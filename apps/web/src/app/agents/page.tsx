import {
  AGENT_PERMISSION_PROFILE_OPTIONS,
  AGENT_PERMISSION_PROFILES,
  type AgentPermissionProfile,
} from '@agentbase/shared';
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
import {
  installPermissionProfilePolicyAction,
  updateAgentProfileAction,
} from './actions';

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
      <Subtitle>
        Every revenue agent gets an identity, scoped API key, permission profile,
        and revocation path before it can act on customer systems.
      </Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      <Card className="mb-6 p-4">
        <RegisterForm />
      </Card>

      <Card className="mb-6 p-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Permission profiles</div>
              <div className="text-xs text-[var(--color-muted)]">
                Templates generate policy rules for common GTM agent roles.
              </div>
            </div>
            <form action={installPermissionProfilePolicyAction}>
              <button
                type="submit"
                className="px-3 py-2 rounded-md text-xs font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90"
              >
                Install profile policy
              </button>
            </form>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {AGENT_PERMISSION_PROFILE_OPTIONS.map((profile) => (
              <div
                key={profile.key}
                className="rounded-md border border-[var(--color-border)] p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium">{profile.label}</div>
                  <span className="text-[10px] uppercase tracking-normal rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-muted)]">
                    {profile.rules.length} rules
                  </span>
                </div>
                <div className="text-xs text-[var(--color-muted)] mt-1">
                  {profile.summary}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      {items.length === 0 ? (
        <EmptyState>No agents yet — register one above.</EmptyState>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Profile</th>
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
                  <td className="px-4 py-2 min-w-[220px]">
                    <ProfileForm
                      agentId={a.id}
                      value={a.permission_profile}
                    />
                    <div className="text-xs text-[var(--color-muted)] mt-1">
                      {AGENT_PERMISSION_PROFILES[a.permission_profile].summary}
                    </div>
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

function ProfileForm({
  agentId,
  value,
}: {
  agentId: string;
  value: AgentPermissionProfile;
}) {
  return (
    <form action={updateAgentProfileAction} className="flex flex-wrap gap-2">
      <input type="hidden" name="agent_id" value={agentId} />
      <select
        name="permission_profile"
        defaultValue={value}
        aria-label="Permission profile"
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
      >
        {AGENT_PERMISSION_PROFILE_OPTIONS.map((profile) => (
          <option key={profile.key} value={profile.key}>
            {profile.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="px-2 py-1 rounded border border-[var(--color-border)] text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        Save profile
      </button>
    </form>
  );
}
