import { auth } from '@clerk/nextjs/server';
import type { AgentPermissionProfile } from '@agentbase/shared';

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
  permission_profile: AgentPermissionProfile;
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
  slack_channel: string | null;
  slack_ts: string | null;
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
  approval_rate: number | null;
  approval_stats: {
    require_approval_total: number;
    approved: number;
    denied: number;
    pending: number;
  };
  rate_limited_count: number;
  top_tools: { tool: string; count: number }[];
  top_agents: { agent_id: string; agent_name: string; count: number }[];
  top_policy_rules: {
    reason: string;
    effect: 'allow' | 'require_approval' | 'deny';
    count: number;
  }[];
  generated_at: string;
}

export interface MetricsTimeseries {
  window_hours: number;
  bucket: 'day';
  buckets: string[];
  series: {
    agent_id: string;
    agent_name: string;
    counts: number[];
  }[];
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

export interface ConnectorStatus {
  provider: 'hubspot' | 'salesforce' | 'gmail' | 'outreach' | 'apollo';
  configured: boolean;
  enabled: boolean;
  source: 'org' | 'env' | null;
  auth_type: 'oauth' | 'static' | 'env' | null;
  updated_at: string | null;
  fields: { key: string; label: string; secret: boolean; placeholder?: string }[];
  oauth_available: boolean;
  account: {
    id?: number | string | null;
    hub_id?: number | string | null;
    hub_domain?: string | null;
    instance_url?: string | null;
    user?: string | null;
    scopes?: string[];
    expires_at?: string | null;
  } | null;
}

export type AgentRunStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export type TranscriptEntry =
  | { type: 'agent_thinking'; text: string }
  | { type: 'agent_message'; text: string }
  | {
      type: 'tool_call';
      tool_use_id: string;
      job_tool_name: string;
      agentbase_tool: string;
      params: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      action_id: string;
      status: ActionRow['status'];
      policy_decision: {
        effect: 'allow' | 'require_approval' | 'deny';
        reason: string | null;
      };
      result?: Record<string, unknown> | null;
    };

// Persisted agent run. Matches /v1/campaigns/runs/:id shape.
export interface AgentRunResult {
  id: string;
  org_id: string;
  agent_id: string;
  job_key: string;
  context: Record<string, unknown>;
  status: AgentRunStatus;
  transcript: TranscriptEntry[];
  paused_on: {
    action_id: string;
    tool_use_id: string;
    agentbase_tool: string;
  } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  } | null;
  error: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type BulkApprovalDecisionItem =
  | {
      approval_id: string;
      outcome: 'decided';
      decision: string;
      action_id: string;
      action_status: string;
      result: unknown;
    }
  | {
      approval_id: string;
      outcome: 'skipped_already_decided';
      decision: string;
    }
  | {
      approval_id: string;
      outcome: 'failed';
      error: { code: string; message: string };
    };

export interface BulkApprovalDecisionResponse {
  items: BulkApprovalDecisionItem[];
  summary: {
    decided: number;
    skipped_already_decided: number;
    failed: number;
  };
}

export interface CampaignJobSummary {
  key: string;
  label: string;
  description: string;
  model: string;
  tools: { name: string; description: string; agentbase_tool: string }[];
}

export const api = {
  agents: {
    list: () => req<{ items: AgentRow[] }>(`/v1/agents`),
    register: (body: {
      name: string;
      description?: string;
      permission_profile?: AgentPermissionProfile;
    }) =>
      req<{
        agent_id: string;
        api_key: string;
        api_key_prefix: string;
        permission_profile: AgentPermissionProfile;
      }>(
        `/v1/agents`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    updatePermissionProfile: (
      agentId: string,
      permission_profile: AgentPermissionProfile,
    ) =>
      req<{ id: string; permission_profile: AgentPermissionProfile }>(
        `/v1/agents/${agentId}/permission-profile`,
        {
          method: 'PATCH',
          body: JSON.stringify({ permission_profile }),
        },
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
    runHubspotLeadWorkflow: (body: {
      email: string;
      firstname?: string;
      lastname?: string;
      company?: string;
      jobtitle?: string;
      phone?: string;
      dealname: string;
      amount?: number;
      pipeline?: string;
      dealstage?: string;
      note?: string;
    }) =>
      req<{
        action_id: string;
        status: ActionRow['status'];
        result?: Record<string, unknown>;
        policy_decision: unknown;
      }>(`/v1/actions/demo/hubspot-lead`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
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
    bulkDecide: (body: {
      approval_ids: string[];
      decision: 'approve' | 'deny';
      decided_by_email?: string;
      notes?: string;
    }) =>
      req<BulkApprovalDecisionResponse>(`/v1/approvals/bulk-decide`, {
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
    timeseries: (windowHours = 168) =>
      req<MetricsTimeseries>(`/v1/metrics/timeseries?window_hours=${windowHours}`),
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
  connectors: {
    list: () => req<{ items: ConnectorStatus[] }>(`/v1/connectors`),
    startOAuth: (provider: ConnectorStatus['provider']) =>
      req<{
        authorization_url: string;
        expires_at: string;
        redirect_uri: string;
        scopes: string[];
      }>(`/v1/connectors/${provider}/oauth/start`, {
        method: 'POST',
      }),
    test: (provider: ConnectorStatus['provider']) =>
      req<{
        provider: ConnectorStatus['provider'];
        ok: boolean;
        checked_at: string;
        result: Record<string, unknown>;
      }>(`/v1/connectors/${provider}/test`, {
        method: 'POST',
      }),
    saveCredentials: (
      provider: ConnectorStatus['provider'],
      credentials: Record<string, string>,
    ) =>
      req<ConnectorStatus>(`/v1/connectors/${provider}/credentials`, {
        method: 'PUT',
        body: JSON.stringify({ credentials }),
      }),
    disable: (provider: ConnectorStatus['provider']) =>
      req<ConnectorStatus>(`/v1/connectors/${provider}/disable`, {
        method: 'POST',
      }),
  },
  campaigns: {
    jobs: () => req<{ items: CampaignJobSummary[] }>(`/v1/campaigns/jobs`),
    createRun: (body: {
      job_key: string;
      agent_id: string;
      context: Record<string, unknown>;
    }) =>
      req<AgentRunResult>(`/v1/campaigns/runs`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    getRun: (runId: string) =>
      req<AgentRunResult>(`/v1/campaigns/runs/${runId}`),
    listRuns: (limit = 50) =>
      req<{ items: AgentRunResult[] }>(`/v1/campaigns/runs?limit=${limit}`),
    createBatch: (body: {
      job_key: string;
      agent_id: string;
      leads: { email: string; notes?: string }[];
    }) =>
      req<{ batch_id: string; run_count: number; run_ids: string[] }>(
        `/v1/campaigns/batches`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    getBatch: (batchId: string) =>
      req<CampaignBatchDetail>(`/v1/campaigns/batches/${batchId}`),
    checkRepliesForRun: (runId: string) =>
      req<{ enqueued: true; run_id: string }>(
        `/v1/campaigns/runs/${runId}/check-replies`,
        { method: 'POST' },
      ),
    checkRepliesForBatch: (batchId: string) =>
      req<{ enqueued: true; batch_id: string }>(
        `/v1/campaigns/batches/${batchId}/check-replies`,
        { method: 'POST' },
      ),
  },
};

export interface CampaignBatchDetail {
  batch_id: string;
  run_count: number;
  runs: AgentRunResult[];
  status_summary: {
    pending: number;
    running: number;
    paused: number;
    completed: number;
    failed: number;
  };
}
