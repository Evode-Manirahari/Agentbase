import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@agentbase/db';
import { actions, agents } from '@agentbase/db';
import type { ActionStatus } from '@agentbase/shared';

export interface MetricsOverview {
  window_hours: number;
  total: number;
  by_status: Record<ActionStatus, number>;
  deny_rate: number;
  failure_rate: number;
  /**
   * Of approval-required actions that have been decided (not still
   * awaiting), the fraction the human approved. `null` when no
   * approval-required actions have been decided in the window.
   */
  approval_rate: number | null;
  /**
   * Counts feeding `approval_rate`. Surfaces denominator size so callers
   * can decide whether to render the metric at all.
   */
  approval_stats: {
    require_approval_total: number;
    approved: number;
    denied: number;
    pending: number;
  };
  rate_limited_count: number;
  top_tools: { tool: string; count: number }[];
  top_agents: { agent_id: string; agent_name: string; count: number }[];
  /**
   * Top 5 policy rules by hit count in the window, identified by their
   * reason string (the same string surfaced in the audit log). Effect is
   * included so the UI can colour-code require_approval / deny / allow.
   */
  top_policy_rules: {
    reason: string;
    effect: 'allow' | 'require_approval' | 'deny';
    count: number;
  }[];
  generated_at: string;
}

export interface MetricsTimeseries {
  window_hours: number;
  bucket: 'day';
  buckets: string[];
  series: {
    agent_id: string;
    agent_name: string;
    counts: number[];
  }[];
  generated_at: string;
}

const ZERO_BY_STATUS: Record<ActionStatus, number> = {
  pending: 0,
  awaiting_approval: 0,
  approved: 0,
  denied: 0,
  executed: 0,
  failed: 0,
};

@Injectable()
export class MetricsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async overview(orgId: string, windowHours = 24): Promise<MetricsOverview> {
    const since = new Date(Date.now() - windowHours * 3600_000);
    const orgScope = and(eq(actions.orgId, orgId), gte(actions.createdAt, since));

    // Single round-trip: 6 parallel aggregations.
    const [
      statusRows,
      toolRows,
      agentRows,
      rateLimitedRows,
      approvalRows,
      policyRuleRows,
    ] = await Promise.all([
      this.db
        .select({ status: actions.status, count: sql<number>`count(*)::int` })
        .from(actions)
        .where(orgScope)
        .groupBy(actions.status),
      this.db
        .select({ tool: actions.tool, count: sql<number>`count(*)::int` })
        .from(actions)
        .where(orgScope)
        .groupBy(actions.tool)
        .orderBy(desc(sql`count(*)`), asc(actions.tool))
        .limit(5),
      this.db
        .select({
          agent_id: actions.agentId,
          agent_name: agents.name,
          count: sql<number>`count(*)::int`,
        })
        .from(actions)
        .innerJoin(agents, eq(agents.id, actions.agentId))
        .where(orgScope)
        .groupBy(actions.agentId, agents.name)
        .orderBy(desc(sql`count(*)`), asc(agents.name))
        .limit(5),
      // Rate-limited actions are status=failed with result.error.code=rate_limited.
      // We could detect via JSON path but a count of all rows where the result
      // payload has that code is simpler — small windows, small n, fine.
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(actions)
        .where(
          and(
            orgScope,
            sql`${actions.result}->'error'->>'code' = 'rate_limited'`,
          ),
        ),
      // Approval throughput: among actions whose policy required approval,
      // how did each row land? `denied` here means the human (or policy) said
      // no after the gate triggered — we filter by effect=require_approval so
      // pure policy-denies don't leak in.
      this.db
        .select({ status: actions.status, count: sql<number>`count(*)::int` })
        .from(actions)
        .where(
          and(
            orgScope,
            sql`${actions.policyDecision}->>'effect' = 'require_approval'`,
          ),
        )
        .groupBy(actions.status),
      // Top policy rules: group by (reason, effect). Reason is the rule's
      // human-readable label as stored on the action's policy_decision.
      this.db
        .select({
          reason: sql<string>`${actions.policyDecision}->>'reason'`,
          effect: sql<string>`${actions.policyDecision}->>'effect'`,
          count: sql<number>`count(*)::int`,
        })
        .from(actions)
        .where(
          and(
            orgScope,
            sql`${actions.policyDecision}->>'reason' is not null`,
            sql`${actions.policyDecision}->>'effect' is not null`,
          ),
        )
        .groupBy(
          sql`${actions.policyDecision}->>'reason'`,
          sql`${actions.policyDecision}->>'effect'`,
        )
        .orderBy(desc(sql`count(*)`), asc(sql`${actions.policyDecision}->>'reason'`))
        .limit(5),
    ]);

