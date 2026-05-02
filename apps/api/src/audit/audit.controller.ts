import { Controller, forwardRef, Get, Inject, Query } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { AgentsService } from '../agents/agents.service.js';

@Controller('v1/audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    @Inject(forwardRef(() => AgentsService))
    private readonly agents: AgentsService,
  ) {}

  @Get()
  async list(@Query('limit') limit?: string) {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = Math.min(Math.max(Number(limit ?? 100), 1), 500);
    const rows = await this.audit.listForOrg(orgId, n);
    return { items: rows };
  }
}
