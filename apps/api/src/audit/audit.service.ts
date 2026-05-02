import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { auditLog } from '@dejavas/db';

export interface AuditEvent {
  orgId: string;
  actorType: 'agent' | 'user' | 'system';
  actorId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async record(event: AuditEvent): Promise<void> {
    await this.db.insert(auditLog).values({
      orgId: event.orgId,
      actorType: event.actorType,
      actorId: event.actorId,
      eventType: event.eventType,
      payload: event.payload,
    });
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
