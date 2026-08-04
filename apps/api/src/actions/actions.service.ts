import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Action, Database } from '@agentbase/db';
import { actions, agents, approvals } from '@agentbase/db';
import { AuditService } from '../audit/audit.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { ConnectorRegistry } from '../connectors/connector-registry.js';
import { SlackService } from '../slack/slack.service.js';
import { RateLimitService } from './rate-limit.service.js';
import type { Connector, ConnectorResult } from '@agentbase/connector-hubspot';
import type { ActionStatus, PolicyDecision } from '@agentbase/shared';

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExecuteInput {
  orgId: string;
  agentId: string;
  tool: string;
  params: Record<string, unknown>;
  idempotencyKey?: string | undefined;
}

export interface ExecuteOutput {
  action_id: string;
  status: ActionStatus;
  result?: Record<string, unknown> | undefined;
  policy_decision: PolicyDecision;
}

@Injectable()
export class ActionsService {
  private readonly log = new Logger(ActionsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly connectors: ConnectorRegistry,
    private readonly slack: SlackService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async execute(input: ExecuteInput): Promise<ExecuteOutput> {
    // Idempotency fast path: if this (org, agent, key) tuple was already
    // processed, return the stored outcome instead of re-evaluating policy and
    // re-calling the connector. This read is an optimisation, not the
    // guarantee — the guarantee is the reservation in reserveAction(), which
    // claims the key before the connector is invoked. Idempotent replays
    // bypass the rate limiter: the original request already paid the cost.
    if (input.idempotencyKey) {
      const cached = await this.findByIdempotencyKey(
        input.orgId,
        input.agentId,
        input.idempotencyKey,
      );
      if (cached) {
        this.log.debug(
          `idempotency hit org=${input.orgId} agent=${input.agentId} key=${input.idempotencyKey}`,
        );
        return cached;
      }
    }

    // Rate limit gate: block runaway agents before they reach the connector.
    const rl = await this.rateLimit.check({
      orgId: input.orgId,
      agentId: input.agentId,
      tool: input.tool,
    });
    if (!rl.ok) {
      const decision: PolicyDecision = {
        effect: 'allow',
        reason: null,
        rule_index: null,
        rule_matched: null,
        approver_role: null,
        policy_id: null,
        fallback: false,
      };
      const storedResult = {
        ok: false,
        error: {
          code: 'rate_limited',
          message: `${rl.scope}-scope limit of ${rl.limit}/min exceeded`,
          retry_after_sec: rl.retry_after_sec,
          scope: rl.scope,
        },
      };
      const recorded = await this.recordAction(
        input,
        'failed',
        decision,
        storedResult,
      );
      if (recorded.conflict) return recorded.conflict;
      const action = recorded.action;
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'agent',
        actorId: input.agentId,
        eventType: 'action.rate_limited',
        payload: {
          actionId: action.id,
          tool: input.tool,
          scope: rl.scope,
          limit: rl.limit,
        },
      });
      return {
        action_id: action.id,
        status: 'failed',
        result: storedResult,
        policy_decision: decision,
      };
    }

    const decision = await this.policy.evaluate(input.orgId, {
      tool: input.tool,
      params: input.params,
      agentId: input.agentId,
    });

