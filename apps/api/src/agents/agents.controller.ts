import { Body, Controller, Post } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  RegisterAgentRequest,
  type RegisterAgentRequest as RegisterAgentRequestT,
  type RegisterAgentResponse,
} from '@dejavas/shared';
import { AgentsService } from './agents.service.js';

@Controller('v1/agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post()
  async register(
    @Body(new ZodValidationPipe(RegisterAgentRequest))
    body: RegisterAgentRequestT,
  ): Promise<RegisterAgentResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.agents.register({
      orgId,
      name: body.name,
      description: body.description,
    });
  }
}
