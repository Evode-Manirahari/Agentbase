import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { actions } from '@dejavas/db';
import { AuditService } from '../audit/audit.service.js';
import type { ActionStatus } from '@dejavas/shared';

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
  result?: Record<string, unknown>;
  policy_decision?: Record<string, unknown>;
}

@Injectable()
export class ActionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async execute(input: ExecuteInput): Promise<ExecuteOutput> {
    // v0: no policy engine, no connectors yet — just record the attempt.
    // Policy engine + connector dispatch lands in the next PR.
    const policyDecision = {
      effect: 'allow' as const,
      reason: 'no_policy_engine_yet',
      ruleMatched: null,
    };

    const [created] = await this.db
      .insert(actions)
      .values({
        orgId: input.orgId,
        agentId: input.agentId,
        tool: input.tool,
        params: input.params,
        status: 'executed',
        policyDecision,
        result: { stub: true, note: 'connector dispatch not implemented' },
        idempotencyKey: input.idempotencyKey ?? null,
        completedAt: new Date(),
      })
      .returning();

    if (!created) throw new Error('failed to record action');

    await this.audit.record({
      orgId: input.orgId,
      actorType: 'agent',
      actorId: input.agentId,
      eventType: 'action.executed',
      payload: {
        actionId: created.id,
        tool: input.tool,
        status: 'executed',
        policyDecision,
      },
    });

    return {
      action_id: created.id,
      status: 'executed',
      policy_decision: policyDecision,
      result: { stub: true },
    };
  }
}
