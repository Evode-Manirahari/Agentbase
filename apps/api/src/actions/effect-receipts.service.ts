import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database, EffectReceipt } from '@agentbase/db';
import { effectReceipts } from '@agentbase/db';
import type { ConnectorResult } from '@agentbase/connector-hubspot';

export interface AttemptHandle {
  id: string;
  attempt: number;
}

@Injectable()
export class EffectReceiptsService {
  private readonly log = new Logger(EffectReceiptsService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Claim the next attempt for an action and record that we are about to call
   * a provider.
   *
   * The row is written as `indeterminate` BEFORE the request goes out, because
   * that is the honest description of the state we are entering: a request is
   * about to exist in the world and we do not yet know its fate. If the process
   * dies here, the row survives saying exactly that. Writing the row after the
   * call would mean a crash leaves no evidence an effect was ever attempted —
   * which is how an agent's retry silently sends a second email.
   *
   * The unique (action_id, attempt) index is the claim: two concurrent
   * dispatchers cannot both take attempt N.
   */
  async begin(input: {
    actionId: string;
    connectorName: string;
    idempotencyKeySent: string | null;
  }): Promise<AttemptHandle> {
    const attempt = await this.nextAttempt(input.actionId);
    const [row] = await this.db
      .insert(effectReceipts)
      .values({
        actionId: input.actionId,
        attempt,
        connectorName: input.connectorName,
        idempotencyKeySent: input.idempotencyKeySent,
        outcome: 'indeterminate',
      })
      .returning({ id: effectReceipts.id, attempt: effectReceipts.attempt });
    if (!row) throw new Error('failed to open effect attempt');
    return row;
  }

  /**
   * Record what the provider said. Only a settled attempt stops being
   * `indeterminate` — there is no path that quietly upgrades an unknown
   * outcome to a known one without a provider response in hand.
   */
  async settle(
    handle: AttemptHandle,
    result: ConnectorResult,
    providerRef: string | null,
  ): Promise<void> {
    await this.db
      .update(effectReceipts)
      .set({
        outcome: result.ok ? 'committed' : 'failed',
        providerRef,
        receipt: (result.ok
          ? { ok: true, data: result.data ?? null }
          : { ok: false, error: result.error ?? null }) as Record<string, unknown>,
        settledAt: new Date(),
      })
      .where(eq(effectReceipts.id, handle.id));
  }

  /**
   * The receipt replay serves: the most recent COMMITTED attempt for an action.
   *
   * Deliberately never returns an indeterminate attempt. Replaying an
   * indeterminate effect as though it succeeded would manufacture evidence for
   * something that may never have happened.
   */
  async committedReceipt(actionId: string): Promise<EffectReceipt | null> {
    const [row] = await this.db
      .select()
      .from(effectReceipts)
      .where(
        and(
          eq(effectReceipts.actionId, actionId),
          eq(effectReceipts.outcome, 'committed'),
        ),
      )
      .orderBy(desc(effectReceipts.attempt))
      .limit(1);
    return row ?? null;
  }

  /** Full attempt history for an action, oldest first. The evidence trail. */
  async history(actionId: string): Promise<EffectReceipt[]> {
    return this.db
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.actionId, actionId))
      .orderBy(effectReceipts.attempt);
  }

  /**
   * Attempts nobody knows the outcome of. This is an operator queue, not a
   * retry queue — resolving one requires a provider-side lookup or a human,
   * because the whole point is that we cannot tell from here.
   */
  async indeterminate(limit = 100): Promise<EffectReceipt[]> {
    const rows = await this.db
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.outcome, 'indeterminate'))
      .orderBy(desc(effectReceipts.startedAt))
      .limit(limit);
    if (rows.length > 0) {
      this.log.debug(`${rows.length} indeterminate effect attempt(s) awaiting resolution`);
    }
    return rows;
  }

  private async nextAttempt(actionId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`coalesce(max(${effectReceipts.attempt}), 0) + 1` })
      .from(effectReceipts)
      .where(eq(effectReceipts.actionId, actionId));
    return Number(row?.n ?? 1);
  }
}
