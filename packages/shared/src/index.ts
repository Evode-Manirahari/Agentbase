import { z } from 'zod';

export const ActionStatus = z.enum([
  'pending',
  'awaiting_approval',
  'approved',
  'denied',
  'executed',
  'failed',
]);
export type ActionStatus = z.infer<typeof ActionStatus>;

export const ApprovalDecision = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const AgentStatus = z.enum(['active', 'disabled', 'revoked']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentPermissionProfile = z.enum([
  'sales_sdr',
  'revops_admin',
  'support_agent',
  'read_only_analyst',
  'custom',
]);
export type AgentPermissionProfile = z.infer<typeof AgentPermissionProfile>;

export interface AgentPermissionRuleTemplate {
  tool: string;
  effect: 'allow' | 'require_approval' | 'deny';
  reason: string;
  approver_role?: 'admin' | 'approver' | 'viewer';
}

export interface AgentPermissionProfileDefinition {
  key: AgentPermissionProfile;
  label: string;
  description: string;
  summary: string;
  rules: AgentPermissionRuleTemplate[];
}

export const UserRole = z.enum(['admin', 'approver', 'viewer']);
export type UserRole = z.infer<typeof UserRole>;

export const ConnectorProvider = z.enum([
  'hubspot',
  'salesforce',
  'gmail',
  'outreach',
  'apollo',
]);
export type ConnectorProvider = z.infer<typeof ConnectorProvider>;

export const ConnectorCredentialRequest = z.object({
  credentials: z.record(z.string().min(1)),
});
export type ConnectorCredentialRequest = z.infer<typeof ConnectorCredentialRequest>;

export const ExecuteActionRequest = z.object({
  tool: z.string().min(1),
  params: z.record(z.unknown()),
  idempotency_key: z.string().optional(),
});
export type ExecuteActionRequest = z.infer<typeof ExecuteActionRequest>;

export const ExecuteActionResponse = z.object({
  action_id: z.string().uuid(),
  status: ActionStatus,
  result: z.unknown().optional(),
  policy_decision: z.unknown().optional(),
});
export type ExecuteActionResponse = z.infer<typeof ExecuteActionResponse>;

export const RegisterAgentRequest = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  permission_profile: AgentPermissionProfile.default('sales_sdr'),
});
export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequest>;

export const RegisterAgentResponse = z.object({
  agent_id: z.string().uuid(),
  api_key: z.string(),
  api_key_prefix: z.string(),
  permission_profile: AgentPermissionProfile,
});
export type RegisterAgentResponse = z.infer<typeof RegisterAgentResponse>;

export const ConditionOperator = z.union([
  z.object({ eq: z.unknown() }).strict(),
  z.object({ neq: z.unknown() }).strict(),
  z.object({ gt: z.number() }).strict(),
  z.object({ gte: z.number() }).strict(),
  z.object({ lt: z.number() }).strict(),
  z.object({ lte: z.number() }).strict(),
  z.object({ in: z.array(z.unknown()).min(1) }).strict(),
  z.object({ contains: z.unknown() }).strict(),
  z.object({ exists: z.boolean() }).strict(),
]);
export type ConditionOperator = z.infer<typeof ConditionOperator>;

export const Condition = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  ConditionOperator,
]);
export type Condition = z.infer<typeof Condition>;

export const PolicyEffect = z.enum(['allow', 'require_approval', 'deny']);
export type PolicyEffect = z.infer<typeof PolicyEffect>;

export const AGENT_PERMISSION_PROFILES: Record<
  AgentPermissionProfile,
  AgentPermissionProfileDefinition
