import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@agentbase/db';
import { actions, agents, approvals, users } from '@agentbase/db';
import { AuditService } from '../audit/audit.service.js';
import { ConnectorRegistry } from '../connectors/connector-registry.js';
import type { Connector } from '@agentbase/connector-hubspot';
import { SlackService } from '../slack/slack.service.js';
import { AgentRunsService } from '../agent-runtime/agent-runs.service.js';
import { EffectDispatcher } from '../actions/effect-dispatcher.service.js';
import { RequestHashMismatchError } from '../actions/effect-commit.js';
import type {
  ActionStatus,
  ApprovalDecisionResponse,
  ApprovalListResponse,
  ApprovalView,
  PolicyDecision,
} from '@agentbase/shared';

interface DecideInput {
  approvalId: string;
  orgId: string;
  decision: 'approve' | 'deny';
  decidedByEmail?: string | undefined;
  notes?: string | undefined;
}

export type BulkDecideItem =
  | {
      approval_id: string;
      outcome: 'decided';
      decision: 'approved' | 'denied';
      action_id: string;
      action_status: ActionStatus;
      result: Record<string, unknown> | null;
    }
  | {
      approval_id: string;
      outcome: 'skipped_already_decided';
      decision: 'approved' | 'denied';
    }
  | {
      approval_id: string;
      outcome: 'failed';
      error: { code: string; message: string };
    };

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly connectors: ConnectorRegistry,
    private readonly slack: SlackService,
    private readonly agentRuns: AgentRunsService,
    private readonly effects: EffectDispatcher,
  ) {}

  // Mirrors ActionsService.resolveConnector: prefer the org-scoped resolver so
  // dispatch uses the tenant's own credentials, falling back to the static
  // registry only where an org-scoped one isn't wired (tests, single-tenant).
  private async resolveConnector(orgId: string, tool: string) {
    const registry = this.connectors as ConnectorRegistry & {
      resolveForOrg?: (orgId: string, tool: string) => Promise<Connector | null>;
    };
    return registry.resolveForOrg
      ? registry.resolveForOrg(orgId, tool)
      : registry.resolve(tool);
  }

  async list(orgId: string, limit = 100): Promise<ApprovalListResponse> {
    const rows = await this.db
      .select({
        approval_id: approvals.id,
        action_id: approvals.actionId,
        required_role: approvals.requiredRole,
        decision: approvals.decision,
        expires_at: approvals.expiresAt,
        created_at: approvals.createdAt,
        decided_at: approvals.decidedAt,
        slack_channel: approvals.slackChannel,
        slack_ts: approvals.slackTs,
        tool: actions.tool,
        params: actions.params,
        policy_decision: actions.policyDecision,
        effect_assessment: actions.effectAssessment,
        agent_id: agents.id,
        agent_name: agents.name,
        decided_by_email: users.email,
      })
      .from(approvals)
      .innerJoin(actions, eq(actions.id, approvals.actionId))
      .innerJoin(agents, eq(agents.id, actions.agentId))
      .leftJoin(users, eq(users.id, approvals.decidedByUserId))
      .where(and(eq(actions.orgId, orgId), eq(approvals.decision, 'pending')))
      .orderBy(desc(approvals.createdAt))
      .limit(limit);

    return { items: rows.map(toView) };
  }

  async getOne(orgId: string, approvalId: string): Promise<ApprovalView> {
    const rows = await this.db
      .select({
        approval_id: approvals.id,
        action_id: approvals.actionId,
        required_role: approvals.requiredRole,
        decision: approvals.decision,
        expires_at: approvals.expiresAt,
        created_at: approvals.createdAt,
        decided_at: approvals.decidedAt,
        slack_channel: approvals.slackChannel,
        slack_ts: approvals.slackTs,
        tool: actions.tool,
        params: actions.params,
        policy_decision: actions.policyDecision,
        effect_assessment: actions.effectAssessment,
        agent_id: agents.id,
        agent_name: agents.name,
        decided_by_email: users.email,
      })
      .from(approvals)
      .innerJoin(actions, eq(actions.id, approvals.actionId))
      .innerJoin(agents, eq(agents.id, actions.agentId))
      .leftJoin(users, eq(users.id, approvals.decidedByUserId))
      .where(and(eq(approvals.id, approvalId), eq(actions.orgId, orgId)))
      .limit(1);

    const row = rows[0];
    if (!row) throw new NotFoundException('approval not found');
    return toView(row);
  }

  async decide(input: DecideInput): Promise<ApprovalDecisionResponse> {
    const phase1 = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(approvals)
        .innerJoin(actions, eq(actions.id, approvals.actionId))
        .where(eq(approvals.id, input.approvalId))
        .limit(1);

      const row = rows[0];
      if (!row || row.actions.orgId !== input.orgId) {
        throw new NotFoundException('approval not found');
      }
      const approval = row.approvals;
      const action = row.actions;

      if (approval.decision !== 'pending') {
        throw new ConflictException(
          `approval already ${approval.decision}`,
        );
      }

      if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
        await tx
          .update(approvals)
          .set({ decision: 'expired', decidedAt: new Date() })
          .where(eq(approvals.id, approval.id));
        await tx
          .update(actions)
          .set({ status: 'denied', completedAt: new Date() })
          .where(eq(actions.id, action.id));
        // Don't throw inside the tx — that rolls back the state flip we just
        // made. Signal to the caller via a sentinel branch and throw after
        // the tx commits.
        return { branch: 'expired' as const, approval, action, userId: null };
      }

      let userId: string | null = null;
      if (input.decidedByEmail) {
        userId = await upsertUser(tx, input.orgId, input.decidedByEmail);
      }

      if (input.decision === 'deny') {
        // Same conditional claim as the approve branch. A deny racing an
        // approve must not leave the approval recorded as denied while the
        // approve branch goes on to dispatch the connector.
        const claimed = await tx
          .update(approvals)
          .set({
            decision: 'denied',
            decidedAt: new Date(),
            decidedByUserId: userId,
          })
          .where(
            and(eq(approvals.id, approval.id), eq(approvals.decision, 'pending')),
          )
          .returning({ id: approvals.id });
        if (claimed.length === 0) {
          throw new ConflictException('approval already decided');
        }
        await tx
          .update(actions)
          .set({ status: 'denied', completedAt: new Date() })
          .where(eq(actions.id, action.id));
        return { branch: 'denied' as const, approval, action, userId };
      }

      // 'approve' — set intermediate states; dispatch happens after tx commits.
      //
      // The `decision = 'pending'` predicate is what makes this safe, not the
      // surrounding transaction. Under READ COMMITTED two concurrent approvals
      // both read 'pending' above and both pass the check; only a conditional
      // update lets exactly one of them win. The loser gets 409 and dispatches
      // nothing — otherwise a double-click sends the email twice.
      const claimed = await tx
        .update(approvals)
        .set({
          decision: 'approved',
          decidedAt: new Date(),
          decidedByUserId: userId,
        })
        .where(
          and(eq(approvals.id, approval.id), eq(approvals.decision, 'pending')),
        )
        .returning({ id: approvals.id });
      if (claimed.length === 0) {
        throw new ConflictException('approval already decided');
      }
      // `in_flight` is claimed in the same transaction that wins the approval,
      // for the same reason ActionsService.reserveAction() claims it in the
      // insert: the sweeper only sees `in_flight`, so a dispatch marked after
      // the fact is invisible if the process dies before the mark lands. This
      // is the highest-consequence dispatch in the system — a human just
      // approved a $60k deal update — and it was the one path that left
      // dispatch_state on its `not_dispatched` default the whole way through.
      await tx
        .update(actions)
        .set({
          status: 'approved',
          dispatchState: 'in_flight',
          dispatchedAt: new Date(),
        })
        .where(eq(actions.id, action.id));
      return { branch: 'approved' as const, approval, action, userId };
    });

    if (phase1.branch === 'expired') {
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'system',
        actorId: 'decide_expiry_check',
        eventType: 'approval.expired',
        payload: {
          approvalId: phase1.approval.id,
          actionId: phase1.action.id,
          tool: phase1.action.tool,
        },
      });
      throw new GoneException('approval expired');
    }

    if (phase1.branch === 'denied') {
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'user',
        actorId: phase1.userId ?? input.decidedByEmail ?? 'unknown',
        eventType: 'approval.denied',
        payload: {
          approvalId: phase1.approval.id,
          actionId: phase1.action.id,
          tool: phase1.action.tool,
          notes: input.notes ?? null,
        },
      });
      await this.maybeUpdateSlackCard({
        approval: phase1.approval,
        action: phase1.action,
        decision: 'denied',
        decidedByDisplay:
          input.decidedByEmail ?? phase1.approval.decidedByUserId ?? 'web',
        actionStatus: 'denied',
        errorCode: null,
      });
      // Resume any agent runs paused on this action. Fire-and-forget —
      // the approval response should not wait on the worker queue.
      void this.agentRuns.notifyActionResolved(phase1.action.id);
      return {
        approval_id: phase1.approval.id,
        decision: 'denied',
        action_id: phase1.action.id,
        action_status: 'denied',
        result: null,
      };
    }

    // approve branch — dispatch through the same connector path used by effect:allow.
    //
    // resolveForOrg, not resolve: an approved action must run against the
    // org's own stored (AES-encrypted) connector credentials. The unscoped
    // resolver falls back to process env, which means one tenant's approved
    // action could dispatch with credentials that are not theirs.
    const action = phase1.action;
    const connector = await this.resolveConnector(action.orgId, action.tool);
    // Through the commit protocol, and bound to the request hash: a human
    // approved "delete branch release/v2", not "whatever row 8f3c holds by the
    // time we get here". If the params no longer hash to what was approved,
    // dispatch() throws and nothing is sent.
    let dispatched;
    try {
      dispatched = await this.effects.dispatch({
        actionId: action.id,
        tool: action.tool,
        params: action.params,
        approvedRequestHash: action.requestHash,
        connector,
      });
    } catch (err) {
      if (err instanceof RequestHashMismatchError) {
        // Phase 1 already committed `in_flight`. Leaving it there would let the
        // sweeper promote this to `unknown` — which asserts the effect MAY have
        // occurred, when the refusal is positive proof that nothing was sent.
        // For a `none` connector that false `unknown` would also make the
        // action permanently non-retryable.
        await this.db
          .update(actions)
          .set({
            status: 'failed',
            dispatchState: 'settled',
            result: {
              ok: false,
              error: {
                code: 'request_changed_after_approval',
                message: err.message,
              },
            },
            completedAt: new Date(),
          })
          .where(eq(actions.id, action.id));
        await this.audit.record({
          orgId: input.orgId,
          actorType: 'system',
          actorId: 'effect_gate',
          eventType: 'action.request_changed_after_approval',
          payload: {
            actionId: action.id,
            tool: action.tool,
            approvalId: phase1.approval.id,
          },
        });
        // The action is terminal, so everything waiting on it has to be told
        // BEFORE we throw. Otherwise the Slack card sits "pending" forever on a
        // decision that will never come, and any agent run paused on this
        // action never resumes — a refusal that protects the effect but strands
        // the workflow is only half a fix.
        await this.maybeUpdateSlackCard({
          approval: phase1.approval,
          action: phase1.action,
          decision: 'approved',
          decidedByDisplay:
            input.decidedByEmail ?? phase1.approval.decidedByUserId ?? 'web',
          actionStatus: 'failed',
          errorCode: 'request_changed_after_approval',
        });
        void this.agentRuns.notifyActionResolved(action.id);
        throw new ConflictException(err.message);
      }
      throw err;
    }
    const result = dispatched.result;

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
      actorType: 'user',
      actorId: phase1.userId ?? input.decidedByEmail ?? 'unknown',
      eventType: 'approval.approved',
      payload: {
        approvalId: phase1.approval.id,
        actionId: action.id,
        tool: action.tool,
        notes: input.notes ?? null,
      },
    });
    await this.audit.record({
      orgId: input.orgId,
      actorType: 'system',
      actorId: 'dispatcher',
      eventType: result.ok ? 'action.executed' : 'action.failed',
      payload: {
        actionId: action.id,
        tool: action.tool,
        connector: dispatched.connectorName,
        idempotency_key_sent: dispatched.idempotencyKeySent,
        replayed: dispatched.replayed,
        ok: result.ok,
        error: result.ok ? null : result.error ?? null,
      },
    });

    await this.maybeUpdateSlackCard({
      approval: phase1.approval,
      action,
      decision: 'approved',
      decidedByDisplay:
        input.decidedByEmail ?? phase1.userId ?? 'web',
      actionStatus: finalStatus,
      errorCode: result.ok ? null : result.error?.code ?? null,
    });

    // Resume any agent runs paused on this action. Fire-and-forget.
    void this.agentRuns.notifyActionResolved(action.id);

    return {
      approval_id: phase1.approval.id,
      decision: 'approved',
      action_id: action.id,
      action_status: finalStatus,
      result: storedResult,
    };
  }

  // Approve / deny N pending approvals in one call. Each id is processed
  // sequentially through decide() so audit log + Slack card update +
  // agent-run resume all fire correctly per approval. One failure
  // doesn't block the rest — the caller gets a row-by-row picture.
  // BulkDecideItem is locally typed; the wire shape lives in @agentbase/shared
  // (BulkApprovalDecisionItem) and the controller maps between them.
  //
  // Already-decided approvals are surfaced as a distinct outcome
  // ("skipped_already_decided") rather than failed, so a stale
  // dashboard re-clicking the same set doesn't read as a fault.
  async bulkDecide(input: {
    orgId: string;
    approvalIds: string[];
    decision: 'approve' | 'deny';
    decidedByEmail?: string | undefined;
    notes?: string | undefined;
  }): Promise<{
    items: BulkDecideItem[];
    summary: { decided: number; skipped_already_decided: number; failed: number };
  }> {
    const items: BulkDecideItem[] = [];
    const summary = { decided: 0, skipped_already_decided: 0, failed: 0 };
    for (const approvalId of input.approvalIds) {
      try {
        const out = await this.decide({
          approvalId,
          orgId: input.orgId,
          decision: input.decision,
          ...(input.decidedByEmail ? { decidedByEmail: input.decidedByEmail } : {}),
          ...(input.notes ? { notes: input.notes } : {}),
        });
        items.push({
          approval_id: approvalId,
          outcome: 'decided',
          // decide() can only return 'approved' or 'denied' on the
          // success path — the ApprovalDecision enum is wider than the
          // outcome bulkDecide cares about, so we narrow here.
          decision: out.decision as 'approved' | 'denied',
          action_id: out.action_id,
          action_status: out.action_status,
          result: (out.result ?? null) as Record<string, unknown> | null,
        });
        summary.decided += 1;
      } catch (err) {
        if (err instanceof ConflictException) {
          // The approval was already decided (or just finished resolving
          // mid-loop). That's not a fault; surface it so the dashboard
          // can refresh and show the final state.
          items.push({
            approval_id: approvalId,
            outcome: 'skipped_already_decided',
            decision: 'approved',
          });
          summary.skipped_already_decided += 1;
          continue;
        }
        const message =
          err instanceof Error ? err.message : 'unknown error during bulk decide';
        const code =
          err instanceof NotFoundException
            ? 'not_found'
            : err instanceof GoneException
              ? 'expired'
              : 'internal';
        items.push({
          approval_id: approvalId,
          outcome: 'failed',
          error: { code, message },
        });
        summary.failed += 1;
      }
    }
    return { items, summary };
  }

  private async maybeUpdateSlackCard(input: {
    approval: { id: string; slackChannel: string | null; slackTs: string | null };
    action: { tool: string; agentId: string };
    decision: 'approved' | 'denied';
    decidedByDisplay: string;
    actionStatus: ActionStatus;
    errorCode: string | null;
  }): Promise<void> {
    const { slackChannel, slackTs } = input.approval;
    if (!slackChannel || !slackTs) return;
    const blocks = this.slack.buildResolvedBlocks({
      decision: input.decision,
      decidedByDisplay: input.decidedByDisplay,
      tool: input.action.tool,
      agentName: input.action.agentId,
      actionStatus: input.actionStatus,
      errorCode: input.errorCode,
      notes: null,
    });
    await this.slack.updateCard(
      slackChannel,
      slackTs,
      blocks,
      `Approval ${input.decision} via web`,
    );
  }
}

