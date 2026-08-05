import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, lt, ne } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Action, Database } from '@agentbase/db';
import { actions, agents, approvals } from '@agentbase/db';
import { AuditService } from '../audit/audit.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { ConnectorRegistry } from '../connectors/connector-registry.js';
import { SlackService } from '../slack/slack.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { EffectDispatcher } from './effect-dispatcher.service.js';
import { EffectReceiptsService } from './effect-receipts.service.js';
import { requestHash } from './effect-commit.js';
import type { Connector } from '@agentbase/connector-hubspot';
import type {
  ActionStatus,
  EffectClassName,
  PolicyDecision,
} from '@agentbase/shared';

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

// How long a provider idempotency key stays good. Stripe's window is 24 hours
// and it is the shortest of the majors, so we take it as the bound. Past it,
// re-sending the same key is a NEW request to the provider — the retry looks
// at-most-once to us and is not.
const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExecuteInput {
  orgId: string;
  agentId: string;
  tool: string;
  params: Record<string, unknown>;
  idempotencyKey?: string | undefined;
}

interface EffectAssessmentOutcome {
  // True only when an assessor existed and threw. A connector with no assessor
  // is `failed: false, effect: null` — not knowing is fine, being unable to
  // find out is not.
  failed: boolean;
  // `summary` is carried for humans, not for policy: it is what the approval
  // card shows a reviewer ("Publishes a package to a public registry").
  effect: {
    effectClass: EffectClassName;
    reversible: boolean;
    summary: string;
  } | null;
}

export interface ExecuteOutput {
  action_id: string;
  status: ActionStatus;
  result?: Record<string, unknown> | undefined;
  policy_decision: PolicyDecision;
}

@Injectable()
export class ActionsService {
  private readonly log = new Logger(ActionsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly policy: PolicyService,
    private readonly connectors: ConnectorRegistry,
    private readonly slack: SlackService,
    private readonly rateLimit: RateLimitService,
    private readonly effects: EffectDispatcher,
    private readonly receipts: EffectReceiptsService,
  ) {}

