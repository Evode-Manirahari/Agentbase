import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Req,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  AgentPermissionProfile,
  RegisterAgentRequest,
  type RegisterAgentRequest as RegisterAgentRequestT,
  type RegisterAgentResponse,
} from '@agentbase/shared';
import type { FastifyRequest } from 'fastify';
import { AgentsService } from './agents.service.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { clampQueryInt } from '../common/query-int.js';

const RevokeAgentRequest = z.object({
  reason: z.string().max(1000).optional(),
  revoked_by_email: z.string().email().optional(),
});
type RevokeAgentRequest = z.infer<typeof RevokeAgentRequest>;

const UpdateAgentProfileRequest = z.object({
  permission_profile: AgentPermissionProfile,
});
type UpdateAgentProfileRequest = z.infer<typeof UpdateAgentProfileRequest>;

@Controller('v1/agents')
@UseGuards(ClerkAuthGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  async list(@Query('limit') limit?: string) {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = clampQueryInt(limit, { fallback: 100, min: 1, max: 500 });
    const rows = await this.agents.listForOrg(orgId, n);
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        permission_profile: AgentPermissionProfile.safeParse(r.permissionProfile).success
          ? AgentPermissionProfile.parse(r.permissionProfile)
          : 'custom',
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
      permissionProfile: body.permission_profile,
    });
  }

  @Patch(':id/permission-profile')
  async updatePermissionProfile(
    @Req() req: FastifyRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(UpdateAgentProfileRequest))
    body: UpdateAgentProfileRequest,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    const row = await this.agents.updatePermissionProfile({
      orgId,
      agentId: id,
      permissionProfile: body.permission_profile,
      actorId: req.clerkUser?.userId ?? 'dev-mode-operator',
    });
    return {
      id: row.id,
      permission_profile: body.permission_profile,
    };
  }

  @Post(':id/revoke')
  async revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(RevokeAgentRequest))
    body: RevokeAgentRequest,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.agents.revoke({
      orgId,
      agentId: id,
      reason: body.reason,
      revokedByEmail: body.revoked_by_email,
    });
  }
}
