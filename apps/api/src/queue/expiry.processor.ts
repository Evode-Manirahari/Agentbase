import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@agentbase/db';
import { actions, approvals } from '@agentbase/db';
import { AuditService } from '../audit/audit.service.js';
import { AgentRunsService } from '../agent-runtime/agent-runs.service.js';

@Injectable()
export class ExpiryProcessor {
  private readonly log = new Logger(ExpiryProcessor.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    // Optional so the queue can boot without the runtime in test
    // contexts. In production AgentRuntimeModule supplies this.
    @Optional() private readonly agentRuns?: AgentRunsService,
  ) {}

  async sweep(): Promise<{ expired: number }> {
    const stale = await this.db
      .select({
        approvalId: approvals.id,
        actionId: actions.id,
        orgId: actions.orgId,
        agentId: actions.agentId,
        tool: actions.tool,
      })
      .from(approvals)
      .innerJoin(actions, eq(actions.id, approvals.actionId))
      .where(
        and(eq(approvals.decision, 'pending'), lt(approvals.expiresAt, new Date())),
      )
      .limit(100);

    if (stale.length === 0) return { expired: 0 };

    const expiredItems = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(approvals)
        .set({ decision: 'expired', decidedAt: new Date() })
        .where(
          and(
            inArray(
              approvals.id,
              stale.map((s) => s.approvalId),
            ),
            eq(approvals.decision, 'pending'),
          ),
        )
        .returning({ id: approvals.id });

      if (updated.length === 0) return [];

      const updatedSet = new Set(updated.map((u) => u.id));
      const items = stale.filter((s) => updatedSet.has(s.approvalId));
      const updatedActionIds = items.map((i) => i.actionId);

      await tx
        .update(actions)
        .set({ status: 'denied', completedAt: new Date() })
        .where(inArray(actions.id, updatedActionIds));

      return items;
    });

    for (const item of expiredItems) {
      await this.audit.record({
        orgId: item.orgId,
        actorType: 'system',
        actorId: 'expiry_sweeper',
        eventType: 'approval.expired',
        payload: {
          approvalId: item.approvalId,
          actionId: item.actionId,
          tool: item.tool,
        },
      });
    }

    if (expiredItems.length > 0) {
      this.log.log(`expired ${expiredItems.length} pending approval(s)`);
    }
    // Resume any agent runs paused on these now-denied actions.
    if (this.agentRuns) {
      for (const item of expiredItems) {
        void this.agentRuns.notifyActionResolved(item.actionId);
      }
    }
    return { expired: expiredItems.length };
  }
}