> = {
  sales_sdr: {
    key: 'sales_sdr',
    label: 'Sales SDR',
    description: 'Prospect research, CRM hygiene, sequence enrollment, and approved outbound.',
    summary: 'Research, update leads, enroll prospects, draft/send with approvals',
    rules: [
      allow('apollo.people.match', 'SDR can enrich a known person'),
      allow('apollo.people.search', 'SDR can search prospects'),
      allow('apollo.organizations.match', 'SDR can enrich target accounts'),
      allow('hubspot.connection.test', 'SDR can validate HubSpot connectivity'),
      allow('hubspot.contacts.search', 'SDR can search contacts'),
      allow('hubspot.contacts.get', 'SDR can inspect contact records'),
      allow('hubspot.contacts.create', 'SDR can create contacts'),
      allow('hubspot.contacts.update', 'SDR can update contact fields'),
      allow('hubspot.contacts.upsert', 'SDR can upsert contacts'),
      allow('hubspot.contacts.associate', 'SDR can associate contacts'),
      allow('hubspot.deals.get', 'SDR can inspect deals'),
      requireApproval('hubspot.deals.create', 'Deal creation needs operator review'),
      requireApproval('hubspot.deals.update', 'Deal updates need operator review'),
      requireApproval('hubspot.deals.associate', 'Deal association needs operator review'),
      requireApproval('hubspot.leads.create_deal', 'Lead-to-deal workflow needs approval'),
      allow('hubspot.notes.create', 'SDR can add notes'),
      allow('hubspot.tasks.create', 'SDR can create follow-up tasks'),
      allow('salesforce.account.get', 'SDR can inspect accounts'),
      allow('salesforce.contact.get', 'SDR can inspect contacts'),
      allow('salesforce.contact.create', 'SDR can create contacts'),
      allow('salesforce.contact.update', 'SDR can update contacts'),
      allow('salesforce.opportunity.get', 'SDR can inspect opportunities'),
      requireApproval('salesforce.opportunity.create', 'Opportunity creation needs review'),
      requireApproval('salesforce.opportunity.update', 'Opportunity updates need review'),
      allow('outreach.prospects.get', 'SDR can inspect Outreach prospects'),
      allow('outreach.prospects.create', 'SDR can create Outreach prospects'),
      allow('outreach.prospects.update', 'SDR can update Outreach prospects'),
      allow('outreach.sequences.enroll', 'SDR can enroll prospects'),
      allow('outreach.tasks.create', 'SDR can create Outreach tasks'),
      allow('gmail.messages.get', 'SDR can inspect messages'),
      allow('gmail.draft.create', 'SDR can draft email'),
      requireApproval('gmail.send', 'Outbound email needs approval'),
      requireApproval('gmail.draft.send', 'Sending drafts needs approval'),
    ],
  },
  revops_admin: {
    key: 'revops_admin',
    label: 'RevOps Admin',
    description: 'Broad CRM and sequencing control with approval on outbound email.',
    summary: 'Broad GTM writes, enrichment, sequencing, approved outbound email',
    rules: [
      allow('hubspot.*', 'RevOps can administer HubSpot GTM objects'),
      allow('salesforce.*', 'RevOps can administer Salesforce GTM objects'),
      allow('outreach.*', 'RevOps can administer Outreach workflows'),
      allow('apollo.*', 'RevOps can use Apollo enrichment'),
      allow('gmail.messages.get', 'RevOps can inspect messages'),
      allow('gmail.draft.create', 'RevOps can draft email'),
      requireApproval('gmail.send', 'Outbound email still needs approval'),
      requireApproval('gmail.draft.send', 'Sending drafts still needs approval'),
    ],
  },
  support_agent: {
    key: 'support_agent',
    label: 'Support Agent',
    description: 'Read customer context and create notes/tasks without revenue-stage writes.',
    summary: 'Read CRM context, add notes/tasks, draft replies with approval',
    rules: [
      allow('hubspot.connection.test', 'Support can validate HubSpot connectivity'),
      allow('hubspot.contacts.search', 'Support can search contacts'),
      allow('hubspot.contacts.get', 'Support can inspect contacts'),
      allow('hubspot.deals.get', 'Support can inspect deal context'),
      allow('hubspot.notes.create', 'Support can add notes'),
      allow('hubspot.tasks.create', 'Support can create follow-up tasks'),
      allow('salesforce.account.get', 'Support can inspect account context'),
      allow('salesforce.contact.get', 'Support can inspect contact context'),
      allow('salesforce.opportunity.get', 'Support can inspect opportunity context'),
      allow('outreach.prospects.get', 'Support can inspect Outreach prospects'),
      allow('gmail.messages.get', 'Support can inspect messages'),
      requireApproval('gmail.draft.create', 'Support reply drafts need review'),
      requireApproval('gmail.send', 'Support outbound email needs approval'),
      requireApproval('gmail.draft.send', 'Sending support drafts needs approval'),
    ],
  },
  read_only_analyst: {
    key: 'read_only_analyst',
    label: 'Read-only Analyst',
    description: 'Read and enrich GTM data without side effects.',
    summary: 'Read/search only across CRM, email, Outreach, and enrichment',
    rules: [
      allow('apollo.people.match', 'Analyst can enrich known people'),
      allow('apollo.people.search', 'Analyst can search people'),
      allow('apollo.organizations.match', 'Analyst can enrich accounts'),
      allow('hubspot.connection.test', 'Analyst can validate HubSpot connectivity'),
      allow('hubspot.contacts.search', 'Analyst can search contacts'),
      allow('hubspot.contacts.get', 'Analyst can inspect contacts'),
      allow('hubspot.deals.get', 'Analyst can inspect deals'),
      allow('salesforce.account.get', 'Analyst can inspect accounts'),
      allow('salesforce.contact.get', 'Analyst can inspect contacts'),
      allow('salesforce.opportunity.get', 'Analyst can inspect opportunities'),
      allow('outreach.prospects.get', 'Analyst can inspect Outreach prospects'),
      allow('gmail.messages.get', 'Analyst can inspect messages'),
    ],
  },
  custom: {
    key: 'custom',
    label: 'Custom',
    description: 'Managed by hand-written policy YAML.',
    summary: 'Manual policy rules only',
    rules: [],
  },
};

