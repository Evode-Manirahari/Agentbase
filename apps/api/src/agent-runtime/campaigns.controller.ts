import {
  BadRequestException,
  Body,
  Controller,
  forwardRef,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  AgentRunsService,
  BATCH_MAX_LEADS,
  type RunRow,
} from './agent-runs.service.js';
import { EmailsService } from './emails.service.js';
import { JobRegistry } from './job.js';
import { AgentsService } from '../agents/agents.service.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';

const RunCampaignRequest = z.object({
  job_key: z.string().min(1),
  agent_id: z.string().uuid(),
  context: z.record(z.unknown()).default({}),
});
type RunCampaignRequestT = z.infer<typeof RunCampaignRequest>;

const BatchLead = z.object({
  email: z.string().email(),
  notes: z.string().max(2000).optional(),
});

const CreateBatchRequest = z.object({
  job_key: z.string().min(1),
  agent_id: z.string().uuid(),
  leads: z.array(BatchLead).min(1).max(BATCH_MAX_LEADS),
});
type CreateBatchRequestT = z.infer<typeof CreateBatchRequest>;

@Controller('v1/campaigns')
@UseGuards(ClerkAuthGuard)
export class CampaignsController {
  constructor(
    private readonly runs: AgentRunsService,
    private readonly registry: JobRegistry,
    @Inject(forwardRef(() => AgentsService))
    private readonly agents: AgentsService,
    private readonly emails: EmailsService,
  ) {}

  // Lists the jobs registered with the runtime. Used by the dashboard's
  // job picker. Today there's only one (ai-sdr-outbound) but expansion
  // jobs (CRM hygiene, deal-update) will surface here automatically.
  @Get('jobs')
  jobs() {
    const keys = this.registry.keys();
    return {
      items: keys.map((key) => {
        const job = this.registry.get(key);
        return {
          key: job.key,
          label: job.label,
          description: job.description,
          model: job.model,
          tools: job.tools.map((t) => ({
            name: t.name,
            description: t.description,
            dejavas_tool: t.dejavasTool,
          })),
        };
      }),
    };
  }

  // Enqueues a run. Returns immediately with the run row in `pending`
  // status; the worker picks it up, drives the loop, and updates the
  // row to running → (paused | completed | failed). The dashboard polls
  // GET /runs/:id for live status.
  @Post('runs')
  async createRun(
    @Body(new ZodValidationPipe(RunCampaignRequest))
    body: RunCampaignRequestT,
  ): Promise<RunResponse> {
    if (!this.registry.keys().includes(body.job_key)) {
      throw new BadRequestException(`Unknown job: ${body.job_key}`);
    }
    const orgId = await this.agents.ensureDefaultOrg();
    const row = await this.runs.create({
      orgId,
      agentId: body.agent_id,
      jobKey: body.job_key,
      context: body.context,
    });
    return toResponse(row);
  }

  @Get('runs')
  async listRuns(@Query('limit') limit?: string): Promise<{ items: RunResponse[] }> {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = Math.min(Math.max(Number(limit ?? 50), 1), 200);
    const rows = await this.runs.listForOrg(orgId, n);
    return { items: rows.map(toResponse) };
  }

