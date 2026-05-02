import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { actions, approvals } from '@dejavas/db';
import { AuditService } from '../audit/audit.service.js';
import { PolicyService } from '../policy/policy.service.js';
import type {
  ActionStatus,
  PolicyDecision,
} from '@dejavas/shared';

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
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
  ) {}

  async execute(input: ExecuteInput): Promise<ExecuteOutput> {
    const decision = await this.policy.evaluate(input.orgId, {
      tool: input.tool,
      params: input.params,
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
      await this.db.insert(approvals).values({
        actionId: action.id,
        requiredRole: decision.approver_role ?? 'approver',
        decision: 'pending',
        expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
      });
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'agent',
        actorId: input.agentId,
        eventType: 'action.awaiting_approval',
        payload: { actionId: action.id, tool: input.tool, decision },
      });
      return {
        action_id: action.id,
        status: 'awaiting_approval',
        policy_decision: decision,
      };
    }

    // effect === 'allow' — connector dispatch lands in the next PR.
    const stubResult = { stub: true, note: 'connector dispatch not implemented' };
    const action = await this.recordAction(input, 'executed', decision, stubResult);
    await this.audit.record({
      orgId: input.orgId,
      actorType: 'agent',
      actorId: input.agentId,
      eventType: 'action.executed',
      payload: { actionId: action.id, tool: input.tool, decision },
    });
    return {
      action_id: action.id,
      status: 'executed',
      result: stubResult,
      policy_decision: decision,
    };
  }

  private async recordAction(
    input: ExecuteInput,
    status: ActionStatus,
    decision: PolicyDecision,
    result: Record<string, unknown> | null,
  ) {
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
        completedAt: status === 'executed' || status === 'denied' ? new Date() : null,
      })
      .returning();
    if (!created) throw new Error('failed to record action');
    return created;
  }
}