  async execute(input: ExecuteInput): Promise<ExecuteOutput> {
    // Idempotency fast path: if this (org, agent, key) tuple was already
    // processed, return the stored outcome instead of re-evaluating policy and
    // re-calling the connector. This read is an optimisation, not the
    // guarantee — the guarantee is the reservation in reserveAction(), which
    // claims the key before the connector is invoked. Idempotent replays
    // bypass the rate limiter: the original request already paid the cost.
    if (input.idempotencyKey) {
      const cached = await this.findByIdempotencyKey(
        input.orgId,
        input.agentId,
        input.idempotencyKey,
      );
      if (cached) {
        this.log.debug(
          `idempotency hit org=${input.orgId} agent=${input.agentId} key=${input.idempotencyKey}`,
        );
        return cached;
      }
    }

    // Rate limit gate: block runaway agents before they reach the connector.
    const rl = await this.rateLimit.check({
      orgId: input.orgId,
      agentId: input.agentId,
      tool: input.tool,
    });
    if (!rl.ok) {
      const decision: PolicyDecision = {
        effect: 'allow',
        reason: null,
        rule_index: null,
        rule_matched: null,
        approver_role: null,
        policy_id: null,
        fallback: false,
      };
      const storedResult = {
        ok: false,
        error: {
          code: 'rate_limited',
          message: `${rl.scope}-scope limit of ${rl.limit}/min exceeded`,
          retry_after_sec: rl.retry_after_sec,
          scope: rl.scope,
        },
      };
      const recorded = await this.recordAction(
        input,
        'failed',
        decision,
        storedResult,
      );
      if (recorded.conflict) return recorded.conflict;
      const action = recorded.action;
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'agent',
        actorId: input.agentId,
        eventType: 'action.rate_limited',
        payload: {
          actionId: action.id,
          tool: input.tool,
          scope: rl.scope,
          limit: rl.limit,
        },
      });
      return {
        action_id: action.id,
        status: 'failed',
        result: storedResult,
        policy_decision: decision,
      };
    }

    // Grade the action BEFORE policy runs, so a rule can say "anything
    // irreversible needs approval" instead of enumerating every tool that
    // might be. Resolution is a local lookup — it reaches no provider — so
    // doing it here costs nothing the deny path would not already pay.
    const graded = await this.assessEffect(input.orgId, input.tool, input.params);

    // An assessment that threw is not the same as a connector that cannot
    // classify. We were told nothing about an action we were supposed to be
    // able to grade, so we do not dispatch it — regardless of what the policy
    // default happens to be.
    if (graded.failed) {
      const decision: PolicyDecision = {
        effect: 'deny',
        reason: 'effect assessment failed — cannot determine what this action does',
        rule_index: null,
        rule_matched: null,
        approver_role: null,
        policy_id: null,
        fallback: true,
      };
      const recorded = await this.recordAction(
        input,
        'denied',
        decision,
        null,
        graded.effect,
      );
      if (recorded.conflict) return recorded.conflict;
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'system',
        actorId: 'effect_gate',
        eventType: 'action.assessment_failed',
        payload: { actionId: recorded.action.id, tool: input.tool },
      });
      return {
        action_id: recorded.action.id,
        status: 'denied',
        policy_decision: decision,
      };
    }

    const decision = await this.policy.evaluate(input.orgId, {
      tool: input.tool,
      params: input.params,
      agentId: input.agentId,
      effect: graded.effect,
    });

    if (decision.effect === 'deny') {
      const recorded = await this.recordAction(
        input,
        'denied',
        decision,
        null,
        graded.effect,
      );
      if (recorded.conflict) return recorded.conflict;
      const action = recorded.action;
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'agent',
        actorId: input.agentId,
        eventType: 'action.denied',
        payload: {
          actionId: action.id,
          tool: input.tool,
          decision,
          effect: graded.effect,
        },
      });
      return { action_id: action.id, status: 'denied', policy_decision: decision };
    }

    if (decision.effect === 'require_approval') {
      const recorded = await this.recordAction(
        input,
        'awaiting_approval',
        decision,
        null,
        graded.effect,
      );
      // Losing the key race here is the case that used to double-post: the
      // winner already has an approval row and a Slack card for this action.
      if (recorded.conflict) return recorded.conflict;
      const action = recorded.action;
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
      const [approval] = await this.db
        .insert(approvals)
        .values({
          actionId: action.id,
          requiredRole: decision.approver_role ?? 'approver',
          decision: 'pending',
          expiresAt,
        })
        .returning();
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'agent',
        actorId: input.agentId,
        eventType: 'action.awaiting_approval',
        payload: {
          actionId: action.id,
          tool: input.tool,
          decision,
          effect: graded.effect,
        },
      });

      if (approval && this.slack.isConfigured()) {
        const agentName = await this.lookupAgentName(input.agentId);
        const channelOverride = decision.rule_matched?.slack_channel ?? null;
        const card = await this.slack.postApprovalCard({
          approvalId: approval.id,
          agentName,
          tool: input.tool,
          params: input.params,
          reason: decision.reason ?? null,
          expiresAt,
          channelOverride,
          // The grade the gate already computed. Recomputing it here would
          // risk the card describing something other than what was decided on.
          effect: graded.effect
            ? {
                effectClass: graded.effect.effectClass,
                reversible: graded.effect.reversible,
                summary: graded.effect.summary,
              }
            : null,
        });
        if (card) {
          await this.db
            .update(approvals)
            .set({ slackChannel: card.channel, slackTs: card.ts })
            .where(eq(approvals.id, approval.id));
          await this.audit.record({
            orgId: input.orgId,
            actorType: 'system',
            actorId: 'slack',
            eventType: 'approval.posted_to_slack',
            payload: {
              approvalId: approval.id,
              actionId: action.id,
              channel: card.channel,
              channel_override_used: channelOverride,
              ts: card.ts,
            },
          });
        }
      }

      return {
        action_id: action.id,
        status: 'awaiting_approval',
        policy_decision: decision,
      };
    }

    // effect === 'allow' — dispatch to a connector.
    //
    // Reserve first, invoke second. The row (and with it the unique
    // idempotency key) is claimed BEFORE any external call, so a concurrent
    // request carrying the same key loses the race at the database and never
    // reaches the connector. Claiming it afterwards — which is what this code
    // used to do — deduplicates the record of the send but not the send.
    const reservation = await this.reserveAction(input, decision, graded.effect);
    if (reservation.conflict) {
      this.log.debug(
        `idempotency reservation lost org=${input.orgId} agent=${input.agentId} key=${input.idempotencyKey} — no connector call made`,
      );
      return reservation.conflict;
    }
    // The reservation already persisted `in_flight` + `dispatchedAt`. If the
    // process dies anywhere below, the sweeper promotes the row to `unknown`
    // rather than retrying it — see reconcileStaleDispatches().
    const action = reservation.action;

    const connector = await this.resolveConnector(input.orgId, input.tool);
    const dispatched = await this.effects.dispatch({
      actionId: action.id,
      tool: input.tool,
      params: input.params,
      // The allow path had no approval, so there is no approved hash to bind
      // against — the request was never shown to a human.
      approvedRequestHash: null,
      connector,
    });
    const result = dispatched.result;

    const finalStatus: ActionStatus = result.ok ? 'executed' : 'failed';
    const storedResult = result.ok
      ? { ok: true, data: result.data ?? null }
      : { ok: false, error: result.error ?? { code: 'unknown', message: 'unknown error' } };

    await this.db
      .update(actions)
      .set({
        status: finalStatus,
        result: storedResult,
        dispatchState: 'settled',
        completedAt: new Date(),
      })
      .where(eq(actions.id, action.id));

    await this.audit.record({
      orgId: input.orgId,
      actorType: 'agent',
      actorId: input.agentId,
      eventType: result.ok ? 'action.executed' : 'action.failed',
      payload: {
        actionId: action.id,
        tool: input.tool,
        decision,
        connector: dispatched.connectorName,
        ok: result.ok,
        error: result.ok ? null : result.error ?? null,
        idempotency_key_sent: dispatched.idempotencyKeySent,
        replayed: dispatched.replayed,
      },
    });

    return {
      action_id: action.id,
      status: finalStatus,
      result: storedResult,
      policy_decision: decision,
    };
  }

  // Operator-initiated retry of a previously-failed action. Re-uses the stored
  // policy decision (operators are explicitly vouching for the retry; if they
  // wanted re-evaluation they'd change the policy first). Re-checks the rate
  // limit so retries can't bypass throttling. Updates the row in place — the
  // audit log is the history of attempts, the action row is the current state.
  async retry(input: {
    orgId: string;
    actionId: string;
    operatorId: string;
  }): Promise<ExecuteOutput> {
    const [original] = await this.db
      .select()
      .from(actions)
      .where(
        and(eq(actions.id, input.actionId), eq(actions.orgId, input.orgId)),
      )
      .limit(1);
    if (!original) {
      throw new NotFoundException(`action ${input.actionId} not found`);
    }
    if (original.status !== 'failed') {
      throw new ConflictException(
        `cannot retry action with status='${original.status}' — only 'failed' is retryable`,
      );
    }
    const decision =
      (original.policyDecision as unknown as PolicyDecision | null) ?? null;
    if (!decision || decision.effect !== 'allow') {
      throw new ConflictException(
        `cannot retry: original policy decision was '${decision?.effect ?? 'null'}' — change the policy and have the agent re-attempt`,
      );
    }

    // `dispatch_state = 'unknown'` means we sent something and never learned
    // its fate. The sweeper marks such rows `failed`, which made them look
    // retryable — but "failed" here means "we do not know", not "nothing
    // happened". Re-sending is only safe if the provider will collapse the two
    // requests; otherwise this button is how one deployment becomes two.
    //
    // The escape hatch is not a force flag. It is resolving the effect:
    // POST /v1/effects/:receiptId/resolve, where a human records what they
    // actually found at the provider.
    if (original.dispatchState === 'unknown') {
      const connector = await this.resolveConnector(input.orgId, original.tool);
      // Both inputs come from the FIRST attempt, not from live state.
      //
      // `actions.dispatched_at` is overwritten by the retry claim below, so
      // measuring against it lets a retry at hour 23 restart the clock and a
      // retry at hour 30 slip through a 24h check the provider already
      // expired. Asking the connector for its mode now is no better: it can
      // have been changed since. Attempt 1 is immutable and is what actually
      // governed the effect.
      const first = await this.receipts.firstAttempt(input.actionId);
      const mode =
        first?.idempotencyMode ??
        // No recorded attempt means nothing was ever dispatched through the
        // protocol, so there is no evidence of an in-flight effect to protect —
        // fall back to asking the connector, still pessimistically.
        connector?.idempotency?.(
          original.tool,
          original.params as Record<string, unknown>,
        ) ??
        'none';
      // A `key` mode retry is only safe inside the provider's dedupe window.
      // Outside it, the key no longer collapses anything and the retry is a
      // fresh effect — the same duplicate this guard exists to prevent, just
      // slower to arrive.
      const dispatchedAt =
        first?.startedAt?.getTime() ?? original.dispatchedAt?.getTime() ?? 0;
      const keyExpired =
        mode === 'key' && Date.now() - dispatchedAt > IDEMPOTENCY_KEY_TTL_MS;
      if (keyExpired) {
        throw new ConflictException(
          `cannot retry action ${input.actionId}: its dispatch outcome is unknown and the ` +
            `provider idempotency key is older than ${IDEMPOTENCY_KEY_TTL_MS / 3_600_000}h, ` +
            `so re-sending would be a new request rather than a deduplicated one. ` +
            `Resolve the effect receipt with what you find at the provider instead.`,
        );
      }
      if (mode === 'none') {
        throw new ConflictException(
          `cannot retry action ${input.actionId}: its dispatch outcome is unknown and ` +
            `${connector?.name ?? 'this connector'} does not support idempotent retry of ` +
            `'${original.tool}'. The effect may already exist. Resolve the effect receipt ` +
            `with what you find at the provider instead of re-sending.`,
        );
      }
    }

    const rl = await this.rateLimit.check({
      orgId: input.orgId,
      agentId: original.agentId,
      tool: original.tool,
    });
    if (!rl.ok) {
      const errorResult = {
        ok: false,
        error: {
          code: 'rate_limited',
          message: `${rl.scope}-scope limit of ${rl.limit}/min exceeded`,
          retry_after_sec: rl.retry_after_sec,
          scope: rl.scope,
        },
      };
      await this.db
        .update(actions)
        .set({ result: errorResult, completedAt: new Date() })
        .where(eq(actions.id, input.actionId));
      await this.audit.record({
        orgId: input.orgId,
        actorType: 'user',
        actorId: input.operatorId,
        eventType: 'action.retried_rate_limited',
        payload: {
          actionId: input.actionId,
          tool: original.tool,
          scope: rl.scope,
          limit: rl.limit,
        },
      });
      return {
        action_id: input.actionId,
        status: 'failed',
        result: errorResult,
        policy_decision: decision,
      };
    }

    // Claim the retry before dispatching. Two operators clicking Retry on the
    // same failed action must produce one connector call, not two — the
    // conditional update is the claim, and losing it means someone else is
    // already in flight.
    const claimed = await this.db
      .update(actions)
      .set({ dispatchState: 'in_flight', dispatchedAt: new Date() })
      .where(
        and(
          eq(actions.id, input.actionId),
          eq(actions.status, 'failed'),
          ne(actions.dispatchState, 'in_flight'),
        ),
      )
      .returning({ id: actions.id });
    if (claimed.length === 0) {
      throw new ConflictException(
        `action ${input.actionId} is already being retried`,
      );
    }

    const connector = await this.resolveConnector(input.orgId, original.tool);
    // The retry goes through the same commit protocol: it opens a NEW attempt
    // row, and it carries the SAME provider idempotency key as the original
    // (derived from the action id). A provider that honours the key collapses
    // the two into one effect — which is what makes retrying a failed action
    // safe even though we cannot always tell why it failed.
    const dispatched = await this.effects.dispatch({
      actionId: input.actionId,
      tool: original.tool,
      params: original.params as Record<string, unknown>,
      approvedRequestHash: original.requestHash,
      connector,
    });
    const result = dispatched.result;

    const newStatus: ActionStatus = result.ok ? 'executed' : 'failed';
    const storedResult = result.ok
      ? { ok: true, data: result.data ?? null }
      : { ok: false, error: result.error ?? { code: 'unknown', message: 'unknown error' } };

    await this.db
      .update(actions)
      .set({
        status: newStatus,
        result: storedResult,
        dispatchState: 'settled',
        completedAt: new Date(),
      })
      .where(eq(actions.id, input.actionId));

    await this.audit.record({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.operatorId,
      eventType: 'action.retried',
      payload: {
        actionId: input.actionId,
        tool: original.tool,
        previous_status: 'failed',
        new_status: newStatus,
        connector: connector?.name ?? null,
        ok: result.ok,
        error: result.ok ? null : result.error ?? null,
      },
    });

    return {
      action_id: input.actionId,
      status: newStatus,
      result: storedResult,
      policy_decision: decision,
    };
  }

  private async lookupAgentName(agentId: string): Promise<string> {
    const rows = await this.db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    return rows[0]?.name ?? agentId;
  }

  /**
   * Ask the resolving connector what this call will consequentially do.
   * Connectors that cannot say return null, and the policy engine treats a
   * missing assessment as a non-match rather than a wildcard — see
   * effectMatches().
   */
  private async assessEffect(
    orgId: string,
    tool: string,
    params: Record<string, unknown>,
  ): Promise<EffectAssessmentOutcome> {
    try {
      const connector = (await this.resolveConnector(orgId, tool)) as
        | (Connector & {
            assess?: (p: Record<string, unknown>) => {
              effectClass: EffectClassName;
              reversible: boolean;
              summary?: string;
            } | null;
          })
        | null;
      const a = connector?.assess?.(params);
      // No assessor at all is not a failure — most connectors cannot classify,
      // and effect-scoped rules simply do not apply to them.
      return {
        failed: false,
        effect: a
          ? {
              effectClass: a.effectClass,
              reversible: a.reversible,
              summary: a.summary ?? a.effectClass,
            }
          : null,
      };
    } catch (err) {
      // A classifier that THREW is different: something that was supposed to
      // tell us what this action does could not. Returning "no assessment"
      // here would be an authorization bypass on an org whose policy default
      // is `allow` — the effect-scoped require_approval rule silently stops
      // matching and the action dispatches unreviewed. So this is reported as
      // a distinct failure and the caller denies.
      this.log.error(
        `effect assessment threw for ${tool} — denying rather than dispatching ` +
          `an action whose consequences could not be determined: ${(err as Error).message}`,
      );
      return { failed: true, effect: null };
    }
  }

  private async resolveConnector(orgId: string, tool: string) {
    const registry = this.connectors as ConnectorRegistry & {
      resolveForOrg?: (orgId: string, tool: string) => Promise<Connector | null>;
    };
    return registry.resolveForOrg
      ? registry.resolveForOrg(orgId, tool)
      : registry.resolve(tool);
  }

  // External-agent polling: a third-party agent that got `awaiting_approval`
  // on /v1/actions/execute calls this to learn when the human decided. Scoped
  // to the agent's org so one tenant cannot read another's action state.
  async getForOrg(orgId: string, actionId: string): Promise<ExecuteOutput | null> {
    const [row] = await this.db
      .select({
        id: actions.id,
        status: actions.status,
        result: actions.result,
        policyDecision: actions.policyDecision,
      })
      .from(actions)
      .where(and(eq(actions.orgId, orgId), eq(actions.id, actionId)))
      .limit(1);
    if (!row) return null;
    return {
      action_id: row.id,
      status: row.status,
      result: (row.result ?? undefined) as Record<string, unknown> | undefined,
      policy_decision: row.policyDecision as unknown as PolicyDecision,
    };
  }

  /**
   * Re-run an action through the dispatcher in REPLAY mode, serving the
   * recorded receipt instead of contacting anyone.
   *
   * This exists because replay had no reachable path. Every production caller
   * of dispatch() hands it an action with no committed receipt yet — a fresh
   * execute, an approval, or a retry (which only accepts `failed` actions,
   * while replay only serves `committed` receipts). The capability was real at
   * the dispatcher and unreachable through the API, which made "replay returns
   * the recorded receipt" true of the code and false of the product.
   *
   * Refuses outright unless the process is in replay mode. That is what makes
   * it safe by construction rather than by discipline: there is no argument a
   * caller can pass that turns this into a live dispatch, because the
   * dispatcher itself is incapable of reaching a provider while the mode is on.
   */
  async replayForOrg(orgId: string, actionId: string) {
    if (!this.effects.isReplay()) {
      throw new ConflictException(
        'replay is only available when the process is running with AGENTBASE_REPLAY=1 — ' +
          'refusing, because outside replay mode this would be a live dispatch',
      );
    }

    const [original] = await this.db
      .select()
      .from(actions)
      .where(and(eq(actions.id, actionId), eq(actions.orgId, orgId)))
      .limit(1);
    if (!original) {
      throw new NotFoundException(`action ${actionId} not found`);
    }

    const dispatched = await this.effects.dispatch({
      actionId,
      tool: original.tool,
      params: original.params as Record<string, unknown>,
      approvedRequestHash: original.requestHash,
      // The connector is irrelevant in replay — the dispatcher never reaches
      // it — but passing null makes that explicit rather than incidental.
      connector: null,
    });

    return {
      action_id: actionId,
      tool: original.tool,
      replayed: dispatched.replayed,
      result: dispatched.result,
      connector: dispatched.connectorName,
      idempotency_mode: dispatched.idempotencyMode,
    };
  }

  async listForOrg(orgId: string, limit = 100) {
    const rows = await this.db
      .select({
        id: actions.id,
        agentId: actions.agentId,
        agentName: agents.name,
        tool: actions.tool,
        params: actions.params,
        status: actions.status,
        // `status` alone is misleading for the case that matters most. The
        // sweeper marks a never-settled dispatch `failed`, and on a review
        // screen "failed" reads as "it did not happen" — when the truth is
        // that nobody knows. dispatch_state is what distinguishes them.
        dispatchState: actions.dispatchState,
        effectAssessment: actions.effectAssessment,
        policyDecision: actions.policyDecision,
        result: actions.result,
        createdAt: actions.createdAt,
        completedAt: actions.completedAt,
      })
      .from(actions)
      .innerJoin(agents, eq(agents.id, actions.agentId))
      .where(eq(actions.orgId, orgId))
      .orderBy(desc(actions.createdAt))
      .limit(limit);
    return {
      items: rows.map((r) => ({
        id: r.id,
        agent_id: r.agentId,
        agent_name: r.agentName,
        tool: r.tool,
        params: r.params,
        status: r.status,
        dispatch_state: r.dispatchState,
        effect_assessment: r.effectAssessment,
        policy_decision: r.policyDecision,
        result: r.result,
        created_at: r.createdAt.toISOString(),
        completed_at: r.completedAt?.toISOString() ?? null,
      })),
    };
  }

  // Claim the idempotency key before any external call. Returns either the
  // reserved row (we own this key, proceed to dispatch) or the outcome of the
  // request that beat us (we made no connector call at all).
  private async reserveAction(
    input: ExecuteInput,
    decision: PolicyDecision,
    effect: EffectAssessmentOutcome['effect'] = null,
  ): Promise<
    | { action: Action; conflict: null }
    | { action: null; conflict: ExecuteOutput }
  > {
    try {
      const [created] = await this.db
        .insert(actions)
        .values({
          orgId: input.orgId,
          agentId: input.agentId,
          tool: input.tool,
          params: input.params,
          status: 'pending',
          policyDecision: decision as unknown as Record<string, unknown>,
          result: null,
          idempotencyKey: input.idempotencyKey ?? null,
          requestHash: requestHash(input.tool, input.params),
          effectAssessment: effect,
          // `in_flight` is claimed in the same insert as the key, not in a
          // follow-up update. Two statements would leave a window where a crash
          // strands the row at `not_dispatched`: the sweeper only looks at
          // `in_flight`, and retry() only accepts `failed`, so nothing would
          // ever resolve it and same-key replays would return `pending` forever.
          // Marking it in-flight a moment before the call is the conservative
          // error: the worst case is an action reported `unknown` whose effect
          // never happened, and `unknown` is never auto-retried.
          dispatchState: 'in_flight',
          dispatchedAt: new Date(),
          completedAt: null,
        })
        .returning();
      if (!created) throw new Error('failed to reserve action');
      return { action: created, conflict: null };
    } catch (err) {
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.findByIdempotencyKey(
          input.orgId,
          input.agentId,
          input.idempotencyKey,
        );
        // The winner may still be mid-flight, in which case `status` is
        // 'pending' and the caller should poll rather than assume success.
        if (existing) return { action: null, conflict: existing };
      }
      throw err;
    }
  }

  // A dispatch that never settled means the process died between "we called
  // the connector" and "we recorded what it said". The external effect may
  // have landed or may not have. We mark it `unknown` and stop — we do not
  // retry, because retrying an unknown send is how a customer gets two emails.
  // Resolving it requires either a provider-side lookup or a human.
  async reconcileStaleDispatches(olderThanMs = 5 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await this.db
      .update(actions)
      .set({
        status: 'failed',
        dispatchState: 'unknown',
        result: {
          ok: false,
          error: {
            code: 'dispatch_unknown',
            message:
              'dispatch started but never settled; the external effect may or may not have occurred. Not retried automatically.',
          },
        },
        completedAt: new Date(),
      })
      .where(
        and(
          eq(actions.dispatchState, 'in_flight'),
          lt(actions.dispatchedAt, cutoff),
        ),
      )
      .returning({ id: actions.id, orgId: actions.orgId, tool: actions.tool });

    for (const row of stale) {
      await this.audit.record({
        orgId: row.orgId,
        actorType: 'system',
        actorId: 'dispatch_reconciler',
        eventType: 'action.dispatch_unknown',
        payload: { actionId: row.id, tool: row.tool },
      });
    }
    if (stale.length > 0) {
      this.log.warn(
        `${stale.length} action(s) marked dispatch_state=unknown — external effect indeterminate`,
      );
    }
    return stale.length;
  }

  // The non-dispatching counterpart to reserveAction(): used by the deny,
  // require_approval, and rate-limited paths, none of which call a connector.
  // Like reserveAction() it reports whether it lost an idempotency race, because
  // losing still matters here — the caller must not go on to insert a second
  // approval, post a second Slack card, or emit an audit event describing a row
  // it did not create.
  private async recordAction(
    input: ExecuteInput,
    status: ActionStatus,
    decision: PolicyDecision,
    result: Record<string, unknown> | null,
    effect: EffectAssessmentOutcome['effect'] = null,
  ): Promise<
    { action: Action; conflict: null } | { action: null; conflict: ExecuteOutput }
  > {
    try {
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
          // Set here too, not only on the allow path: the require_approval
          // branch runs through recordAction, and that is precisely the action
          // whose hash a human will later be bound to.
          requestHash: requestHash(input.tool, input.params),
          effectAssessment: effect,
          completedAt:
            status === 'executed' || status === 'denied' || status === 'failed'
              ? new Date()
              : null,
        })
        .returning();
      if (!created) throw new Error('failed to record action');
      return { action: created, conflict: null };
    } catch (err) {
      // A concurrent request claimed the same idempotency key. Return the
      // winner's stored outcome so the client sees a coherent response rather
      // than a 500 — and so the caller stops before duplicating this action's
      // approval, Slack card, or audit trail.
      if (input.idempotencyKey && isUniqueViolation(err)) {
        const existing = await this.findByIdempotencyKey(
          input.orgId,
          input.agentId,
          input.idempotencyKey,
        );
        if (existing) {
          this.log.debug(
            `idempotency record lost org=${input.orgId} agent=${input.agentId} key=${input.idempotencyKey} — no duplicate approval or audit emitted`,
          );
          return { action: null, conflict: existing };
        }
      }
      throw err;
    }
  }

  private async findByIdempotencyKey(
    orgId: string,
    agentId: string,
    key: string,
  ): Promise<ExecuteOutput | null> {
    const row = await this.findActionRowByIdempotencyKey(orgId, agentId, key);
    if (!row) return null;
    const out: ExecuteOutput = {
      action_id: row.id,
      status: row.status,
      policy_decision: (row.policyDecision ?? {
        effect: 'allow',
        reason: null,
        rule_index: null,
        rule_matched: null,
        approver_role: null,
        policy_id: null,
        fallback: true,
      }) as unknown as PolicyDecision,
    };
    if (row.result !== null && row.result !== undefined) {
      out.result = row.result as Record<string, unknown>;
    }
    return out;
  }

  private async findActionRowByIdempotencyKey(
    orgId: string,
    agentId: string,
    key: string,
  ) {
    const [row] = await this.db
      .select()
      .from(actions)
      .where(
        and(
          eq(actions.orgId, orgId),
          eq(actions.agentId, agentId),
          eq(actions.idempotencyKey, key),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === '23505';
}
