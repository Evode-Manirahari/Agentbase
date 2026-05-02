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

export const PolicyRule = z.object({
  match: z.object({
    tool: z.string(),
    when: z.record(z.unknown()).optional(),
  }),
  effect: z.enum(['allow', 'require_approval', 'deny']),
  approver_role: UserRole.optional(),
  reason: z.string().optional(),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

export const PolicyDocument = z.object({
  version: z.literal(1),
  rules: z.array(PolicyRule),
  default: z.enum(['allow', 'deny']).default('deny'),
});
export type PolicyDocument = z.infer<typeof PolicyDocument>;
