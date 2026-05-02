const BASE_URL = process.env.API_URL ?? 'http://localhost:3002';

async function req<T>(
  path: string,
  init: RequestInit = {},
  cacheTag?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
    ...(cacheTag ? { next: { tags: [cacheTag] } } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${init.method ?? 'GET'} ${path} -> ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'disabled' | 'revoked';
  created_at: string;
  revoked_at: string | null;
  api_key_prefix: string | null;
}

export interface ActionRow {
  id: string;
  agent_id: string;
  agent_name: string;
  tool: string;
  params: Record<string, unknown>;
  status: 'pending' | 'awaiting_approval' | 'approved' | 'denied' | 'executed' | 'failed';
  policy_decision: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
}

export interface ApprovalRow {
  approval_id: string;
  action_id: string;
  agent_id: string;
  agent_name: string;
  tool: string;
  params: Record<string, unknown>;
  policy_decision: { reason?: string; approver_role?: string | null } | null;
  required_role: string;
  decision: 'pending' | 'approved' | 'denied' | 'expired';
  expires_at: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by_email: string | null;
}

export interface AuditRow {
  id: string;
  orgId: string;
  actorType: string;
  actorId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ActivePolicy {
  policy_id: string | null;
  name: string | null;
  version: number | null;
  yaml: string | null;
  document: { version: 1; default: 'allow' | 'deny'; rules: unknown[] } | null;
  is_fallback: boolean;
}

export const api = {
  agents: {
    list: () => req<{ items: AgentRow[] }>(`/v1/agents`),
    register: (body: { name: string; description?: string }) =>
      req<{ agent_id: string; api_key: string; api_key_prefix: string }>(
        `/v1/agents`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
  },
  actions: {
    list: (limit = 100) => req<{ items: ActionRow[] }>(`/v1/actions?limit=${limit}`),
  },
  approvals: {
    list: () => req<{ items: ApprovalRow[] }>(`/v1/approvals`),
    decide: (
      approvalId: string,
      body: { decision: 'approve' | 'deny'; decided_by_email?: string; notes?: string },
    ) =>
      req<{
        approval_id: string;
        decision: string;
        action_id: string;
        action_status: string;
        result: unknown;
      }>(`/v1/approvals/${approvalId}/decision`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  audit: {
    list: (limit = 100) => req<{ items: AuditRow[] }>(`/v1/audit?limit=${limit}`),
  },
  policies: {
    active: () => req<ActivePolicy>(`/v1/policies/active`),
    setActive: (body: { name?: string; yaml: string }) =>
      req<ActivePolicy>(`/v1/policies/active`, {
        method: 'PUT',
        body: JSON.stringify({ name: body.name ?? 'default', yaml: body.yaml }),
      }),
  },
};
