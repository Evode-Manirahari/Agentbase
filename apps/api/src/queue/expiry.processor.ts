import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { actions, approvals } from '@dejavas/db';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class ExpiryProcessor {
  private readonly log = new Logger(ExpiryProcessor.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
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
    return { expired: expiredItems.length };
  }
}
