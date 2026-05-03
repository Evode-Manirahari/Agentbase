import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { MetricsService } from './metrics.service.js';
import { AgentsService } from '../agents/agents.service.js';

@Controller('v1/metrics')
@UseGuards(ClerkAuthGuard)
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly agents: AgentsService,
  ) {}

  @Get('overview')
  async overview(@Query('window_hours') windowHours?: string) {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = Math.min(Math.max(Number(windowHours ?? 24), 1), 168);
    return this.metrics.overview(orgId, n);
  }
}
