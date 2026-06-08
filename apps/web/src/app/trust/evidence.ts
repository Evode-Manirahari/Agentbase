import { AGENT_PERMISSION_PROFILES } from '@agentbase/shared';
import {
  api,
  type ActionRow,
  type AgentRow,
  type ApprovalRow,
  type AuditRow,
  type ConnectorStatus,
} from '../../lib/api';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskClassification {
  level: RiskLevel;
  reason: string;
}

export interface ApprovalEvidence {
  approval_id: string | null;
  decision: 'pending' | 'approved' | 'denied' | 'expired';
  actor_id: string | null;
  decided_at: string | null;
  slack_channel: string | null;
}

export interface EvidenceAction extends ActionRow {
  risk: RiskClassification;
  approval: ApprovalEvidence | null;
  connector: string | null;
  audit_events: AuditRow[];
}

export interface TrustSummary {
  total_actions: number;
  status_counts: Record<ActionRow['status'], number>;
  risk_counts: Record<RiskLevel, number>;
  approval_counts: {
    required: number;
    pending: number;
    approved: number;
    denied: number;
    expired: number;
  };
  configured_connectors: number;
  active_connectors: string[];
  top_tools: { tool: string; count: number }[];
}

export interface TrustEvidence {
  generated_at: string;
  selected_agent_id: string | null;
  selected_agent: AgentRow | null;
  agents: AgentRow[];
  active_policy: Awaited<ReturnType<typeof api.policies.active>>;
  connectors: ConnectorStatus[];
  actions: EvidenceAction[];
  audit_events: AuditRow[];
  summary: TrustSummary;
}

export async function loadTrustEvidence(
  rawAgentId?: string | null,
): Promise<TrustEvidence> {
  const requestedAgentId =
    rawAgentId && rawAgentId !== 'all' ? rawAgentId.trim() : null;
  const [agentsRes, actionsRes, approvalsRes, auditRes, activePolicy, connectorsRes] =
    await Promise.all([
      api.agents.list(),
      api.actions.list(500),
      api.approvals.list(),
      api.audit.list({ limit: 500 }),
      api.policies.active(),
      api.connectors.list(),
    ]);

  const selectedAgent = requestedAgentId
    ? agentsRes.items.find((agent) => agent.id === requestedAgentId) ?? null
    : null;
  const agentId = selectedAgent?.id ?? null;
  const scopedActions = agentId
    ? actionsRes.items.filter((action) => action.agent_id === agentId)
    : actionsRes.items;
  const actionIds = new Set(scopedActions.map((action) => action.id));
  const scopedAuditEvents = auditRes.items.filter((event) => {
    const actionId = payloadString(event.payload, 'actionId');
    const payloadAgentId = payloadString(event.payload, 'agentId');
    if (actionId && actionIds.has(actionId)) return true;
    if (agentId && payloadAgentId === agentId) return true;
    if (agentId && event.actorType === 'agent' && event.actorId === agentId) {
      return true;
    }
    return !agentId && (actionId === null || actionIds.has(actionId));
  });

  const pendingApprovalsByAction = new Map(
    approvalsRes.items
      .filter((approval) => actionIds.has(approval.action_id))
      .map((approval) => [approval.action_id, approval]),
  );

  const auditByAction = groupAuditByAction(scopedAuditEvents);
  const actions = scopedActions.map((action) => {
    const events = auditByAction.get(action.id) ?? [];
    return {
      ...action,
      risk: classifyRisk(action),
      approval: approvalEvidence(action, pendingApprovalsByAction.get(action.id), events),
      connector: connectorEvidence(events),
      audit_events: events,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    selected_agent_id: agentId,
    selected_agent: selectedAgent,
    agents: agentsRes.items,
    active_policy: activePolicy,
    connectors: connectorsRes.items,
    actions,
    audit_events: scopedAuditEvents,
    summary: summarize(actions, connectorsRes.items),
  };
}

export function buildSecurityPacket(evidence: TrustEvidence) {
  return {
    generated_at: evidence.generated_at,
    scope: evidence.selected_agent
      ? {
          type: 'agent',
          agent_id: evidence.selected_agent.id,
          agent_name: evidence.selected_agent.name,
        }
      : { type: 'organization' },
    agent: evidence.selected_agent
      ? {
          ...evidence.selected_agent,
          permission_profile_definition:
            AGENT_PERMISSION_PROFILES[evidence.selected_agent.permission_profile],
        }
      : null,
    active_policy: evidence.active_policy,
    connectors: evidence.connectors.map((connector) => ({
      provider: connector.provider,
      configured: connector.configured,
      enabled: connector.enabled,
      source: connector.source,
      auth_type: connector.auth_type,
      updated_at: connector.updated_at,
      account: connector.account,
    })),
    summary: evidence.summary,
    related_audit_events: evidence.audit_events,
    actions: evidence.actions.map((action) => ({
      action_id: action.id,
      agent_id: action.agent_id,
      agent_name: action.agent_name,
      tool: action.tool,
      params: action.params,
      status: action.status,
      risk: action.risk,
      policy_decision: action.policy_decision,
      approval: action.approval,
      connector: action.connector,
      result: action.result,
      created_at: action.created_at,
      completed_at: action.completed_at,
      audit_events: action.audit_events,
    })),
  };
}

function summarize(
  actions: EvidenceAction[],
  connectors: ConnectorStatus[],
): TrustSummary {
  const status_counts: TrustSummary['status_counts'] = {
    pending: 0,
    awaiting_approval: 0,
    approved: 0,
    denied: 0,
    executed: 0,
    failed: 0,
  };
  const risk_counts: TrustSummary['risk_counts'] = {
    low: 0,
    medium: 0,
    high: 0,
  };
  const approval_counts: TrustSummary['approval_counts'] = {
    required: 0,
    pending: 0,
    approved: 0,
    denied: 0,
    expired: 0,
  };
  const toolCounts = new Map<string, number>();

  for (const action of actions) {
    status_counts[action.status] += 1;
    risk_counts[action.risk.level] += 1;
    toolCounts.set(action.tool, (toolCounts.get(action.tool) ?? 0) + 1);
    if (policyEffect(action) === 'require_approval') {
      approval_counts.required += 1;
    }
    if (action.approval) {
      approval_counts[action.approval.decision] += 1;
    }
  }

  const activeConnectors = connectors
    .filter((connector) => connector.configured && connector.enabled)
    .map((connector) => connector.provider);

  return {
    total_actions: actions.length,
    status_counts,
    risk_counts,
    approval_counts,
    configured_connectors: activeConnectors.length,
    active_connectors: activeConnectors,
    top_tools: [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool, count]) => ({ tool, count })),
  };
}

