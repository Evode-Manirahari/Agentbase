import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import type { FastifyRequest } from 'fastify';
import {
  ExecuteActionRequest,
  type ExecuteActionRequest as ExecuteActionRequestT,
  type ExecuteActionResponse,
} from '@dejavas/shared';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ActionsService } from './actions.service.js';
import { AgentsService } from '../agents/agents.service.js';

@Controller('v1/actions')
export class ActionsController {
  constructor(
    private readonly actions: ActionsService,
    private readonly agents: AgentsService,
  ) {}

  @Get()
  async list(@Query('limit') limit?: string) {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = Math.min(Math.max(Number(limit ?? 100), 1), 500);
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
}
