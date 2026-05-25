import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  SetActivePolicyRequest,
  type SetActivePolicyRequest as SetActivePolicyRequestT,
  type ActivePolicyResponse,
} from '@agentbase/shared';
import { PolicyService } from './policy.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';

@Controller('v1/policies')
@UseGuards(ClerkAuthGuard)
export class PolicyController {
  constructor(
    private readonly policy: PolicyService,
    private readonly agents: AgentsService,
  ) {}

  @Get('active')
  async getActive(): Promise<ActivePolicyResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.policy.getActive(orgId);
  }

  @Put('active')
  async setActive(
    @Body(new ZodValidationPipe(SetActivePolicyRequest))
    body: SetActivePolicyRequestT,
  ): Promise<ActivePolicyResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.policy.setActive({
      orgId,
      name: body.name,
      yaml: body.yaml,
    });
  }
}