function toView(row: {
  approval_id: string;
  action_id: string;
  required_role: 'admin' | 'approver' | 'viewer';
  decision: 'pending' | 'approved' | 'denied' | 'expired';
  expires_at: Date | null;
  created_at: Date;
  decided_at: Date | null;
  slack_channel: string | null;
  slack_ts: string | null;
  tool: string;
  params: Record<string, unknown>;
  policy_decision: Record<string, unknown> | null;
  effect_assessment: {
    effectClass: string;
    reversible: boolean;
    summary: string;
  } | null;
  agent_id: string;
  agent_name: string;
  decided_by_email: string | null;
}): ApprovalView {
  return {
    approval_id: row.approval_id,
    action_id: row.action_id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    tool: row.tool,
    params: row.params,
    policy_decision: (row.policy_decision as PolicyDecision | null) ?? null,
    effect_assessment: row.effect_assessment,
    required_role: row.required_role,
    decision: row.decision,
    expires_at: row.expires_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at?.toISOString() ?? null,
    decided_by_email: row.decided_by_email,
    slack_channel: row.slack_channel,
    slack_ts: row.slack_ts,
  };
}

async function upsertUser(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  orgId: string,
  email: string,
): Promise<string> {
  const existing = await tx
    .select()
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.email, email)))
    .limit(1);
  const found = existing[0];
  if (found) return found.id;
  const [created] = await tx
    .insert(users)
    .values({ orgId, email, role: 'approver' })
    .returning();
  if (!created) throw new Error('failed to create user');
  return created.id;
}
