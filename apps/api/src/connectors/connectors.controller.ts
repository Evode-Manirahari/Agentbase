import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Param,
  Put,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
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
export class ConnectorsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly credentials: ConnectorCredentialsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @UseGuards(ClerkAuthGuard)
  async list() {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.credentials.listForOrg(orgId);
  }

  @Post('hubspot/oauth/start')
  @UseGuards(ClerkAuthGuard)
  async startHubspotOAuth(@Req() req: FastifyRequest) {
    const orgId = await this.agents.ensureDefaultOrg();
    const actorId = req.clerkUser?.userId ?? 'dev-mode-operator';
    return this.credentials.startHubspotOAuth({ orgId, actorId });
  }

  @Get('hubspot/oauth/callback')
  async hubspotOAuthCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const redirect = (status: 'connected' | 'error', message?: string) => {
      const url = new URL('/connectors', this.dashboardBaseUrl());
      url.searchParams.set('provider', 'hubspot');
      url.searchParams.set('oauth', status);
      if (message) url.searchParams.set('message', message);
      return reply.redirect(url.toString());
    };

    try {
      if (error) {
        throw new BadRequestException(errorDescription ?? error);
      }
      if (!code || !state) {
        throw new BadRequestException('HubSpot OAuth callback missing code or state');
      }
      await this.credentials.completeHubspotOAuth({ code, state });
      return redirect('connected');
    } catch (e) {
      const message =
        e instanceof BadRequestException
          ? String(e.message)
          : 'HubSpot OAuth connection failed';
      return redirect('error', message);
    }
  }

  @Put(':provider/credentials')
  @UseGuards(ClerkAuthGuard)
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
  @UseGuards(ClerkAuthGuard)
  async disable(
    @Req() req: FastifyRequest,
    @Param('provider', new ZodValidationPipe(ConnectorProvider))
    provider: ConnectorProviderT,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    const actorId = req.clerkUser?.userId ?? 'dev-mode-operator';
    return this.credentials.disable({ orgId, provider, actorId });
  }

  private dashboardBaseUrl(): string {
    return (
      this.config.get<string>('DASHBOARD_URL') ??
      this.config.get<string>('WEB_URL') ??
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }
}
