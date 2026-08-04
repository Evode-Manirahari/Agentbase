import { sql } from 'drizzle-orm';
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
// Where an action is in the dispatch lifecycle, tracked separately from
// `status` because the two answer different questions. `status` is what the
// gate decided; `dispatch_state` is what we know about the external side
// effect.
//
//   not_dispatched — no connector call has been attempted
//   in_flight      — a connector call is running, or the process died mid-call
//   settled        — the connector returned and the outcome is recorded
//   unknown        — we dispatched but never learned the outcome (crash, timeout).
//                    NEVER auto-retried: the effect may or may not have landed,
//                    and guessing wrong sends the email twice.
export const dispatchState = pgEnum('dispatch_state', [
  'not_dispatched',
  'in_flight',
  'settled',
  'unknown',
]);

// The outcome of ONE dispatch attempt against a provider. Distinct from
// `actions.dispatch_state`, which is the current belief about the action;
// this is the append-only history of what was actually attempted.
//
//   committed   — the provider answered and we hold a receipt
//   failed      — the provider answered with an error; nothing landed
//   indeterminate — we never learned the outcome. The effect may or may not
//                   exist. This is the row that must never be silently retried
export const attemptOutcome = pgEnum('attempt_outcome', [
  'committed',
  'failed',
  'indeterminate',
]);

