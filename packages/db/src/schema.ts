import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const userRole = pgEnum('user_role', ['admin', 'approver', 'viewer']);
export const agentStatus = pgEnum('agent_status', ['active', 'disabled', 'revoked']);
export const actionStatus = pgEnum('action_status', [
  'pending',
  'awaiting_approval',
  'approved',
  'denied',
  'executed',
  'failed',
]);
export const approvalDecision = pgEnum('approval_decision', [
  'pending',
  'approved',
  'denied',
  'expired',
]);

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name'),
    role: userRole('role').notNull().default('viewer'),
    clerkId: text('clerk_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailOrgIdx: uniqueIndex('users_email_org_idx').on(t.orgId, t.email),
  }),
);

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    status: agentStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    orgIdx: index('agents_org_idx').on(t.orgId),
  }),
);

export const agentApiKeys = pgTable(
  'agent_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull().unique(),
    keyPrefix: text('key_prefix').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    agentIdx: index('agent_api_keys_agent_idx').on(t.agentId),
  }),
);

export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: integer('version').notNull().default(1),
    yaml: text('yaml').notNull(),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => ({
    orgIdx: index('policies_org_idx').on(t.orgId),
    activeIdx: index('policies_active_idx').on(t.orgId, t.isActive),
  }),
);

export const actions = pgTable(
  'actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    tool: text('tool').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    status: actionStatus('status').notNull().default('pending'),
    policyDecision: jsonb('policy_decision').$type<Record<string, unknown>>(),
    result: jsonb('result').$type<Record<string, unknown>>(),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    orgIdx: index('actions_org_idx').on(t.orgId),
    agentIdx: index('actions_agent_idx').on(t.agentId),
    statusIdx: index('actions_status_idx').on(t.status),
    idemIdx: uniqueIndex('actions_idem_idx').on(t.orgId, t.agentId, t.idempotencyKey),
  }),
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actionId: uuid('action_id')
      .notNull()
      .unique()
      .references(() => actions.id, { onDelete: 'cascade' }),
    requiredRole: userRole('required_role').notNull().default('approver'),
    assignedToUserId: uuid('assigned_to_user_id').references(() => users.id),
    decision: approvalDecision('decision').notNull().default('pending'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    slackChannel: text('slack_channel'),
    slackTs: text('slack_ts'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    decisionIdx: index('approvals_decision_idx').on(t.decision),
  }),
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgCreatedIdx: index('audit_log_org_created_idx').on(t.orgId, t.createdAt),
  }),
);

export type Org = typeof orgs.$inferSelect;
export type User = typeof users.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentApiKey = typeof agentApiKeys.$inferSelect;
export type Policy = typeof policies.$inferSelect;
export type Action = typeof actions.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
