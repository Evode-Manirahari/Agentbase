import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { actions, approvals } from '@dejavas/db';
import { AuditService } from '../audit/audit.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { ConnectorRegistry } from '../connectors/connector-registry.js';
import type { ConnectorResult } from '@dejavas/connector-hubspot';
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
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly connectors: ConnectorRegistry,
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

    // effect === 'allow' — dispatch to a connector.
    const connector = this.connectors.resolve(input.tool);
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
        completedAt:
          status === 'executed' || status === 'denied' || status === 'failed'
            ? new Date()
            : null,
      })
      .returning();
    if (!created) throw new Error('failed to record action');
    return created;
  }
}
