import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import type { FastifyRequest } from 'fastify';
import {
  ConnectorCredentialRequest,
  ConnectorProvider,
  type ConnectorCredentialRequest as ConnectorCredentialRequestT,
  type ConnectorProvider as ConnectorProviderT,
} from '@dejavas/shared';
import { AgentsService } from '../agents/agents.service.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { ConnectorCredentialsService } from './connector-credentials.service.js';

@Controller('v1/connectors')
@UseGuards(ClerkAuthGuard)
export class ConnectorsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly credentials: ConnectorCredentialsService,
  ) {}

  @Get()
  async list() {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.credentials.listForOrg(orgId);
  }

  @Put(':provider/credentials')
  async upsertCredentials(
    @Req() req: FastifyRequest,
    @Param('provider', new ZodValidationPipe(ConnectorProvider))
    provider: ConnectorProviderT,
    @Body(new ZodValidationPipe(ConnectorCredentialRequest))
    body: ConnectorCredentialRequestT,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    const actorId = req.clerkUser?.userId ?? 'dev-mode-operator';
    return this.credentials.upsert({
      orgId,
      provider,
      credentials: body.credentials,
      actorId,
    });
  }

  @Post(':provider/disable')
  async disable(
    @Req() req: FastifyRequest,
    @Param('provider', new ZodValidationPipe(ConnectorProvider))
    provider: ConnectorProviderT,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    const actorId = req.clerkUser?.userId ?? 'dev-mode-operator';
    return this.credentials.disable({ orgId, provider, actorId });
  }
}
