import { api } from '../../lib/api';
import { Card, ErrorBox, H1, StatusPill, Subtitle } from '../../components/nav';
import { PolicyEditor } from './policy-editor';
import { setPolicyAction } from './actions';

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
    slack_channel: "#critical-approvals"
  - match:
      tool: hubspot.deals.update
    effect: require_approval
    approver_role: approver
    reason: "deal change"
  - match:
      tool: hubspot.*.delete
    effect: deny
`;

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
        <PolicyEditor
          initialName={initialName}
          initialYaml={initialYaml}
          action={setPolicyAction}
        />
      </Card>
    </div>
  );
}
