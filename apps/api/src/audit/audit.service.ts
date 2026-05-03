import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { auditLog } from '@dejavas/db';
import { WebhookService } from '../webhooks/webhook.service.js';

export interface AuditEvent {
  orgId: string;
  actorType: 'agent' | 'user' | 'system';
  actorId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    // Optional so existing tests can construct AuditService without wiring
    // the webhook plumbing. Production boot supplies the real instance.
    @Optional() private readonly webhooks?: WebhookService,
  ) {}

  async record(event: AuditEvent): Promise<void> {
    const [row] = await this.db
      .insert(auditLog)
      .values({
        orgId: event.orgId,
        actorType: event.actorType,
        actorId: event.actorId,
        eventType: event.eventType,
        payload: event.payload,
      })
      .returning({ createdAt: auditLog.createdAt });

    // Fire-and-forget webhook fan-out. If WebhookService isn't wired (tests)
    // or dispatch errors internally, we already swallowed it inside dispatch
    // — the audit row is committed regardless.
    if (this.webhooks) {
      void this.webhooks.dispatch({
        orgId: event.orgId,
        eventType: event.eventType,
        actorType: event.actorType,
        actorId: event.actorId,
        payload: event.payload,
        occurredAt: (row?.createdAt ?? new Date()).toISOString(),
      });
    }
  }

  async listForOrg(orgId: string, limit = 100) {
    return this.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.orgId, orgId))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
  }
}
