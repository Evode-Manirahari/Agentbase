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
  'openclaw_agent',
  'nemoclaw_sandboxed_agent',
  'custom',
]);
export type AgentPermissionProfile = z.infer<typeof AgentPermissionProfile>;

export interface AgentPermissionRuleTemplate {
  tool: string;
  effect: 'allow' | 'require_approval' | 'deny';
  reason: string;
  approver_role?: 'admin' | 'approver' | 'viewer';
  when?: Record<string, Condition>;
  slack_channel?: string;
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
    label: 'Sales Agent',
    description: 'Prospect research, CRM hygiene, sequence enrollment, and approved outbound.',
    summary: 'Research, update leads, enroll prospects, draft/send with approvals',
    rules: [
      allow('apollo.people.match', 'Sales agent can enrich a known person'),
      allow('apollo.people.search', 'Sales agent can search prospects'),
      allow('apollo.organizations.match', 'Sales agent can enrich target accounts'),
      allow('hubspot.connection.test', 'Sales agent can validate HubSpot connectivity'),
      allow('hubspot.contacts.search', 'Sales agent can search contacts'),
      allow('hubspot.contacts.get', 'Sales agent can inspect contact records'),
      allow('hubspot.contacts.create', 'Sales agent can create contacts'),
      allow('hubspot.contacts.update', 'Sales agent can update contact fields'),
      allow('hubspot.contacts.upsert', 'Sales agent can upsert contacts'),
      allow('hubspot.contacts.associate', 'Sales agent can associate contacts'),
      allow('hubspot.deals.get', 'Sales agent can inspect deals'),
      requireApproval('hubspot.deals.create', 'Deal creation needs operator review'),
      requireApproval('hubspot.deals.update', 'Deal updates need operator review'),
      requireApproval('hubspot.deals.associate', 'Deal association needs operator review'),
      requireApproval('hubspot.leads.create_deal', 'Lead-to-deal workflow needs approval'),
      allow('hubspot.notes.create', 'Sales agent can add notes'),
      allow('hubspot.tasks.create', 'Sales agent can create follow-up tasks'),
      allow('salesforce.account.get', 'Sales agent can inspect accounts'),
      allow('salesforce.contact.get', 'Sales agent can inspect contacts'),
      allow('salesforce.contact.create', 'Sales agent can create contacts'),
      allow('salesforce.contact.update', 'Sales agent can update contacts'),
      allow('salesforce.opportunity.get', 'Sales agent can inspect opportunities'),
      requireApproval('salesforce.opportunity.create', 'Opportunity creation needs review'),
      requireApproval('salesforce.opportunity.update', 'Opportunity updates need review'),
      allow('outreach.prospects.get', 'Sales agent can inspect Outreach prospects'),
      allow('outreach.prospects.create', 'Sales agent can create Outreach prospects'),
      allow('outreach.prospects.update', 'Sales agent can update Outreach prospects'),
      allow('outreach.sequences.enroll', 'Sales agent can enroll prospects'),
      allow('outreach.tasks.create', 'Sales agent can create Outreach tasks'),
      allow('gmail.messages.get', 'Sales agent can inspect messages'),
      allow('gmail.draft.create', 'Sales agent can draft email'),
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
  openclaw_agent: {
    key: 'openclaw_agent',
    label: 'OpenClaw Agent',
    description:
      'Chat-triggered autonomous agent governed through MCP with stricter deal and outbound controls.',
    summary: 'Chat-triggered MCP agent, $10k+ deal approval, outbound approval',
    rules: [
      allow('apollo.*', 'OpenClaw can use read-only Apollo enrichment'),
      allow('hubspot.connection.test', 'OpenClaw can validate HubSpot connectivity'),
      allow('hubspot.contacts.search', 'OpenClaw can search contacts'),
      allow('hubspot.contacts.get', 'OpenClaw can inspect contacts'),
      allow('hubspot.contacts.create', 'OpenClaw can create contacts'),
      allow('hubspot.contacts.update', 'OpenClaw can update contact fields'),
      allow('hubspot.contacts.upsert', 'OpenClaw can upsert contacts'),
      allow('hubspot.contacts.associate', 'OpenClaw can associate contacts'),
      allow('hubspot.notes.create', 'OpenClaw can create notes'),
      allow('gmail.draft.create', 'OpenClaw can draft email'),
      requireApproval(
        'gmail.send',
        'OpenClaw external sends need human review',
        { slack_channel: '#critical-approvals' },
      ),
      requireApproval(
        'gmail.draft.send',
        'OpenClaw draft sends need human review',
        { slack_channel: '#critical-approvals' },
      ),
      requireApproval(
        'hubspot.deals.update',
        'OpenClaw deal changes over $10k need review',
        {
          when: { 'properties.amount': { gte: 10000 } },
          slack_channel: '#critical-approvals',
        },
      ),
      allow('hubspot.deals.update', 'OpenClaw can make lower-value deal updates'),
      allow('hubspot.deals.create', 'OpenClaw can create lower-risk deals'),
      allow('hubspot.deals.associate', 'OpenClaw can associate deals'),
      requireApproval(
        'salesforce.opportunity.create',
        'OpenClaw opportunity creation needs review',
      ),
      requireApproval(
        'outreach.sequences.enroll',
        'OpenClaw sequence enrollment needs review',
        { slack_channel: '#critical-approvals' },
      ),
      deny('*.delete', 'OpenClaw cannot autonomously delete records'),
    ],
  },
  nemoclaw_sandboxed_agent: {
    key: 'nemoclaw_sandboxed_agent',
    label: 'NemoClaw Sandboxed Agent',
    description:
      'Agent running inside NVIDIA NemoClaw/OpenShell, with Agentbase governing business actions beneath the sandbox.',
    summary: 'Sandboxed MCP agent, $25k+ deal approval, outbound approval',
    rules: [
      allow('apollo.*', 'Sandboxed agent can use read-only Apollo enrichment'),
      allow('hubspot.connection.test', 'Sandboxed agent can validate HubSpot connectivity'),
      allow('hubspot.contacts.search', 'Sandboxed agent can search contacts'),
      allow('hubspot.contacts.get', 'Sandboxed agent can inspect contacts'),
      allow('hubspot.contacts.create', 'Sandboxed agent can create contacts'),
      allow('hubspot.contacts.update', 'Sandboxed agent can update contact fields'),
      allow('hubspot.contacts.upsert', 'Sandboxed agent can upsert contacts'),
      allow('hubspot.contacts.associate', 'Sandboxed agent can associate contacts'),
      allow('hubspot.notes.create', 'Sandboxed agent can create notes'),
      allow('gmail.draft.create', 'Sandboxed agent can draft email'),
      requireApproval(
        'gmail.send',
        'Sandboxed agent external sends need human review',
        { slack_channel: '#critical-approvals' },
      ),
      requireApproval(
        'gmail.draft.send',
        'Sandboxed agent draft sends need human review',
        { slack_channel: '#critical-approvals' },
      ),
      requireApproval(
        'hubspot.deals.update',
        'Sandboxed agent deal changes over $25k need review',
        {
          when: { 'properties.amount': { gte: 25000 } },
          slack_channel: '#critical-approvals',
        },
      ),
      allow('hubspot.deals.update', 'Sandboxed agent can make lower-value deal updates'),
      allow('hubspot.deals.create', 'Sandboxed agent can create lower-risk deals'),
      allow('hubspot.deals.associate', 'Sandboxed agent can associate deals'),
      requireApproval(
        'salesforce.opportunity.create',
        'Sandboxed agent opportunity creation needs review',
      ),
      requireApproval(
        'outreach.sequences.enroll',
        'Sandboxed agent sequence enrollment needs review',
        { slack_channel: '#critical-approvals' },
      ),
      deny('*.delete', 'Sandboxed agent cannot autonomously delete records'),
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

// Mirrors @agentbase/effects' EffectClass. Duplicated rather than imported so
// the policy schema — which customers write against — does not depend on the
// classifier package. The two are kept in step by a test.
export const EffectClassName = z.enum([
  'read',
  'workspace_write',
  'vcs_write',
  'deploy',
  'publish',
  'infra_write',
  'egress',
  'external_comms',
  'unknown',
]);
export type EffectClassName = z.infer<typeof EffectClassName>;

export const PolicyRule = z.object({
  match: z.object({
    tool: z.string().min(1),
    agent_id: z.string().uuid().optional(),
    agent_name: z.string().min(1).optional(),
    agent_profile: AgentPermissionProfile.optional(),
    // Match on what the action WILL DO rather than what it is called. Lets a
    // policy say "anything that publishes needs approval" once, instead of
    // enumerating every tool and command that might publish — and the list of
    // things that publish is exactly the list nobody can keep current by hand.
    effect_class: z
      .union([EffectClassName, z.array(EffectClassName).min(1)])
      .optional(),
    // The single most useful rule in the language:
    //   - match: { tool: "*", reversible: false }
    //     effect: require_approval
    reversible: z.boolean().optional(),
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
      if (rule.when) {
        lines.push(
          '  - match:',
          `      tool: ${quoteYaml(rule.tool)}`,
          `      agent_profile: ${profile.key}`,
          '      when:',
        );
        for (const [path, cond] of Object.entries(rule.when)) {
          lines.push(`        ${path}: ${formatConditionYaml(cond)}`);
        }
      } else {
        lines.push(
          `  - match: { tool: ${quoteYaml(rule.tool)}, agent_profile: ${profile.key} }`,
        );
      }
      lines.push(
        `    effect: ${rule.effect}`,
        `    reason: ${quoteYaml(`${profile.label}: ${rule.reason}`)}`,
      );
      if (rule.approver_role) {
        lines.push(`    approver_role: ${rule.approver_role}`);
      }
      if (rule.slack_channel) {
        lines.push(`    slack_channel: ${quoteYaml(rule.slack_channel)}`);
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

export const APPROVAL_BULK_DECIDE_MAX = 50;

export const BulkApprovalDecisionRequest = z.object({
  approval_ids: z.array(z.string().uuid()).min(1).max(APPROVAL_BULK_DECIDE_MAX),
  decision: ApprovalDecisionAction,
  decided_by_email: z.string().email().optional(),
  notes: z.string().max(1000).optional(),
});
export type BulkApprovalDecisionRequest = z.infer<
  typeof BulkApprovalDecisionRequest
>;

// Per-id outcome for bulk decide. Mirrors ApprovalDecisionResponse on
// success and surfaces a structured error otherwise. One failure
// doesn't block the rest — operators get a row-by-row picture.
export const BulkApprovalDecisionItem = z.union([
  z.object({
    approval_id: z.string().uuid(),
    outcome: z.literal('decided'),
    decision: ApprovalDecision,
    action_id: z.string().uuid(),
    action_status: ActionStatus,
    result: z.unknown().nullable(),
  }),
  z.object({
    approval_id: z.string().uuid(),
    outcome: z.literal('skipped_already_decided'),
    decision: ApprovalDecision,
  }),
  z.object({
    approval_id: z.string().uuid(),
    outcome: z.literal('failed'),
    error: z.object({
      code: z.string(),
      message: z.string(),
    }),
  }),
]);
export type BulkApprovalDecisionItem = z.infer<
  typeof BulkApprovalDecisionItem
>;

export const BulkApprovalDecisionResponse = z.object({
  items: z.array(BulkApprovalDecisionItem),
  summary: z.object({
    decided: z.number().int().nonnegative(),
    skipped_already_decided: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});
export type BulkApprovalDecisionResponse = z.infer<
  typeof BulkApprovalDecisionResponse
>;

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

export type PolicyTemplateKey =
  | 'approval-before-external-email'
  | 'approval-before-high-value-crm-write'
  | 'deny-destructive-and-bulk';

export interface PolicyTemplate {
  key: PolicyTemplateKey;
  label: string;
  description: string;
  rules: PolicyRule[];
}

export const POLICY_TEMPLATES: readonly PolicyTemplate[] = [
  {
    key: 'approval-before-external-email',
    label: 'Require approval before external email',
    description:
      'Drafts execute freely. Sending real email pauses for human sign-off via Slack.',
    rules: [
      {
        match: { tool: 'gmail.draft.create' },
        effect: 'allow',
        reason: 'drafts never leave the outbox without a human',
      },
      {
        match: { tool: 'gmail.send' },
        effect: 'require_approval',
        approver_role: 'approver',
        reason: 'outbound email needs human sign-off',
        slack_channel: '#agent-approvals',
      },
      {
        match: { tool: 'gmail.draft.send' },
        effect: 'require_approval',
        approver_role: 'approver',
        reason: 'sending a saved draft still needs sign-off',
        slack_channel: '#agent-approvals',
      },
    ],
  },
  {
    key: 'approval-before-high-value-crm-write',
    label: 'Require approval on CRM writes over $10,000',
    description:
      'Routine deal updates auto-execute. HubSpot and Salesforce writes with amount >= $10,000 pause for approval.',
    rules: [
      {
        match: {
          tool: 'hubspot.deals.update',
          when: { 'properties.amount': { gte: 10000 } },
        },
        effect: 'require_approval',
        approver_role: 'approver',
        reason: 'high-value HubSpot deal change',
        slack_channel: '#critical-approvals',
      },
      {
        match: { tool: 'hubspot.deals.update' },
        effect: 'allow',
        reason: 'routine HubSpot deal update below high-value threshold',
      },
      {
        match: {
          tool: 'hubspot.deals.create',
          when: { 'properties.amount': { gte: 10000 } },
        },
        effect: 'require_approval',
        approver_role: 'approver',
        reason: 'high-value HubSpot deal creation',
        slack_channel: '#critical-approvals',
      },
      {
        match: { tool: 'hubspot.deals.create' },
        effect: 'allow',
        reason: 'routine HubSpot deal creation below high-value threshold',
      },
      {
        match: {
          tool: 'hubspot.leads.create_deal',
          when: { 'deal.amount': { gte: 10000 } },
        },
        effect: 'require_approval',
        approver_role: 'approver',
        reason: 'high-value lead-to-deal workflow',
        slack_channel: '#critical-approvals',
      },
      {
        match: { tool: 'hubspot.leads.create_deal' },
        effect: 'allow',
        reason: 'routine lead-to-deal workflow below high-value threshold',
      },
      {
        match: {
          tool: 'salesforce.opportunity.update',
          when: { 'fields.Amount': { gte: 10000 } },
        },
        effect: 'require_approval',
        approver_role: 'approver',
        reason: 'high-value Salesforce opportunity change',
        slack_channel: '#critical-approvals',
      },
      {
        match: { tool: 'salesforce.opportunity.update' },
        effect: 'allow',
        reason: 'routine Salesforce opportunity update below high-value threshold',
      },
      {
        match: {
          tool: 'salesforce.opportunity.create',
          when: { 'fields.Amount': { gte: 10000 } },
        },
        effect: 'require_approval',
        approver_role: 'approver',
        reason: 'high-value Salesforce opportunity creation',
        slack_channel: '#critical-approvals',
      },
      {
        match: { tool: 'salesforce.opportunity.create' },
        effect: 'allow',
        reason: 'routine Salesforce opportunity creation below high-value threshold',
      },
    ],
  },
  {
    key: 'deny-destructive-and-bulk',
    label: 'Deny delete, export, and bulk actions',
    description:
      'Hard stops for destructive or wide-blast-radius operations across every connector.',
    rules: [
      {
        match: { tool: '*.delete' },
        effect: 'deny',
        reason: 'destructive deletes are blocked',
      },
      {
        match: { tool: '*.export' },
        effect: 'deny',
        reason: 'bulk exports are blocked',
      },
      {
        match: { tool: '*.bulk' },
        effect: 'deny',
        reason: 'bulk operations are blocked',
      },
      {
        match: { tool: '*.bulk_*' },
        effect: 'deny',
        reason: 'bulk operations are blocked',
      },
    ],
  },
];

export function policyTemplateRulesYaml(template: PolicyTemplate): string {
  const lines: string[] = [`# ${template.label}`, `# ${template.description}`];
  for (const rule of template.rules) {
    lines.push('  - match:');
    lines.push(`      tool: ${quoteYaml(rule.match.tool)}`);
    if (rule.match.when) {
      lines.push('      when:');
      for (const [path, cond] of Object.entries(rule.match.when)) {
        lines.push(`        ${path}: ${formatConditionYaml(cond)}`);
      }
    }
    lines.push(`    effect: ${rule.effect}`);
    if (rule.approver_role) {
      lines.push(`    approver_role: ${rule.approver_role}`);
    }
    if (rule.reason) {
      lines.push(`    reason: ${quoteYaml(rule.reason)}`);
    }
    if (rule.slack_channel) {
      lines.push(`    slack_channel: ${quoteYaml(rule.slack_channel)}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function policyTemplateStandaloneYaml(template: PolicyTemplate): string {
  return (
    `version: 1\n` +
    `default: deny\n` +
    `rules:\n` +
    policyTemplateRulesYaml(template)
      .split('\n')
      .filter((line) => !line.startsWith('#'))
      .join('\n')
  );
}

function formatConditionYaml(cond: Condition): string {
  if (cond === null) return 'null';
  if (typeof cond === 'string') return quoteYaml(cond);
  if (typeof cond === 'number' || typeof cond === 'boolean') return String(cond);
  const entries = Object.entries(cond as Record<string, unknown>);
  const [op, value] = entries[0] ?? [];
  if (!op) return '{}';
  return `{ ${op}: ${formatConditionValue(value)} }`;
}

function formatConditionValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return quoteYaml(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => formatConditionValue(v)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{ ${entries
      .map(([key, nested]) => `${quoteYaml(key)}: ${formatConditionValue(nested)}`)
      .join(', ')} }`;
  }
  return quoteYaml(String(value));
}

function allow(tool: string, reason: string): AgentPermissionRuleTemplate {
  return { tool, effect: 'allow', reason };
}

function requireApproval(
  tool: string,
  reason: string,
  opts: {
    when?: Record<string, Condition>;
    slack_channel?: string;
  } = {},
): AgentPermissionRuleTemplate {
  return {
    tool,
    effect: 'require_approval',
    reason,
    approver_role: 'approver',
    ...opts,
  };
}

function deny(tool: string, reason: string): AgentPermissionRuleTemplate {
  return { tool, effect: 'deny', reason };
}

function quoteYaml(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
