import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { actions, agents, approvals } from '@dejavas/db';
import { AuditService } from '../audit/audit.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { ConnectorRegistry } from '../connectors/connector-registry.js';
import { SlackService } from '../slack/slack.service.js';
import { RateLimitService } from './rate-limit.service.js';
import type { Connector, ConnectorResult } from '@dejavas/connector-hubspot';
import type { ActionStatus, PolicyDecision } from '@dejavas/shared';

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
    // Idempotency: if this (org, agent, key) tuple was already processed,
    // return the stored outcome instead of re-evaluating policy and re-calling
    // the connector. Agents that retry on network errors get exactly-one
    // CRM/email side effect for a given key. Idempotent replays bypass the
    // rate limiter — the original request already paid the cost.
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
      const action = await this.recordAction(input, 'failed', decision, storedResult);
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
      const action = await this.recordAction(input, 'denied', decision, null);
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
      const action = await this.recordAction(
        input,
        'awaiting_approval',
        decision,
        null,
      );
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

    const action = await this.recordAction(
      input,
      finalStatus,
      decision,
      storedResult,
    );
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

  private async recordAction(
    input: ExecuteInput,
    status: ActionStatus,
    decision: PolicyDecision,
    result: Record<string, unknown> | null,
  ) {
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
      return created;
    } catch (err) {
      // Concurrent request claimed the same idempotency key while we were
      // executing. Return the existing row so the client sees a coherent
      // response rather than a 500. The connector side effect happened twice
      // in this rare race; document for buyers as best-effort dedup.
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.findActionRowByIdempotencyKey(
          input.orgId,
          input.agentId,
          input.idempotencyKey,
        );
        if (existing) {
          this.log.warn(
            `idempotency race org=${input.orgId} agent=${input.agentId} key=${input.idempotencyKey} — connector called twice`,
          );
          return existing;
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
