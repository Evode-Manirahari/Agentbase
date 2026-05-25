import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { ActionStatus, PolicyDecision } from '@agentbase/shared';
import { DB } from '../db/db.module.js';
import type { Database } from '@agentbase/db';
import { actions, agentRuns } from '@agentbase/db';
import {
  AGENT_RUN_JOB,
  QUEUE,
  type AgentRunJobData,
} from '../queue/queue.tokens.js';
import type { LlmMessage } from './llm-client.js';
import type { AgentRunInternalResult } from './agent-runtime.service.js';
import type { AgentRunUsage, TranscriptEntry } from './transcript.js';
// LlmMessage is re-exported on RunRow.messages.
export type { LlmMessage };

export interface CreateRunInput {
  orgId: string;
  agentId: string;
  jobKey: string;
  context: Record<string, unknown>;
}

export interface BatchLead {
  email: string;
  notes?: string | undefined;
}

export interface CreateBatchInput {
  orgId: string;
  agentId: string;
  jobKey: string;
  leads: BatchLead[];
}

export interface CreateBatchResult {
  batch_id: string;
  run_ids: string[];
}

// Hard cap on a single batch submission. Lets the demo show "feed 50
// leads in" without enabling batch-spam against the connector layer.
// Larger lists should land via a different ingestion path (CSV import,
// CRM segment trigger) which can rate-limit + paginate.
export const BATCH_MAX_LEADS = 50;

export interface RunRow {
  id: string;
  org_id: string;
  agent_id: string;
  job_key: string;
  context: Record<string, unknown>;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  transcript: TranscriptEntry[];
  messages: LlmMessage[];
  paused_on_action_id: string | null;
  paused_on_tool_use_id: string | null;
  paused_on_agentbase_tool: string | null;
  usage: AgentRunUsage | null;
  error: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ResolvedAction {
  tool_use_id: string;
  action_id: string;
  status: ActionStatus;
  policy_decision: PolicyDecision;
  result?: Record<string, unknown> | undefined;
}

@Injectable()
export class AgentRunsService {
  private readonly log = new Logger(AgentRunsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(QUEUE) private readonly queue: Queue,
  ) {}

  async create(input: CreateRunInput): Promise<RunRow> {
    const [row] = await this.db
      .insert(agentRuns)
      .values({
        orgId: input.orgId,
        agentId: input.agentId,
        jobKey: input.jobKey,
        context: input.context,
        status: 'pending',
      })
      .returning();
    if (!row) throw new Error('failed to create agent run');
    // Fire-and-forget enqueue. If Redis is unavailable the run stays
    // pending; the next worker boot picks it up via re-poll (PR 4) or
    // an operator can retry from the dashboard.
    await this.enqueue({ run_id: row.id, mode: 'start' });
    return toRunRow(row);
  }

  // Fans one batch submission out into N agent runs, all tagged with
  // the same batchId so the dashboard can show per-lead progress
  // grouped under one governed batch. Each run executes independently
  // through the worker; a pause on one doesn't block the others.
  async createBatch(input: CreateBatchInput): Promise<CreateBatchResult> {
    if (input.leads.length === 0) {
      throw new Error('createBatch requires at least one lead');
    }
    if (input.leads.length > BATCH_MAX_LEADS) {
      throw new Error(
        `batch size ${input.leads.length} exceeds limit ${BATCH_MAX_LEADS}`,
      );
    }
    const batchId = randomUUID();
    const rows = await this.db.transaction(async (tx) => {
      const inserted: { id: string }[] = [];
      for (const lead of input.leads) {
        const [row] = await tx
          .insert(agentRuns)
          .values({
            orgId: input.orgId,
            agentId: input.agentId,
            jobKey: input.jobKey,
            context: {
              email: lead.email,
              ...(lead.notes ? { notes: lead.notes } : {}),
            },
            status: 'pending',
            batchId,
          })
          .returning({ id: agentRuns.id });
        if (row) inserted.push(row);
      }
      return inserted;
    });
    for (const row of rows) {
      await this.enqueue({ run_id: row.id, mode: 'start' });
    }
    return { batch_id: batchId, run_ids: rows.map((r) => r.id) };
  }