    if (decision.effect === 'deny') {
      const recorded = await this.recordAction(input, 'denied', decision, null);
      if (recorded.conflict) return recorded.conflict;
      const action = recorded.action;
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'agent',
        actorId: input.agentId,
        eventType: 'action.denied',
        payload: { actionId: action.id, tool: input.tool, decision },
      });
      return { action_id: action.id, status: 'denied', policy_decision: decision };
    }

    if (decision.effect === 'require_approval') {
      const recorded = await this.recordAction(
        input,
        'awaiting_approval',
        decision,
        null,
      );
      // Losing the key race here is the case that used to double-post: the
      // winner already has an approval row and a Slack card for this action.
      if (recorded.conflict) return recorded.conflict;
      const action = recorded.action;
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
      const [approval] = await this.db
        .insert(approvals)
        .values({
          actionId: action.id,
          requiredRole: decision.approver_role ?? 'approver',
          decision: 'pending',
          expiresAt,
        })
        .returning();
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'agent',
        actorId: input.agentId,
        eventType: 'action.awaiting_approval',
        payload: { actionId: action.id, tool: input.tool, decision },
      });

      if (approval && this.slack.isConfigured()) {
        const agentName = await this.lookupAgentName(input.agentId);
        const channelOverride = decision.rule_matched?.slack_channel ?? null;
        const card = await this.slack.postApprovalCard({
          approvalId: approval.id,
          agentName,
          tool: input.tool,
          params: input.params,
          reason: decision.reason ?? null,
          expiresAt,
          channelOverride,
        });
        if (card) {
          await this.db
            .update(approvals)
            .set({ slackChannel: card.channel, slackTs: card.ts })
            .where(eq(approvals.id, approval.id));
          await this.audit.record({
            orgId: input.orgId,
            actorType: 'system',
            actorId: 'slack',
            eventType: 'approval.posted_to_slack',
            payload: {
              approvalId: approval.id,
              actionId: action.id,
              channel: card.channel,
              channel_override_used: channelOverride,
              ts: card.ts,
            },
          });
        }
      }

      return {
        action_id: action.id,
        status: 'awaiting_approval',
        policy_decision: decision,
      };
    }

    // effect === 'allow' — dispatch to a connector.
    //
    // Reserve first, invoke second. The row (and with it the unique
    // idempotency key) is claimed BEFORE any external call, so a concurrent
    // request carrying the same key loses the race at the database and never
    // reaches the connector. Claiming it afterwards — which is what this code
    // used to do — deduplicates the record of the send but not the send.
    const reservation = await this.reserveAction(input, decision);
    if (reservation.conflict) {
      this.log.debug(
        `idempotency reservation lost org=${input.orgId} agent=${input.agentId} key=${input.idempotencyKey} — no connector call made`,
      );
      return reservation.conflict;
    }
    // The reservation already persisted `in_flight` + `dispatchedAt`. If the
    // process dies anywhere below, the sweeper promotes the row to `unknown`
    // rather than retrying it — see reconcileStaleDispatches().
    const action = reservation.action;

    const connector = await this.resolveConnector(input.orgId, input.tool);
    let result: ConnectorResult;
    if (!connector) {
      result = {
        ok: false,
        error: {
          code: 'no_connector',
          message: `no connector resolves tool ${input.tool}`,
        },
      };
    } else {
      result = await connector.invoke(input.tool, input.params);
    }

    const finalStatus: ActionStatus = result.ok ? 'executed' : 'failed';
    const storedResult = result.ok
      ? { ok: true, data: result.data ?? null }
      : { ok: false, error: result.error ?? { code: 'unknown', message: 'unknown error' } };

    await this.db
      .update(actions)
      .set({
        status: finalStatus,
        result: storedResult,
        dispatchState: 'settled',
        completedAt: new Date(),
      })
      .where(eq(actions.id, action.id));

    await this.audit.record({
      orgId: input.orgId,
      actorType: 'agent',
      actorId: input.agentId,
      eventType: result.ok ? 'action.executed' : 'action.failed',
      payload: {
        actionId: action.id,
        tool: input.tool,
        decision,
        connector: connector?.name ?? null,
        ok: result.ok,
        error: result.ok ? null : result.error ?? null,
      },
    });

    return {
      action_id: action.id,
      status: finalStatus,
      result: storedResult,
      policy_decision: decision,
    };
  }

  // Operator-initiated retry of a previously-failed action. Re-uses the stored
  // policy decision (operators are explicitly vouching for the retry; if they
  // wanted re-evaluation they'd change the policy first). Re-checks the rate
  // limit so retries can't bypass throttling. Updates the row in place — the
  // audit log is the history of attempts, the action row is the current state.
  async retry(input: {
    orgId: string;
    actionId: string;
    operatorId: string;
  }): Promise<ExecuteOutput> {
    const [original] = await this.db
      .select()
      .from(actions)
      .where(
        and(eq(actions.id, input.actionId), eq(actions.orgId, input.orgId)),
      )
      .limit(1);
    if (!original) {
      throw new NotFoundException(`action ${input.actionId} not found`);
    }
    if (original.status !== 'failed') {
      throw new ConflictException(
        `cannot retry action with status='${original.status}' — only 'failed' is retryable`,
      );
    }
    const decision =
      (original.policyDecision as unknown as PolicyDecision | null) ?? null;
    if (!decision || decision.effect !== 'allow') {
      throw new ConflictException(
        `cannot retry: original policy decision was '${decision?.effect ?? 'null'}' — change the policy and have the agent re-attempt`,
      );
    }

    const rl = await this.rateLimit.check({
      orgId: input.orgId,
      agentId: original.agentId,
      tool: original.tool,
    });
    if (!rl.ok) {
      const errorResult = {
        ok: false,
        error: {
          code: 'rate_limited',
          message: `${rl.scope}-scope limit of ${rl.limit}/min exceeded`,
          retry_after_sec: rl.retry_after_sec,
          scope: rl.scope,
        },
      };
      await this.db
        .update(actions)
        .set({ result: errorResult, completedAt: new Date() })
        .where(eq(actions.id, input.actionId));
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'user',
        actorId: input.operatorId,
        eventType: 'action.retried_rate_limited',
        payload: {
          actionId: input.actionId,
          tool: original.tool,
          scope: rl.scope,
          limit: rl.limit,
        },
      });
      return {
        action_id: input.actionId,
        status: 'failed',
        result: errorResult,
        policy_decision: decision,
      };
    }

    // Claim the retry before dispatching. Two operators clicking Retry on the
    // same failed action must produce one connector call, not two — the
    // conditional update is the claim, and losing it means someone else is
    // already in flight.
    const claimed = await this.db
      .update(actions)
      .set({ dispatchState: 'in_flight', dispatchedAt: new Date() })
      .where(
        and(
          eq(actions.id, input.actionId),
          eq(actions.status, 'failed'),
          ne(actions.dispatchState, 'in_flight'),
        ),
      )
      .returning({ id: actions.id });
    if (claimed.length === 0) {
      throw new ConflictException(
        `action ${input.actionId} is already being retried`,
      );
    }

    const connector = await this.resolveConnector(input.orgId, original.tool);
    let result: ConnectorResult;
    if (!connector) {
      result = {
        ok: false,
        error: {
          code: 'no_connector',
          message: `no connector resolves tool ${original.tool}`,
        },
      };
    } else {
      result = await connector.invoke(
        original.tool,
        original.params as Record<string, unknown>,
      );
    }

    const newStatus: ActionStatus = result.ok ? 'executed' : 'failed';
    const storedResult = result.ok
      ? { ok: true, data: result.data ?? null }
      : { ok: false, error: result.error ?? { code: 'unknown', message: 'unknown error' } };

    await this.db
      .update(actions)
      .set({
        status: newStatus,
        result: storedResult,
        dispatchState: 'settled',
        completedAt: new Date(),
      })
      .where(eq(actions.id, input.actionId));

    await this.audit.record({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.operatorId,
      eventType: 'action.retried',
      payload: {
        actionId: input.actionId,
        tool: original.tool,
        previous_status: 'failed',
        new_status: newStatus,
        connector: connector?.name ?? null,
        ok: result.ok,
        error: result.ok ? null : result.error ?? null,
      },
    });

    return {
      action_id: input.actionId,
      status: newStatus,
      result: storedResult,
      policy_decision: decision,
    };
  }

  private async lookupAgentName(agentId: string): Promise<string> {
    const rows = await this.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return rows[0]?.name ?? agentId;
  }

  private async resolveConnector(orgId: string, tool: string) {
    const registry = this.connectors as ConnectorRegistry & {
      resolveForOrg?: (orgId: string, tool: string) => Promise<Connector | null>;
    };
    return registry.resolveForOrg
      ? registry.resolveForOrg(orgId, tool)
      : registry.resolve(tool);
  }

  // External-agent polling: a third-party agent that got `awaiting_approval`
  // on /v1/actions/execute calls this to learn when the human decided. Scoped
  // to the agent's org so one tenant cannot read another's action state.
  async getForOrg(orgId: string, actionId: string): Promise<ExecuteOutput | null> {
    const [row] = await this.db
      .select({
        id: actions.id,
        status: actions.status,
        result: actions.result,
        policyDecision: actions.policyDecision,
      })
      .from(actions)
      .where(and(eq(actions.orgId, orgId), eq(actions.id, actionId)))
      .limit(1);
    if (!row) return null;
    return {
      action_id: row.id,
      status: row.status,
      result: (row.result ?? undefined) as Record<string, unknown> | undefined,
      policy_decision: row.policyDecision as unknown as PolicyDecision,
    };
  }

  async listForOrg(orgId: string, limit = 100) {
    const rows = await this.db
      .select({
        id: actions.id,
        agentId: actions.agentId,
        agentName: agents.name,
        tool: actions.tool,
        params: actions.params,
        status: actions.status,
        policyDecision: actions.policyDecision,
        result: actions.result,
        createdAt: actions.createdAt,
        completedAt: actions.completedAt,
      })
      .from(actions)
      .innerJoin(agents, eq(agents.id, actions.agentId))
      .where(eq(actions.orgId, orgId))
      .orderBy(desc(actions.createdAt))
      .limit(limit);
    return {
      items: rows.map((r) => ({
        id: r.id,
        agent_id: r.agentId,
        agent_name: r.agentName,
        tool: r.tool,
        params: r.params,
        status: r.status,
        policy_decision: r.policyDecision,
        result: r.result,
        created_at: r.createdAt.toISOString(),
        completed_at: r.completedAt?.toISOString() ?? null,
      })),
    };
  }

  // Claim the idempotency key before any external call. Returns either the
  // reserved row (we own this key, proceed to dispatch) or the outcome of the
  // request that beat us (we made no connector call at all).
  private async reserveAction(
    input: ExecuteInput,
    decision: PolicyDecision,
  ): Promise<
    | { action: Action; conflict: null }
    | { action: null; conflict: ExecuteOutput }
  > {
    try {
      const [created] = await this.db
        .insert(actions)
        .values({
          orgId: input.orgId,
          agentId: input.agentId,
          tool: input.tool,
          params: input.params,
          status: 'pending',
          policyDecision: decision as unknown as Record<string, unknown>,
          result: null,
          idempotencyKey: input.idempotencyKey ?? null,
          // `in_flight` is claimed in the same insert as the key, not in a
          // follow-up update. Two statements would leave a window where a crash
          // strands the row at `not_dispatched`: the sweeper only looks at
          // `in_flight`, and retry() only accepts `failed`, so nothing would
          // ever resolve it and same-key replays would return `pending` forever.
          // Marking it in-flight a moment before the call is the conservative
          // error: the worst case is an action reported `unknown` whose effect
          // never happened, and `unknown` is never auto-retried.
          dispatchState: 'in_flight',
          dispatchedAt: new Date(),
          completedAt: null,
        })
        .returning();
      if (!created) throw new Error('failed to reserve action');
      return { action: created, conflict: null };
    } catch (err) {
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.findByIdempotencyKey(
          input.orgId,
          input.agentId,
          input.idempotencyKey,
        );
        // The winner may still be mid-flight, in which case `status` is
        // 'pending' and the caller should poll rather than assume success.
        if (existing) return { action: null, conflict: existing };
      }
      throw err;
    }
  }

  // A dispatch that never settled means the process died between "we called
  // the connector" and "we recorded what it said". The external effect may
  // have landed or may not have. We mark it `unknown` and stop — we do not
  // retry, because retrying an unknown send is how a customer gets two emails.
  // Resolving it requires either a provider-side lookup or a human.
  async reconcileStaleDispatches(olderThanMs = 5 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await this.db
      .update(actions)
      .set({
        status: 'failed',
        dispatchState: 'unknown',
        result: {
          ok: false,
          error: {
            code: 'dispatch_unknown',
            message:
              'dispatch started but never settled; the external effect may or may not have occurred. Not retried automatically.',
          },
        },
        completedAt: new Date(),
      })
      .where(
        and(
          eq(actions.dispatchState, 'in_flight'),
          lt(actions.dispatchedAt, cutoff),
        ),
      )
      .returning({ id: actions.id, orgId: actions.orgId, tool: actions.tool });

    for (const row of stale) {
      await this.audit.record({
        orgId: row.orgId,
        actorType: 'system',
        actorId: 'dispatch_reconciler',
        eventType: 'action.dispatch_unknown',
        payload: { actionId: row.id, tool: row.tool },
      });
    }
    if (stale.length > 0) {
      this.log.warn(
        `${stale.length} action(s) marked dispatch_state=unknown — external effect indeterminate`,
      );
    }
    return stale.length;
  }

  // The non-dispatching counterpart to reserveAction(): used by the deny,
  // require_approval, and rate-limited paths, none of which call a connector.
  // Like reserveAction() it reports whether it lost an idempotency race, because
  // losing still matters here — the caller must not go on to insert a second
  // approval, post a second Slack card, or emit an audit event describing a row
  // it did not create.
  private async recordAction(
    input: ExecuteInput,
    status: ActionStatus,
    decision: PolicyDecision,
    result: Record<string, unknown> | null,
  ): Promise<
    { action: Action; conflict: null } | { action: null; conflict: ExecuteOutput }
  > {
    try {
      const [created] = await this.db
        .insert(actions)
        .values({
          orgId: input.orgId,
          agentId: input.agentId,
          tool: input.tool,
          params: input.params,
          status,
          policyDecision: decision as unknown as Record<string, unknown>,
          result,
          idempotencyKey: input.idempotencyKey ?? null,
          completedAt:
            status === 'executed' || status === 'denied' || status === 'failed'
              ? new Date()
              : null,
        })
        .returning();
      if (!created) throw new Error('failed to record action');
      return { action: created, conflict: null };
    } catch (err) {
      // A concurrent request claimed the same idempotency key. Return the
      // winner's stored outcome so the client sees a coherent response rather
      // than a 500 — and so the caller stops before duplicating this action's
      // approval, Slack card, or audit trail.
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.findByIdempotencyKey(
          input.orgId,
          input.agentId,
          input.idempotencyKey,
        );
        if (existing) {
          this.log.debug(
            `idempotency record lost org=${input.orgId} agent=${input.agentId} key=${input.idempotencyKey} — no duplicate approval or audit emitted`,
          );
          return { action: null, conflict: existing };
        }
      }
      throw err;
    }
  }

  private async findByIdempotencyKey(
    orgId: string,
    agentId: string,
    key: string,
  ): Promise<ExecuteOutput | null> {
    const row = await this.findActionRowByIdempotencyKey(orgId, agentId, key);
    if (!row) return null;
    const out: ExecuteOutput = {
      action_id: row.id,
      status: row.status,
      policy_decision: (row.policyDecision ?? {
        effect: 'allow',
        reason: null,
        rule_index: null,
        rule_matched: null,
        approver_role: null,
        policy_id: null,
        fallback: true,
      }) as unknown as PolicyDecision,
    };
    if (row.result !== null && row.result !== undefined) {
      out.result = row.result as Record<string, unknown>;
    }
    return out;
  }

  private async findActionRowByIdempotencyKey(
    orgId: string,
    agentId: string,
    key: string,
  ) {
    const [row] = await this.db
      .select()
      .from(actions)
      .where(
        and(
          eq(actions.orgId, orgId),
          eq(actions.agentId, agentId),
          eq(actions.idempotencyKey, key),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === '23505';
}
