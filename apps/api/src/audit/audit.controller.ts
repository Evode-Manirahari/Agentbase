import {
  BadRequestException,
  Controller,
  forwardRef,
  Get,
  Inject,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AuditService, type AuditFilter } from './audit.service.js';
import {
  exportFilename,
  formatAuditCsv,
  formatAuditJson,
  type AuditExportFormat,
} from './audit-export.js';
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

  @Get('export')
  async export(
    @Res() reply: FastifyReply,
    @Query('format') format?: string,
    @Query('actor_type') actorType?: string,
    @Query('event_type') eventType?: string,
    @Query('since') since?: string,
    @Query('until') until?: string,
    @Query('max_rows') maxRows?: string,
  ) {
    const fmt = parseFormat(format);
    const orgId = await this.agents.ensureDefaultOrg();
    const filter: AuditFilter = {
      ...(actorType ? { actorType } : {}),
      ...(eventType ? { eventType } : {}),
      ...(since ? { since: parseDate('since', since) } : {}),
      ...(until ? { until: parseDate('until', until) } : {}),
    };
    const cap = maxRows ? parseMaxRows(maxRows) : undefined;
    const rows = await this.audit.exportForOrg(orgId, filter, cap ? { maxRows: cap } : {});
    const filename = exportFilename(fmt);
    const body = fmt === 'csv' ? formatAuditCsv(rows) : formatAuditJson(rows);
    return reply
      .header('content-type', fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/json')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(body);
  }
}

function parseFormat(raw: string | undefined): AuditExportFormat {
  if (raw === undefined || raw === 'csv') return 'csv';
  if (raw === 'json') return 'json';
  throw new BadRequestException(`format must be 'csv' or 'json' (got '${raw}')`);
}

function parseMaxRows(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new BadRequestException('max_rows must be a positive integer');
  }
  return n;
}

function parseDate(name: string, raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${name} is not a valid ISO date`);
  }
  return d;
}
