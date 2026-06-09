import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ExecuteActionRequest,
  type ExecuteActionRequest as ExecuteActionRequestT,
  type ExecuteActionResponse,
} from '@agentbase/shared';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { ActionsService } from './actions.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { clampQueryInt } from '../common/query-int.js';

const HubspotLeadWorkflowRequest = z.object({
  email: z.string().email(),
  firstname: z.string().trim().min(1).optional(),
  lastname: z.string().trim().min(1).optional(),
  company: z.string().trim().min(1).optional(),
  jobtitle: z.string().trim().min(1).optional(),
  phone: z.string().trim().min(1).optional(),
  dealname: z.string().trim().min(1),
  amount: z.number().positive().optional(),
  pipeline: z.string().trim().min(1).optional(),
  dealstage: z.string().trim().min(1).optional(),
  note: z.string().trim().min(1).optional(),
});
type HubspotLeadWorkflowRequest = z.infer<typeof HubspotLeadWorkflowRequest>;

@Controller('v1/actions')
export class ActionsController {
  constructor(
    private readonly actions: ActionsService,
    private readonly agents: AgentsService,
  ) {}

  @Get()
  @UseGuards(ClerkAuthGuard)
  async list(@Query('limit') limit?: string) {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = clampQueryInt(limit, { fallback: 100, min: 1, max: 500 });
    return this.actions.listForOrg(orgId, n);
  }

  @Post('execute')
  @UseGuards(ApiKeyGuard)
  async execute(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(ExecuteActionRequest))
    body: ExecuteActionRequestT,
  ): Promise<ExecuteActionResponse> {
    const agent = req.agent!;
    return this.actions.execute({
      orgId: agent.orgId,
      agentId: agent.agentId,
      tool: body.tool,
      params: body.params,
      idempotencyKey: body.idempotency_key,
    });
  }

  // External-agent poll path. After /execute returns awaiting_approval the
  // calling agent polls this to learn the final outcome. Org-scoped via the
  // API key guard so cross-tenant reads are impossible.
  @Get(':id')
  @UseGuards(ApiKeyGuard)
  async getOne(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ExecuteActionResponse> {
    const agent = req.agent!;
    const row = await this.actions.getForOrg(agent.orgId, id);
    if (!row) {
      throw new NotFoundException(`action ${id} not found`);
    }
    return row;
  }

  @Post('demo/hubspot-lead')
  @UseGuards(ClerkAuthGuard)
  async runHubspotLeadWorkflow(
    @Body(new ZodValidationPipe(HubspotLeadWorkflowRequest))
    body: HubspotLeadWorkflowRequest,
  ): Promise<ExecuteActionResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    const agent = await this.agents.ensureInternalAgent({
      orgId,
      name: 'dashboard-hubspot-workflow',
      description: 'Internal dashboard workflow runner for HubSpot lead demos.',
    });
    return this.actions.execute({
      orgId,
      agentId: agent.id,
      tool: 'hubspot.leads.create_deal',
      params: omitUndefined({
        contact: omitUndefined({
          email: body.email,
          firstname: body.firstname,
          lastname: body.lastname,
          company: body.company,
          jobtitle: body.jobtitle,
          phone: body.phone,
        }),
        deal: omitUndefined({
          dealname: body.dealname,
          amount: body.amount,
          pipeline: body.pipeline,
          dealstage: body.dealstage,
        }),
        note: body.note ? { body: body.note } : undefined,
      }),
    });
  }

  @Post(':id/retry')
  @UseGuards(ClerkAuthGuard)
  async retry(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ): Promise<ExecuteActionResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    const operatorId = req.clerkUser?.userId ?? 'dev-mode-operator';
    return this.actions.retry({ orgId, actionId: id, operatorId });
  }
}

function omitUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
