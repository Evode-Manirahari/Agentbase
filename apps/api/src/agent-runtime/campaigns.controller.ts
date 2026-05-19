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
import { AgentRunsService, type RunRow } from './agent-runs.service.js';
import { JobRegistry } from './job.js';
import { AgentsService } from '../agents/agents.service.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';

const RunCampaignRequest = z.object({
  job_key: z.string().min(1),
  agent_id: z.string().uuid(),
  context: z.record(z.unknown()).default({}),
});
type RunCampaignRequestT = z.infer<typeof RunCampaignRequest>;

@Controller('v1/campaigns')
@UseGuards(ClerkAuthGuard)
export class CampaignsController {
  constructor(
    private readonly runs: AgentRunsService,
    private readonly registry: JobRegistry,
    @Inject(forwardRef(() => AgentsService))
    private readonly agents: AgentsService,
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
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}