  async listByBatch(orgId: string, batchId: string): Promise<RunRow[]> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.batchId, batchId)))
      .orderBy(asc(agentRuns.createdAt));
    return rows.map(toRunRow);
  }

  async get(orgId: string, runId: string): Promise<RunRow> {
    const [row] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException(`agent run ${runId} not found`);
    return toRunRow(row);
  }

  async listForOrg(orgId: string, limit = 50): Promise<RunRow[]> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.orgId, orgId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map(toRunRow);
  }

  // Worker-side: claim the run for processing. Marks status=running.
  async markRunning(runId: string): Promise<RunRow | null> {
    const [row] = await this.db
      .update(agentRuns)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(agentRuns.id, runId))
      .returning();
    return row ? toRunRow(row) : null;
  }

  // Worker-side: write a terminal or paused result back to the row,
  // including the conversation messages so a future resume can pick up
  // exactly where the loop left off without re-running prior tools.
  async persistResult(
    runId: string,
    result: AgentRunInternalResult,
  ): Promise<void> {
    const dbStatus =
      result.status === 'completed'
        ? 'completed'
        : result.status === 'paused'
          ? 'paused'
          : 'failed';
    await this.db
      .update(agentRuns)
      .set({
        status: dbStatus,
        transcript: result.transcript as unknown[],
        messages: result.messages as unknown[],
        usage: (result.usage as unknown as Record<string, number>) ?? null,
        pausedOnActionId: result.paused_on?.action_id ?? null,
        pausedOnToolUseId: result.paused_on?.tool_use_id ?? null,
        pausedOnAgentbaseTool: result.paused_on?.agentbase_tool ?? null,
        error: result.error ?? null,
        completedAt: dbStatus === 'paused' ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));
  }

  // Called by ApprovalsService after an action transitions out of
  // awaiting_approval. Enqueues a resume job for any run paused on that
  // action. Fire-and-forget — a queue hiccup must not block the
  // approval response.
  async notifyActionResolved(actionId: string): Promise<void> {
    try {
      const paused = await this.db
        .select()
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.pausedOnActionId, actionId),
            eq(agentRuns.status, 'paused'),
          ),
        );
      for (const row of paused) {
        await this.enqueue({ run_id: row.id, mode: 'resume' });
      }
    } catch (err) {
      this.log.warn(
        `failed to enqueue resume for action ${actionId}: ${(err as Error).message}`,
      );
    }
  }

  // Worker-side: looks up the action's final state so the runtime can
  // rebuild the tool_result block for the paused tool_use.
  async resolveAction(
    orgId: string,
    actionId: string,
    toolUseId: string,
  ): Promise<ResolvedAction | null> {
    const [row] = await this.db
      .select()
      .from(actions)
      .where(and(eq(actions.id, actionId), eq(actions.orgId, orgId)))
      .limit(1);
    if (!row) return null;
    if (row.status === 'awaiting_approval' || row.status === 'pending') {
      // Action hasn't actually resolved yet — leave the run paused.
      return null;
    }
    const policyDecision =
      (row.policyDecision as PolicyDecision | null) ?? null;
    return {
      tool_use_id: toolUseId,
      action_id: row.id,
      status: row.status,
      policy_decision:
        policyDecision ?? {
          effect: 'allow',
          reason: null,
          rule_index: null,
          rule_matched: null,
          approver_role: null,
          policy_id: null,
          fallback: false,
        },
      result: (row.result as Record<string, unknown> | null) ?? undefined,
    };
  }

  private async enqueue(data: AgentRunJobData): Promise<void> {
    await this.queue.add(AGENT_RUN_JOB, data, {
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 200,
    });
  }
}

function toRunRow(row: typeof agentRuns.$inferSelect): RunRow {
  return {
    id: row.id,
    org_id: row.orgId,
    agent_id: row.agentId,
    job_key: row.jobKey,
    context: row.context,
    status: row.status as RunRow['status'],
    transcript: (row.transcript as TranscriptEntry[]) ?? [],
    messages: (row.messages as LlmMessage[]) ?? [],
    paused_on_action_id: row.pausedOnActionId,
    paused_on_tool_use_id: row.pausedOnToolUseId,
    paused_on_agentbase_tool: row.pausedOnAgentbaseTool,
    usage: (row.usage as AgentRunUsage | null) ?? null,
    error: row.error,
    batch_id: row.batchId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    completed_at: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
