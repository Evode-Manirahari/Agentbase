import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database, EffectReceipt } from '@agentbase/db';
import { actions, effectReceipts } from '@agentbase/db';
import type { ConnectorResult, IdempotencyMode } from '@agentbase/connector-hubspot';
import { AuditService } from '../audit/audit.service.js';

export interface AttemptHandle {
  id: string;
  attempt: number;
}

@Injectable()
export class EffectReceiptsService {
  private readonly log = new Logger(EffectReceiptsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

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
    idempotencyMode: IdempotencyMode;
  }): Promise<AttemptHandle> {
    const attempt = await this.nextAttempt(input.actionId);
    const [row] = await this.db
      .insert(effectReceipts)
      .values({
        actionId: input.actionId,
        attempt,
        connectorName: input.connectorName,
        idempotencyKeySent: input.idempotencyKeySent,
        idempotencyMode: input.idempotencyMode,
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

  /**
   * The operator queue, scoped to one tenant. Receipts carry no org of their
   * own — they inherit it from the action, so scoping goes through the join
   * rather than a denormalised column that could drift out of agreement.
   */
  async indeterminateForOrg(orgId: string, limit = 100) {
    return this.db
      .select({
        receipt_id: effectReceipts.id,
        action_id: effectReceipts.actionId,
        attempt: effectReceipts.attempt,
        connector: effectReceipts.connectorName,
        idempotency_key_sent: effectReceipts.idempotencyKeySent,
        idempotency_mode: effectReceipts.idempotencyMode,
        started_at: effectReceipts.startedAt,
        tool: actions.tool,
        params: actions.params,
      })
      .from(effectReceipts)
      .innerJoin(actions, eq(actions.id, effectReceipts.actionId))
      .where(
        and(
          eq(actions.orgId, orgId),
          eq(effectReceipts.outcome, 'indeterminate'),
        ),
      )
      .orderBy(effectReceipts.startedAt)
      .limit(limit);
  }

  /** Full evidence trail for one action, scoped to the tenant that owns it. */
  async historyForOrg(orgId: string, actionId: string): Promise<EffectReceipt[]> {
    const rows = await this.db
      .select({ r: effectReceipts })
      .from(effectReceipts)
      .innerJoin(actions, eq(actions.id, effectReceipts.actionId))
      .where(and(eq(actions.orgId, orgId), eq(effectReceipts.actionId, actionId)))
      .orderBy(effectReceipts.attempt);
    return rows.map((x) => x.r);
  }

  /**
   * End a quarantine.
   *
   * Only a human (or a provider-side lookup they ran) can resolve an
   * indeterminate attempt, because the system genuinely cannot tell — that is
   * the whole reason the state exists. This records what they found and moves
   * the action to match.
   *
   * The conditional `WHERE outcome = 'indeterminate'` is what makes two
   * operators resolving the same attempt safe: the loser gets a conflict rather
   * than overwriting the first verdict.
   */
  async resolve(input: {
    orgId: string;
    receiptId: string;
    outcome: 'committed' | 'failed';
    providerRef?: string | undefined;
    operatorId: string;
    note?: string | undefined;
  }): Promise<{ actionId: string; attempt: number }> {
    const [owned] = await this.db
      .select({ id: effectReceipts.id, actionId: effectReceipts.actionId })
      .from(effectReceipts)
      .innerJoin(actions, eq(actions.id, effectReceipts.actionId))
      .where(and(eq(effectReceipts.id, input.receiptId), eq(actions.orgId, input.orgId)))
      .limit(1);
    if (!owned) throw new NotFoundException('effect receipt not found');

    const claimed = await this.db
      .update(effectReceipts)
      .set({
        outcome: input.outcome,
        providerRef: input.providerRef ?? null,
        settledAt: new Date(),
        receipt: {
          ok: input.outcome === 'committed',
          resolved_by_operator: input.operatorId,
          note: input.note ?? null,
        },
      })
      .where(
        and(
          eq(effectReceipts.id, input.receiptId),
          eq(effectReceipts.outcome, 'indeterminate'),
        ),
      )
      .returning({
        actionId: effectReceipts.actionId,
        attempt: effectReceipts.attempt,
      });
    const row = claimed[0];
    if (!row) {
      throw new ConflictException('effect attempt is no longer indeterminate');
    }

    // The action follows the verdict. `settled` is now truthful: a human
    // established what happened, which is exactly what the state means.
    await this.db
      .update(actions)
      .set({
        status: input.outcome === 'committed' ? 'executed' : 'failed',
        dispatchState: 'settled',
        completedAt: new Date(),
      })
      .where(eq(actions.id, row.actionId));

    await this.audit.record({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.operatorId,
      eventType: 'effect.resolved',
      payload: {
        receiptId: input.receiptId,
        actionId: row.actionId,
        attempt: row.attempt,
        outcome: input.outcome,
        providerRef: input.providerRef ?? null,
        note: input.note ?? null,
      },
    });

    this.log.log(
      `effect attempt ${row.attempt} on action ${row.actionId} resolved ` +
        `${input.outcome} by ${input.operatorId}`,
    );
    return row;
  }

  private async nextAttempt(actionId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`coalesce(max(${effectReceipts.attempt}), 0) + 1` })
      .from(effectReceipts)
      .where(eq(effectReceipts.actionId, actionId));
    return Number(row?.n ?? 1);
  }
}
