import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ZodValidationPipe } from 'nestjs-zod';
import {
  ApprovalDecisionRequest,
  BulkApprovalDecisionRequest,
  type ApprovalDecisionRequest as ApprovalDecisionRequestT,
  type ApprovalDecisionResponse,
  type ApprovalListResponse,
  type ApprovalView,
  type BulkApprovalDecisionRequest as BulkApprovalDecisionRequestT,
  type BulkApprovalDecisionResponse,
} from '@agentbase/shared';
import { ApprovalsService } from './approvals.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { clampQueryInt } from '../common/query-int.js';
import { resolveActor } from '../auth/actor.js';
import { DB } from '../db/db.module.js';
import type { Database } from '@agentbase/db';

@Controller('v1/approvals')
@UseGuards(ClerkAuthGuard)
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly agents: AgentsService,
    @Inject(DB) private readonly db: Database,
  ) {}

  @Get()
  async list(@Query('limit') limit?: string): Promise<ApprovalListResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = clampQueryInt(limit, { fallback: 100, min: 1, max: 500 });
    return this.approvals.list(orgId, n);
  }

  @Get(':id')
  async getOne(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ApprovalView> {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.approvals.getOne(orgId, id);
  }

  @Post(':id/decision')
  async decide(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(ApprovalDecisionRequest))
    body: ApprovalDecisionRequestT,
    @Req() req: FastifyRequest,
  ): Promise<ApprovalDecisionResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    const actor = await resolveActor(this.db, req, orgId);
    return this.approvals.decide({
      approvalId: id,
      orgId,
      decision: body.decision,
      actor,
      notes: body.notes,
    });
  }

  // Approve / deny N pending approvals in one call. One failure or
  // already-decided id doesn't block the rest; the response surfaces a
  // per-id outcome so the dashboard can show a row-by-row summary.
  @Post('bulk-decide')
  async bulkDecide(
    @Body(new ZodValidationPipe(BulkApprovalDecisionRequest))
    body: BulkApprovalDecisionRequestT,
    @Req() req: FastifyRequest,
  ): Promise<BulkApprovalDecisionResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    const actor = await resolveActor(this.db, req, orgId);
    return this.approvals.bulkDecide({
      orgId,
      approvalIds: body.approval_ids,
      decision: body.decision,
      actor,
      notes: body.notes,
    });
  }
}
