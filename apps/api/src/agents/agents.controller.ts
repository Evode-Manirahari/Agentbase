import { Body, Controller, Get, Post, Query } from '@nestjs/common';
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

  @Get()
  async list(@Query('limit') limit?: string) {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = Math.min(Math.max(Number(limit ?? 100), 1), 500);
    const rows = await this.agents.listForOrg(orgId, n);
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        status: r.status,
        created_at: r.createdAt.toISOString(),
        revoked_at: r.revokedAt?.toISOString() ?? null,
        api_key_prefix: r.keyPrefix,
      })),
    };
  }

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
