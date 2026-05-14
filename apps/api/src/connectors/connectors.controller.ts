import {
  Body,
  BadRequestException,
  Controller,
  Get,
  InternalServerErrorException,
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
import { ConnectorRegistry } from './connector-registry.js';
import { ConnectorCredentialsService } from './connector-credentials.service.js';

const REDIRECT_MESSAGE_MAX = 200;

@Controller('v1/connectors')
export class ConnectorsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly credentials: ConnectorCredentialsService,
    private readonly registry: ConnectorRegistry,
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
      if (message) url.searchParams.set('message', sanitizeRedirectMessage(message));
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

  @Post(':provider/test')
  @UseGuards(ClerkAuthGuard)
  async testConnection(
    @Param('provider', new ZodValidationPipe(ConnectorProvider))
    provider: ConnectorProviderT,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    if (provider !== 'hubspot') {
      throw new BadRequestException(`connector test is not implemented for ${provider}`);
    }

    const connector = await this.registry.resolveForOrg(orgId, 'hubspot.connection.test');
    const result = connector
      ? await connector.invoke('hubspot.connection.test', {})
      : {
          ok: false,
          error: {
            code: 'no_connector',
            message: 'no connector resolves hubspot.connection.test',
          },
        };
    return {
      provider,
      ok: result.ok,
      checked_at: new Date().toISOString(),
      result: result.ok
        ? { ok: true, data: result.data ?? null }
        : { ok: false, error: result.error ?? null },
    };
  }

  private dashboardBaseUrl(): string {
    const explicit =
      this.config.get<string>('DASHBOARD_URL') ?? this.config.get<string>('WEB_URL');
    if (explicit && explicit.trim().length > 0) return explicit.replace(/\/$/, '');
    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new InternalServerErrorException(
        'DASHBOARD_URL or WEB_URL must be set in production',
      );
    }
    return 'http://localhost:3000';
  }
}

function sanitizeRedirectMessage(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      if (out.length === 0 || out.endsWith(' ')) continue;
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out.trim().slice(0, REDIRECT_MESSAGE_MAX);
}
