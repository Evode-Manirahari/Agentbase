import { auth } from '@clerk/nextjs/server';

const BASE_URL = process.env.API_URL ?? 'http://localhost:3002';
const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

// Forwards the signed-in user's Clerk session JWT to the API. The API's
// ClerkAuthGuard validates it via @clerk/backend's verifyToken. In dev mode
// (no Clerk keys), this returns null and the request goes through with no
// Authorization header — the API's ClerkAuthGuard is also in dev-mode
// pass-through, so the loop closes.
async function getAuthToken(): Promise<string | null> {
  if (!clerkEnabled) return null;
  try {
    const a = await auth();
    return (await a.getToken()) ?? null;
  } catch {
    return null;
  }
}

async function req<T>(
  path: string,
  init: RequestInit = {},
  cacheTag?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const token = await getAuthToken();
  if (token && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`);
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

export interface MetricsOverview {
  window_hours: number;
  total: number;
  by_status: Record<
    'pending' | 'awaiting_approval' | 'approved' | 'denied' | 'executed' | 'failed',
    number
  >;
  deny_rate: number;
  failure_rate: number;
  rate_limited_count: number;
  top_tools: { tool: string; count: number }[];
  top_agents: { agent_id: string; agent_name: string; count: number }[];
  generated_at: string;
}

export interface WebhookSubscriptionRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  last_delivery_at: string | null;
  last_delivery_status: string | null;
  created_at: string;
}

export interface WebhookSubscriptionCreated {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret: string;
  created_at: string;
}

export const api = {
  agents: {
    list: () => req<{ items: AgentRow[] }>(`/v1/agents`),
    register: (body: { name: string; description?: string }) =>
      req<{ agent_id: string; api_key: string; api_key_prefix: string }>(
        `/v1/agents`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    revoke: (agentId: string, body: { reason?: string; revoked_by_email?: string } = {}) =>
      req<{
        agent_id: string;
        status: 'revoked';
        revoked_at: string | null;
        keys_revoked: number;
        already_revoked: boolean;
      }>(`/v1/agents/${agentId}/revoke`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  actions: {
    list: (limit = 100) => req<{ items: ActionRow[] }>(`/v1/actions?limit=${limit}`),
    retry: (actionId: string) =>
      req<{
        action_id: string;
        status: ActionRow['status'];
        result?: Record<string, unknown>;
        policy_decision: unknown;
      }>(`/v1/actions/${actionId}/retry`, { method: 'POST' }),
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
    list: (
      params: {
        limit?: number;
        actor_type?: string;
        event_type?: string;
        since?: string;
        until?: string;
      } = {},
    ) => {
      const qs = new URLSearchParams();
      qs.set('limit', String(params.limit ?? 100));
      if (params.actor_type) qs.set('actor_type', params.actor_type);
      if (params.event_type) qs.set('event_type', params.event_type);
      if (params.since) qs.set('since', params.since);
      if (params.until) qs.set('until', params.until);
      return req<{ items: AuditRow[] }>(`/v1/audit?${qs.toString()}`);
    },
    eventTypes: () => req<{ items: string[] }>(`/v1/audit/event-types`),
  },
  policies: {
    active: () => req<ActivePolicy>(`/v1/policies/active`),
    setActive: (body: { name?: string; yaml: string }) =>
      req<ActivePolicy>(`/v1/policies/active`, {
        method: 'PUT',
        body: JSON.stringify({ name: body.name ?? 'default', yaml: body.yaml }),
      }),
  },
  metrics: {
    overview: (windowHours = 24) =>
      req<MetricsOverview>(`/v1/metrics/overview?window_hours=${windowHours}`),
  },
  webhooks: {
    list: () => req<{ items: WebhookSubscriptionRow[] }>(`/v1/webhooks`),
    create: (body: { name: string; url: string; events: string[] }) =>
      req<WebhookSubscriptionCreated>(`/v1/webhooks`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (
      id: string,
      patch: { enabled?: boolean; events?: string[]; url?: string; name?: string },
    ) =>
      req<{ ok: true }>(`/v1/webhooks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    remove: (id: string) =>
      req<void>(`/v1/webhooks/${id}`, { method: 'DELETE' }),
  },
};
