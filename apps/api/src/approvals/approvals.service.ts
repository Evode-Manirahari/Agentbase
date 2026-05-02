import {
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { actions, agents, approvals, users } from '@dejavas/db';
import { AuditService } from '../audit/audit.service.js';
import { ConnectorRegistry } from '../connectors/connector-registry.js';
import { SlackService } from '../slack/slack.service.js';
import type {
  ActionStatus,
  ApprovalDecisionResponse,
  ApprovalListResponse,
  ApprovalView,
  PolicyDecision,
} from '@dejavas/shared';

interface DecideInput {
  approvalId: string;
  orgId: string;
  decision: 'approve' | 'deny';
  decidedByEmail?: string | undefined;
  notes?: string | undefined;
}

@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly connectors: ConnectorRegistry,
    private readonly slack: SlackService,
  ) {}

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
        tool: actions.tool,
        params: actions.params,
        policy_decision: actions.policyDecision,
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
        tool: actions.tool,
        params: actions.params,
        policy_decision: actions.policyDecision,
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
        await tx
          .update(approvals)
          .set({
            decision: 'denied',
            decidedAt: new Date(),
            decidedByUserId: userId,
          })
          .where(eq(approvals.id, approval.id));
        await tx
          .update(actions)
          .set({ status: 'denied', completedAt: new Date() })
          .where(eq(actions.id, action.id));
        return { branch: 'denied' as const, approval, action, userId };
      }

      // 'approve' — set intermediate states; dispatch happens after tx commits.
      await tx
        .update(approvals)
        .set({
          decision: 'approved',
          decidedAt: new Date(),
          decidedByUserId: userId,
        })
        .where(eq(approvals.id, approval.id));
      await tx
        .update(actions)
        .set({ status: 'approved' })
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
      return {
        approval_id: phase1.approval.id,
        decision: 'denied',
        action_id: phase1.action.id,
        action_status: 'denied',
        result: null,
      };
    }

    // approve branch — dispatch through the same connector path used by effect:allow.
    const action = phase1.action;
    const connector = this.connectors.resolve(action.tool);
    const result = !connector
      ? {
          ok: false as const,
          error: {
            code: 'no_connector',
            message: `no connector resolves tool ${action.tool}`,
          },
        }
      : await connector.invoke(action.tool, action.params);

    const finalStatus: ActionStatus = result.ok ? 'executed' : 'failed';
    const storedResult = result.ok
      ? { ok: true, data: result.data ?? null }
      : { ok: false, error: result.error ?? { code: 'unknown', message: 'unknown error' } };

    await this.db
      .update(actions)
      .set({
        status: finalStatus,
        result: storedResult,
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
        connector: connector?.name ?? null,
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

    return {
      approval_id: phase1.approval.id,
      decision: 'approved',
      action_id: action.id,
      action_status: finalStatus,
      result: storedResult,
    };
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
  tool: string;
  params: Record<string, unknown>;
  policy_decision: Record<string, unknown> | null;
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
    required_role: row.required_role,
    decision: row.decision,
    expires_at: row.expires_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    decided_at: row.decided_at?.toISOString() ?? null,
    decided_by_email: row.decided_by_email,
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