  @Get('runs/:id')
  async getRun(
    @Param('id', new ParseUUIDPipe()) runId: string,
  ): Promise<RunResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    const row = await this.runs.get(orgId, runId);
    return toResponse(row);
  }

  // Enqueues N runs (one per lead) all tagged with the same batchId.
  // Each run executes independently — a pause on one doesn't block
  // the others. The dashboard groups them under /campaigns/batch/:id.
  @Post('batches')
  async createBatch(
    @Body(new ZodValidationPipe(CreateBatchRequest))
    body: CreateBatchRequestT,
  ): Promise<BatchResponse> {
    if (!this.registry.keys().includes(body.job_key)) {
      throw new BadRequestException(`Unknown job: ${body.job_key}`);
    }
    const orgId = await this.agents.ensureDefaultOrg();
    const result = await this.runs.createBatch({
      orgId,
      agentId: body.agent_id,
      jobKey: body.job_key,
      leads: body.leads.map((l) => ({
        email: l.email,
        ...(l.notes ? { notes: l.notes } : {}),
      })),
    });
    return {
      batch_id: result.batch_id,
      run_count: result.run_ids.length,
      run_ids: result.run_ids,
    };
  }

  // Manual "check for replies" trigger. Enqueues a poll scoped to the
  // current org (and optionally a specific run). The poller backfills
  // any newly-discovered gmail.send actions and then checks each
  // tracked thread for replies; if found, it kicks off an
  // ai-reply-handler agent run automatically. The endpoint returns
  // immediately — progress shows up on the dashboard via the existing
  // run-polling loop.
  @Post('runs/:id/check-replies')
  async checkRepliesForRun(
    @Param('id', new ParseUUIDPipe()) runId: string,
  ): Promise<{ enqueued: true; run_id: string }> {
    const orgId = await this.agents.ensureDefaultOrg();
    await this.emails.enqueuePoll({ org_id: orgId, run_id: runId });
    return { enqueued: true, run_id: runId };
  }

  @Post('batches/:id/check-replies')
  async checkRepliesForBatch(
    @Param('id', new ParseUUIDPipe()) batchId: string,
  ): Promise<{ enqueued: true; batch_id: string }> {
    const orgId = await this.agents.ensureDefaultOrg();
    // Batch-level: scope to org and let the poller scan all this org's
    // pending threads. A per-batch filter would require run_id lookups
    // which we skip for v1 simplicity.
    await this.emails.enqueuePoll({ org_id: orgId });
    return { enqueued: true, batch_id: batchId };
  }

  @Get('batches/:id')
  async getBatch(
    @Param('id', new ParseUUIDPipe()) batchId: string,
  ): Promise<BatchDetailResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    const runs = await this.runs.listByBatch(orgId, batchId);
    if (runs.length === 0) {
      // Empty result with a valid UUID could mean either "no such batch"
      // or "batch belongs to another org" — both look the same to the
      // caller, intentionally.
      throw new BadRequestException(
        `batch ${batchId} not found or has no runs`,
      );
    }
    return {
      batch_id: batchId,
      run_count: runs.length,
      runs: runs.map(toResponse),
      status_summary: summarizeBatchStatus(runs),
    };
  }
}

export interface BatchResponse {
  batch_id: string;
  run_count: number;
  run_ids: string[];
}

export interface BatchDetailResponse {
  batch_id: string;
  run_count: number;
  runs: RunResponse[];
  // Cheap status rollup the dashboard uses for the batch-level banner.
  status_summary: {
    pending: number;
    running: number;
    paused: number;
    completed: number;
    failed: number;
  };
}

function summarizeBatchStatus(
  runs: RunRow[],
): BatchDetailResponse['status_summary'] {
  const summary = { pending: 0, running: 0, paused: 0, completed: 0, failed: 0 };
  for (const run of runs) {
    summary[run.status] += 1;
  }
  return summary;
}

// HTTP-facing run shape — strips `messages` (internal LLM conversation state
// used only for resume) and keeps the transcript + status + paused-on
// metadata that the dashboard renders.
export interface RunResponse {
  id: string;
  org_id: string;
  agent_id: string;
  job_key: string;
  context: Record<string, unknown>;
  status: RunRow['status'];
  transcript: RunRow['transcript'];
  paused_on: {
    action_id: string;
    tool_use_id: string;
    dejavas_tool: string;
  } | null;
  usage: RunRow['usage'];
  error: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function toResponse(row: RunRow): RunResponse {
  return {
    id: row.id,
    org_id: row.org_id,
    agent_id: row.agent_id,
    job_key: row.job_key,
    context: row.context,
    status: row.status,
    transcript: row.transcript,
    paused_on:
      row.paused_on_action_id &&
      row.paused_on_tool_use_id &&
      row.paused_on_dejavas_tool
        ? {
            action_id: row.paused_on_action_id,
            tool_use_id: row.paused_on_tool_use_id,
            dejavas_tool: row.paused_on_dejavas_tool,
          }
        : null,
    usage: row.usage,
    error: row.error,
    batch_id: row.batch_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}