export const connectorProvider = pgEnum('connector_provider', [
  'hubspot',
  'salesforce',
  'gmail',
  'outreach',
  'apollo',
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
    permissionProfile: text('permission_profile').notNull().default('sales_sdr'),
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
    // sha256 over the canonical (tool, params) pair, computed when the action
    // is created. An approval is bound to this hash: a human approved THIS
    // request, not this row id. If the two ever disagree at dispatch time the
    // commit is refused, so an approved action cannot be dispatched with
    // params other than the ones a human actually read.
    requestHash: text('request_hash'),
    // Deterministic key handed to the PROVIDER (Stripe's Idempotency-Key,
    // GitHub's, etc). Distinct from `idempotencyKey`, which is the caller's
    // key for deduplicating requests to us. This one deduplicates OUR requests
    // to them, which is the only thing that makes a retry safe when we cannot
    // tell whether the first attempt landed.
    providerIdempotencyKey: text('provider_idempotency_key'),
    dispatchState: dispatchState('dispatch_state').notNull().default('not_dispatched'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    orgIdx: index('actions_org_idx').on(t.orgId),
    agentIdx: index('actions_agent_idx').on(t.agentId),
    statusIdx: index('actions_status_idx').on(t.status),
    // Claimed BEFORE the connector is invoked, so it bounds external side
    // effects rather than merely deduplicating the record of them.
    idemIdx: uniqueIndex('actions_idem_idx').on(t.orgId, t.agentId, t.idempotencyKey),
    // Sweeper: find dispatches that never settled.
    inFlightIdx: index('actions_in_flight_idx').on(t.dispatchState, t.dispatchedAt),
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

// Append-only record of every dispatch attempt against a provider, and the
// evidence it produced. This is the artifact that answers "what actually
// happened out there?" after a crash — and the artifact replay serves instead
// of touching the provider again.
//
// One row per ATTEMPT, not per action: an action that was attempted, crashed
// indeterminate, and was later reconciled has two rows telling that story.
export const effectReceipts = pgTable(
  'effect_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actionId: uuid('action_id')
      .notNull()
      .references(() => actions.id, { onDelete: 'cascade' }),
    // 1-based. Unique per action so two concurrent dispatchers cannot both
    // claim the same attempt number — the insert is the claim.
    attempt: integer('attempt').notNull(),
    connectorName: text('connector_name').notNull(),
    // Echoed back so an operator can prove which key was on the wire.
    idempotencyKeySent: text('idempotency_key_sent'),
    outcome: attemptOutcome('outcome').notNull(),
    // The provider's own identifier for the thing that happened, when it gives
    // us one (Stripe charge id, GitHub ref sha, Terraform apply id). This is
    // what makes an effect provable rather than merely logged.
    providerRef: text('provider_ref'),
    // Full recorded response. Replay returns this verbatim.
    receipt: jsonb('receipt').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => ({
    actionIdx: index('effect_receipts_action_idx').on(t.actionId),
    attemptIdx: uniqueIndex('effect_receipts_attempt_idx').on(t.actionId, t.attempt),
    // Operator queue: every attempt whose outcome nobody knows.
    indeterminateIdx: index('effect_receipts_indeterminate_idx')
      .on(t.outcome)
      .where(sql`outcome = 'indeterminate'`),
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

export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    events: jsonb('events').$type<string[]>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    lastDeliveryStatus: text('last_delivery_status'),
  },
  (t) => ({
    orgIdx: index('webhook_subs_org_idx').on(t.orgId),
  }),
);

export interface EncryptedConnectorConfig {
  v: 1;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

export const connectorCredentials = pgTable(
  'connector_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    provider: connectorProvider('provider').notNull(),
    encryptedConfig: jsonb('encrypted_config').$type<EncryptedConnectorConfig>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
  },
  (t) => ({
    orgProviderIdx: uniqueIndex('connector_credentials_org_provider_idx').on(
      t.orgId,
      t.provider,
    ),
    orgIdx: index('connector_credentials_org_idx').on(t.orgId),
  }),
);

export const oauthStates = pgTable(
  'oauth_states',
  {
    nonce: text('nonce').primaryKey(),
    provider: connectorProvider('provider').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresAtIdx: index('oauth_states_expires_at_idx').on(t.expiresAt),
  }),
);

export const agentRunStatus = pgEnum('agent_run_status', [
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
]);

// One agent loop, persisted. The runtime enqueues a worker job for each
// row; the worker drives the LLM + tool loop and updates the row in place
// (status, transcript, conversation messages so resume can pick up where
// the loop left off when a paused tool's approval lands).
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    jobKey: text('job_key').notNull(),
    context: jsonb('context').$type<Record<string, unknown>>().notNull(),
    status: agentRunStatus('status').notNull().default('pending'),
    transcript: jsonb('transcript').$type<unknown[]>().notNull().default([]),
    // LlmMessage[] — the conversation so far. Persisted so a paused run
    // can be resumed without replaying the whole loop.
    messages: jsonb('messages').$type<unknown[]>().notNull().default([]),
    pausedOnActionId: uuid('paused_on_action_id'),
    pausedOnToolUseId: text('paused_on_tool_use_id'),
    pausedOnAgentbaseTool: text('paused_on_agentbase_tool'),
    usage: jsonb('usage').$type<Record<string, number>>(),
    error: text('error'),
    // When a single batch submission fans out into N runs (one per lead),
    // every run in the batch shares this UUID so the dashboard can
    // group them. Null for single-lead runs.
    batchId: uuid('batch_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    orgCreatedIdx: index('agent_runs_org_created_idx').on(t.orgId, t.createdAt),
    pausedOnActionIdx: index('agent_runs_paused_on_action_idx').on(
      t.pausedOnActionId,
    ),
    statusIdx: index('agent_runs_status_idx').on(t.status),
    batchIdx: index('agent_runs_batch_idx').on(t.orgId, t.batchId),
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
export type EffectReceipt = typeof effectReceipts.$inferSelect;
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type ConnectorCredential = typeof connectorCredentials.$inferSelect;
export type OAuthState = typeof oauthStates.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;

// One row per email the agent sent through gmail.send. Tracks the
// Gmail thread + message ids so the reply poller can detect when the
// recipient replies and trigger a handler run.
export const agentEmails = pgTable(
  'agent_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    // The agent run that triggered the send.
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    // The original gmail.send action.
    sendActionId: uuid('send_action_id')
      .notNull()
      .references(() => actions.id, { onDelete: 'cascade' }),
    gmailThreadId: text('gmail_thread_id').notNull(),
    gmailMessageId: text('gmail_message_id').notNull(),
    toEmail: text('to_email').notNull(),
    subject: text('subject'),
    // 1 = original SDR send; 2 = first follow-up; 3 = second follow-up.
    // Drives whether discoverNewSends schedules additional touches —
    // only touch-1 SDR rows fan out, preventing infinite loops on
    // follow-up sends.
    sequenceTouch: integer('sequence_touch').notNull().default(1),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    // Poller bookkeeping. lastPolledAt is null until we've checked at
    // least once.
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    replyReceived: boolean('reply_received').notNull().default(false),
    replyMessageId: text('reply_message_id'),
    replyReceivedAt: timestamp('reply_received_at', { withTimezone: true }),
    // The agent run created to handle the reply (if any).
    replyHandlerRunId: uuid('reply_handler_run_id').references(
      () => agentRuns.id,
      { onDelete: 'set null' },
    ),
  },
  (t) => ({
    threadIdx: uniqueIndex('agent_emails_thread_idx').on(t.gmailThreadId),
    orgRunIdx: index('agent_emails_org_run_idx').on(t.orgId, t.runId),
    needsPollIdx: index('agent_emails_needs_poll_idx').on(
      t.replyReceived,
      t.lastPolledAt,
    ),
  }),
);

export type AgentEmail = typeof agentEmails.$inferSelect;