function groupAuditByAction(events: AuditRow[]): Map<string, AuditRow[]> {
  const out = new Map<string, AuditRow[]>();
  for (const event of events) {
    const actionId = payloadString(event.payload, 'actionId');
    if (!actionId) continue;
    const group = out.get(actionId) ?? [];
    group.push(event);
    out.set(actionId, group);
  }
  return out;
}

function approvalEvidence(
  action: ActionRow,
  pendingApproval: ApprovalRow | undefined,
  events: AuditRow[],
): ApprovalEvidence | null {
  if (policyEffect(action) !== 'require_approval' && !pendingApproval) {
    return null;
  }
  if (pendingApproval) {
    return {
      approval_id: pendingApproval.approval_id,
      decision: 'pending',
      actor_id: null,
      decided_at: null,
      slack_channel: pendingApproval.slack_channel,
    };
  }
  const decision = events.find((event) =>
    ['approval.approved', 'approval.denied', 'approval.expired'].includes(
      event.eventType,
    ),
  );
  if (!decision) {
    return {
      approval_id: null,
      decision:
        action.status === 'denied'
          ? 'denied'
          : action.status === 'executed'
            ? 'approved'
            : 'pending',
      actor_id: null,
      decided_at: action.completed_at,
      slack_channel: null,
    };
  }
  return {
    approval_id: payloadString(decision.payload, 'approvalId'),
    decision:
      decision.eventType === 'approval.approved'
        ? 'approved'
        : decision.eventType === 'approval.expired'
          ? 'expired'
          : 'denied',
    actor_id: decision.actorId,
    decided_at: decision.createdAt,
    slack_channel: null,
  };
}

function connectorEvidence(events: AuditRow[]): string | null {
  for (const event of events) {
    const connector = payloadString(event.payload, 'connector');
    if (connector) return connector;
  }
  return null;
}

export function classifyRisk(action: ActionRow): RiskClassification {
  const tool = action.tool.toLowerCase();
  const params = action.params;

  if (
    tool.includes('.delete') ||
    tool.includes('.export') ||
    tool.includes('bulk') ||
    tool === 'gmail.send' ||
    tool === 'gmail.draft.send'
  ) {
    return { level: 'high', reason: 'external send, bulk/export, or destructive action' };
  }
  if (
    tool.includes('opportunity.') ||
    tool.includes('deals.') ||
    amountValue(params) >= 25_000
  ) {
    return { level: 'high', reason: 'revenue object or high-value deal change' };
  }
  if (
    tool.includes('.create') ||
    tool.includes('.update') ||
    tool.includes('.upsert') ||
    tool.includes('.associate') ||
    tool.includes('.enroll') ||
    tool.includes('tasks.') ||
    tool.includes('notes.')
  ) {
    return { level: 'medium', reason: 'write action with production side effects' };
  }
  return { level: 'low', reason: 'read, search, enrichment, or connectivity action' };
}

function amountValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (Array.isArray(value)) {
    return Math.max(0, ...value.map(amountValue));
  }
  if (typeof value === 'object' && value !== null) {
    return Math.max(0, ...Object.values(value).map(amountValue));
  }
  return 0;
}

function policyEffect(action: ActionRow): string | null {
  const decision = action.policy_decision;
  const effect = decision?.effect;
  return typeof effect === 'string' ? effect : null;
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
