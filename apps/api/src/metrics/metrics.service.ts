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
  rate_limited_count: number;
  top_tools: { tool: string; count: number }[];
  top_agents: { agent_id: string; agent_name: string; count: number }[];
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

    // Single round-trip: 4 parallel aggregations.
    const [statusRows, toolRows, agentRows, rateLimitedRows] = await Promise.all([
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

    return {
      window_hours: windowHours,
      total,
      by_status: byStatus,
      deny_rate,
      failure_rate,
      rate_limited_count,
      top_tools: toolRows.map((r) => ({ tool: r.tool, count: r.count })),
      top_agents: agentRows.map((r) => ({
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        count: r.count,
      })),
      generated_at: new Date().toISOString(),
    };
  }
}
