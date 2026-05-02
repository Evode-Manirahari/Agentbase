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

export const UserRole = z.enum(['admin', 'approver', 'viewer']);
export type UserRole = z.infer<typeof UserRole>;

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
});
export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequest>;

export const RegisterAgentResponse = z.object({
  agent_id: z.string().uuid(),
  api_key: z.string(),
  api_key_prefix: z.string(),
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

export const PolicyRule = z.object({
  match: z.object({
    tool: z.string().min(1),
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
