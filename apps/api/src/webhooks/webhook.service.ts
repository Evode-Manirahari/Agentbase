import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { Queue } from 'bullmq';
import { createHmac, randomBytes } from 'node:crypto';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { webhookSubscriptions } from '@dejavas/db';
import { QUEUE } from '../queue/queue.tokens.js';

export interface WebhookEvent {
  orgId: string;
  eventType: string;
  actorType: string;
  actorId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface DeliverJobData {
  subscriptionId: string;
  event: WebhookEvent;
}

export const WEBHOOK_DELIVER_JOB = 'webhook.deliver';

const DELIVERY_TIMEOUT_MS = 10_000;

@Injectable()
export class WebhookService {
  private readonly log = new Logger(WebhookService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(QUEUE) private readonly queue: Queue,
  ) {}

  // Called from AuditService.record() — fan out the event to every subscription
  // that matches the orgId + eventType. Wildcard '*' in events[] matches all.
  // Best-effort: errors here must NOT bubble back into AuditService and abort
  // the event being recorded; we log and move on.
  async dispatch(event: WebhookEvent): Promise<void> {
    try {
      const subs = await this.db
        .select()
        .from(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.orgId, event.orgId),
            eq(webhookSubscriptions.enabled, true),
          ),
        );
      if (subs.length === 0) return;

      for (const sub of subs) {
        const events = sub.events ?? [];
        if (!events.includes('*') && !events.includes(event.eventType)) continue;
        await this.queue.add(
          WEBHOOK_DELIVER_JOB,
          { subscriptionId: sub.id, event } satisfies DeliverJobData,
          {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 100,
            removeOnFail: 50,
          },
        );
      }
    } catch (err) {
      this.log.warn(`webhook dispatch failed: ${(err as Error).message}`);
    }
  }

  // BullMQ worker calls this. Returns delivery outcome; throws to trigger
  // BullMQ's retry policy on transient failures (network, 5xx).
  async deliver(data: DeliverJobData): Promise<{ status: number }> {
    const [sub] = await this.db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, data.subscriptionId))
      .limit(1);

    if (!sub) {
      // Subscription was deleted between dispatch and delivery — drop silently.
      this.log.debug(
        `subscription ${data.subscriptionId} deleted — skipping delivery`,
      );
      return { status: 0 };
    }
    if (!sub.enabled) {
      this.log.debug(
        `subscription ${data.subscriptionId} disabled — skipping delivery`,
      );
      return { status: 0 };
    }

    const body = JSON.stringify(data.event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = sign(sub.secret, timestamp, body);

    let status = 0;
    let errorMsg: string | null = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
      try {
        const res = await fetch(sub.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dejavas-event-type': data.event.eventType,
            'x-dejavas-subscription-id': sub.id,
            'x-dejavas-timestamp': timestamp,
            'x-dejavas-signature': `sha256=${signature}`,
          },
          body,
          signal: ctrl.signal,
        });
        status = res.status;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      errorMsg = (err as Error).message;
    }

    const ok = status >= 200 && status < 300;
    await this.db
      .update(webhookSubscriptions)
      .set({
        lastDeliveryAt: new Date(),
        lastDeliveryStatus: ok ? `${status}` : errorMsg ?? `${status}`,
      })
      .where(eq(webhookSubscriptions.id, sub.id));

    if (!ok) {
      // Throw so BullMQ retries with backoff. After max attempts the job
      // moves to failed and the lastDeliveryStatus stays as the error.
      throw new Error(
        `delivery failed: ${errorMsg ?? `status ${status}`} url=${sub.url}`,
      );
    }
    return { status };
  }

  // Management: list, create, update, delete subscriptions. Secrets are
  // returned only on create (so the operator can copy them once); subsequent
  // reads return a redacted form.
  async list(orgId: string) {
    const rows = await this.db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.orgId, orgId))
      .orderBy(desc(webhookSubscriptions.createdAt));
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        events: r.events,
        enabled: r.enabled,
        last_delivery_at: r.lastDeliveryAt?.toISOString() ?? null,
        last_delivery_status: r.lastDeliveryStatus,
        created_at: r.createdAt.toISOString(),
      })),
    };
  }

  async create(input: {
    orgId: string;
    name: string;
    url: string;
    events: string[];
  }) {
    const secret = `dws_${randomBytes(24).toString('hex')}`;
    const [created] = await this.db
      .insert(webhookSubscriptions)
      .values({
        orgId: input.orgId,
        name: input.name,
        url: input.url,
        events: input.events,
        secret,
      })
      .returning();
    if (!created) throw new Error('failed to create subscription');
    return {
      id: created.id,
      name: created.name,
      url: created.url,
      events: created.events,
      enabled: created.enabled,
      // Surface ONCE — never returned by list/get.
      secret,
      created_at: created.createdAt.toISOString(),
    };
  }

  async update(
    orgId: string,
    id: string,
    patch: {
      enabled?: boolean | undefined;
      events?: string[] | undefined;
      url?: string | undefined;
      name?: string | undefined;
    },
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' }> {
    const set: Partial<typeof webhookSubscriptions.$inferInsert> = {};
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.events !== undefined) set.events = patch.events;
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.name !== undefined) set.name = patch.name;
    if (Object.keys(set).length === 0) return { ok: true };
    const updated = await this.db
      .update(webhookSubscriptions)
      .set(set)
      .where(
        and(
          eq(webhookSubscriptions.id, id),
          eq(webhookSubscriptions.orgId, orgId),
        ),
      )
      .returning({ id: webhookSubscriptions.id });
    if (updated.length === 0) return { ok: false, reason: 'not_found' };
    return { ok: true };
  }

  async remove(orgId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(webhookSubscriptions)
      .where(
        and(
          eq(webhookSubscriptions.id, id),
          eq(webhookSubscriptions.orgId, orgId),
        ),
      )
      .returning({ id: webhookSubscriptions.id });
    return deleted.length > 0;
  }
}

// HMAC: sha256(`${timestamp}.${body}`) with the subscription secret as key.
// Receivers verify by recomputing and constant-time-comparing the hex digest.
// Including the timestamp prevents replay of an old captured request.
export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}
