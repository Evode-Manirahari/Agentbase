import {
  BadRequestException,
  Body,
  Controller,
  forwardRef,
  Get,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from 'nestjs-zod';
import { AgentRuntimeService } from './agent-runtime.service.js';
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
    private readonly runtime: AgentRuntimeService,
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

  // Synchronously runs one job. PR 2 keeps this in-request — the caller
  // waits ~10–60s while Claude reasons + tools dispatch. PR 3 will move
  // this behind a job queue with persistence and polling so long runs
  // don't tie up the HTTP request.
  @Post('runs')
  async run(
    @Body(new ZodValidationPipe(RunCampaignRequest))
    body: RunCampaignRequestT,
  ) {
    if (!this.registry.keys().includes(body.job_key)) {
      throw new BadRequestException(`Unknown job: ${body.job_key}`);
    }
    const orgId = await this.agents.ensureDefaultOrg();
    return this.runtime.runJob({
      jobKey: body.job_key,
      orgId,
      agentId: body.agent_id,
      context: body.context,
    });
  }
}