    const byStatus = { ...ZERO_BY_STATUS };
    let total = 0;
    for (const row of statusRows) {
      byStatus[row.status] = row.count;
      total += row.count;
    }

    const deny_rate = total === 0 ? 0 : byStatus.denied / total;
    const failure_rate = total === 0 ? 0 : byStatus.failed / total;
    const rate_limited_count = rateLimitedRows[0]?.count ?? 0;

    // Approval throughput.
    let approvalApproved = 0;
    let approvalDenied = 0;
    let approvalPending = 0;
    for (const row of approvalRows) {
      // Once a human approves, the action moves through approved → executed
      // (or fails downstream). Treat any non-denied, non-pending status as
      // "the human approved this."
      if (row.status === 'awaiting_approval') approvalPending += row.count;
      else if (row.status === 'denied') approvalDenied += row.count;
      else approvalApproved += row.count;
    }
    const approvalDecided = approvalApproved + approvalDenied;
    const approvalRequireTotal =
      approvalApproved + approvalDenied + approvalPending;
    const approval_rate =
      approvalDecided === 0 ? null : approvalApproved / approvalDecided;

    const top_policy_rules = policyRuleRows
      .filter((r) => r.reason !== null && r.effect !== null)
      .map((r) => ({
        reason: r.reason,
        effect: r.effect as 'allow' | 'require_approval' | 'deny',
        count: r.count,
      }));

    return {
      window_hours: windowHours,
      total,
      by_status: byStatus,
      deny_rate,
      failure_rate,
      approval_rate,
      approval_stats: {
        require_approval_total: approvalRequireTotal,
        approved: approvalApproved,
        denied: approvalDenied,
        pending: approvalPending,
      },
      rate_limited_count,
      top_tools: toolRows.map((r) => ({ tool: r.tool, count: r.count })),
      top_agents: agentRows.map((r) => ({
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        count: r.count,
      })),
      top_policy_rules,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Actions per day per agent. Returns a dense matrix:
   *   buckets[]  — sorted ascending UTC day strings (YYYY-MM-DD)
   *   series[].counts[i] — count for series[].agent in buckets[i]
   * Densifying server-side keeps the UI from having to fill gaps.
   */
  async timeseries(
    orgId: string,
    windowHours = 168,
  ): Promise<MetricsTimeseries> {
    const days = Math.min(Math.max(Math.ceil(windowHours / 24), 1), 30);
    // Use UTC day boundaries so callers in different timezones see consistent
    // buckets. The window is the trailing N days *including* today.
    const today = startOfUtcDay(new Date());
    const since = new Date(today.getTime() - (days - 1) * 86400_000);

    const rows = await this.db
      .select({
        bucket: sql<string>`to_char(date_trunc('day', ${actions.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
        agent_id: actions.agentId,
        agent_name: agents.name,
        count: sql<number>`count(*)::int`,
      })
      .from(actions)
      .innerJoin(agents, eq(agents.id, actions.agentId))
      .where(and(eq(actions.orgId, orgId), gte(actions.createdAt, since)))
      .groupBy(
        sql`date_trunc('day', ${actions.createdAt} at time zone 'UTC')`,
        actions.agentId,
        agents.name,
      );

    const buckets: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(since.getTime() + i * 86400_000);
      buckets.push(d.toISOString().slice(0, 10));
    }
    const bucketIndex: Record<string, number> = {};
    buckets.forEach((b, i) => (bucketIndex[b] = i));

    const byAgent = new Map<
      string,
      { agent_id: string; agent_name: string; counts: number[] }
    >();
    for (const row of rows) {
      let entry = byAgent.get(row.agent_id);
      if (!entry) {
        entry = {
          agent_id: row.agent_id,
          agent_name: row.agent_name,
          counts: new Array(days).fill(0) as number[],
        };
        byAgent.set(row.agent_id, entry);
      }
      const i = bucketIndex[row.bucket];
      if (i !== undefined) entry.counts[i] = row.count;
    }
    const series = Array.from(byAgent.values()).sort((a, b) =>
      a.agent_name.localeCompare(b.agent_name),
    );

    return {
      window_hours: windowHours,
      bucket: 'day',
      buckets,
      series,
      generated_at: new Date().toISOString(),
    };
  }
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}
