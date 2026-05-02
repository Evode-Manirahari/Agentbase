import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';
import { Card, ErrorBox, H1, StatusPill, Subtitle } from '../../components/nav';

export const dynamic = 'force-dynamic';

const PLACEHOLDER = `version: 1
default: deny
rules:
  - match:
      tool: hubspot.contacts.update
    effect: allow
  - match:
      tool: hubspot.deals.update
      when:
        amount: { gt: 10000 }
    effect: require_approval
    approver_role: approver
    reason: "high-value deal"
  - match:
      tool: hubspot.*.delete
    effect: deny
`;

async function setPolicyAction(formData: FormData) {
  'use server';
  const yaml = String(formData.get('yaml') ?? '').trim();
  const name = String(formData.get('name') ?? 'default').trim() || 'default';
  if (!yaml) return;
  await api.policies.setActive({ name, yaml });
  revalidatePath('/policies');
  revalidatePath('/');
}

export default async function PoliciesPage() {
  let policy: Awaited<ReturnType<typeof api.policies.active>> | null = null;
  let error: unknown = null;
  try {
    policy = await api.policies.active();
  } catch (e) {
    error = e;
  }

  const initialYaml = policy?.yaml ?? PLACEHOLDER;
  const initialName = policy?.name ?? 'default';

  return (
    <div className="max-w-5xl">
      <H1>Policies</H1>
      <Subtitle>YAML rules that decide allow / require_approval / deny per action.</Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card className="px-4 py-3">
          <div className="text-xs text-[var(--color-muted)] uppercase mb-1">Active version</div>
          <div className="text-2xl font-semibold">
            {policy?.is_fallback ? <StatusPill status="fallback" /> : `v${policy?.version}`}
          </div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs text-[var(--color-muted)] uppercase mb-1">Rule count</div>
          <div className="text-2xl font-semibold">{policy?.document?.rules.length ?? 0}</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs text-[var(--color-muted)] uppercase mb-1">Default</div>
          <div className="text-2xl font-semibold">{policy?.document?.default ?? '—'}</div>
        </Card>
      </div>

      <Card className="p-4">
        <form action={setPolicyAction} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)] max-w-xs">
            Policy name
            <input
              name="name"
              defaultValue={initialName}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--color-muted)]">
            YAML
            <textarea
              name="yaml"
              defaultValue={initialYaml}
              rows={20}
              spellCheck={false}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] mono focus:outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <div>
            <button
              type="submit"
              className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90"
            >
              Save and activate
            </button>
            <span className="ml-3 text-xs text-[var(--color-muted)]">
              Saving creates a new version and deactivates the previous active policy.
            </span>
          </div>
        </form>
      </Card>
    </div>
  );
}