export const AGENT_PERMISSION_PROFILE_OPTIONS = AgentPermissionProfile.options.map(
  (key) => AGENT_PERMISSION_PROFILES[key],
);

export const PolicyRule = z.object({
  match: z.object({
    tool: z.string().min(1),
    agent_id: z.string().uuid().optional(),
    agent_name: z.string().min(1).optional(),
    agent_profile: AgentPermissionProfile.optional(),
    when: z.record(Condition).optional(),
  }),
  effect: PolicyEffect,
  approver_role: UserRole.optional(),
  reason: z.string().optional(),
  slack_channel: z.string().min(1).optional(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const PolicyDocument = z.object({
  version: z.literal(1),
  default: z.enum(['allow', 'deny']).default('deny'),
  rules: z.array(PolicyRule).default([]),
});
export type PolicyDocument = z.infer<typeof PolicyDocument>;

export const PolicyDecision = z.object({
  effect: PolicyEffect,
  reason: z.string().nullable(),
  rule_index: z.number().int().nullable(),
  rule_matched: PolicyRule.nullable(),
  approver_role: UserRole.nullable(),
  policy_id: z.string().uuid().nullable(),
  fallback: z.boolean(),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const SetActivePolicyRequest = z.object({
  name: z.string().min(1).max(120).default('default'),
  yaml: z.string().min(1),
});
export type SetActivePolicyRequest = z.infer<typeof SetActivePolicyRequest>;

export function buildAgentPermissionProfilePolicyYaml(): string {
  const lines = [
    'version: 1',
    'default: deny',
    'rules:',
  ];
  for (const profile of AGENT_PERMISSION_PROFILE_OPTIONS) {
    if (profile.key === 'custom') continue;
    for (const rule of profile.rules) {
      lines.push(
        `  - match: { tool: ${quoteYaml(rule.tool)}, agent_profile: ${profile.key} }`,
        `    effect: ${rule.effect}`,
        `    reason: ${quoteYaml(`${profile.label}: ${rule.reason}`)}`,
      );
      if (rule.approver_role) {
        lines.push(`    approver_role: ${rule.approver_role}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export const ActivePolicyResponse = z.object({
  policy_id: z.string().uuid().nullable(),
  name: z.string().nullable(),
  version: z.number().int().nullable(),
  yaml: z.string().nullable(),
  document: PolicyDocument.nullable(),
  is_fallback: z.boolean(),
});
export type ActivePolicyResponse = z.infer<typeof ActivePolicyResponse>;

export const ApprovalDecisionAction = z.enum(['approve', 'deny']);
export type ApprovalDecisionAction = z.infer<typeof ApprovalDecisionAction>;

export const ApprovalDecisionRequest = z.object({
  decision: ApprovalDecisionAction,
  decided_by_email: z.string().email().optional(),
  notes: z.string().max(1000).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequest>;

export const ApprovalView = z.object({
  approval_id: z.string().uuid(),
  action_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  agent_name: z.string(),
  tool: z.string(),
  params: z.record(z.unknown()),
  policy_decision: PolicyDecision.nullable(),
  required_role: UserRole,
  decision: ApprovalDecision,
  expires_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  decided_at: z.string().datetime().nullable(),
  decided_by_email: z.string().email().nullable(),
  slack_channel: z.string().nullable(),
  slack_ts: z.string().nullable(),
});
export type ApprovalView = z.infer<typeof ApprovalView>;

export const ApprovalListResponse = z.object({
  items: z.array(ApprovalView),
});
export type ApprovalListResponse = z.infer<typeof ApprovalListResponse>;

export const ApprovalDecisionResponse = z.object({
  approval_id: z.string().uuid(),
  decision: ApprovalDecision,
  action_id: z.string().uuid(),
  action_status: ActionStatus,
  result: z.unknown().nullable(),
});
export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponse>;

function allow(tool: string, reason: string): AgentPermissionRuleTemplate {
  return { tool, effect: 'allow', reason };
}

function requireApproval(
  tool: string,
  reason: string,
): AgentPermissionRuleTemplate {
  return { tool, effect: 'require_approval', reason, approver_role: 'approver' };
}

function quoteYaml(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
