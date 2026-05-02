import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import type { FastifyRequest } from 'fastify';
import {
  ExecuteActionRequest,
  type ExecuteActionRequest as ExecuteActionRequestT,
  type ExecuteActionResponse,
} from '@dejavas/shared';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { ActionsService } from './actions.service.js';

@Controller('v1/actions')
export class ActionsController {
  constructor(private readonly actions: ActionsService) {}

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
