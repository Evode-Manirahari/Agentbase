import {
  BadRequestException,
  Controller,
  forwardRef,
  Get,
  Inject,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuditService, type AuditFilter } from './audit.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';

@Controller('v1/audit')
@UseGuards(ClerkAuthGuard)
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    @Inject(forwardRef(() => AgentsService))
    private readonly agents: AgentsService,
  ) {}

  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('actor_type') actorType?: string,
    @Query('event_type') eventType?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = Math.min(Math.max(Number(limit ?? 100), 1), 500);
    const filter: AuditFilter = {
      ...(actorType ? { actorType } : {}),
      ...(eventType ? { eventType } : {}),
      ...(since ? { since: parseDate('since', since) } : {}),
      ...(until ? { until: parseDate('until', until) } : {}),
    };
    const rows = await this.audit.listForOrg(orgId, n, filter);
    return { items: rows };
  }

  @Get('event-types')
  async eventTypes() {
    const orgId = await this.agents.ensureDefaultOrg();
    return { items: await this.audit.listEventTypes(orgId) };
  }
}

function parseDate(name: string, raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${name} is not a valid ISO date`);
  }
  return d;
}
