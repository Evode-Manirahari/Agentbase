import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
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
} from '@dejavas/shared';
import { ApprovalsService } from './approvals.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';

@Controller('v1/approvals')
@UseGuards(ClerkAuthGuard)
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly agents: AgentsService,
  ) {}

  @Get()
  async list(@Query('limit') limit?: string): Promise<ApprovalListResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = Math.min(Math.max(Number(limit ?? 100), 1), 500);
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
  ): Promise<ApprovalDecisionResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.approvals.decide({
      approvalId: id,
      orgId,
      decision: body.decision,
      decidedByEmail: body.decided_by_email,
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
  ): Promise<BulkApprovalDecisionResponse> {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.approvals.bulkDecide({
      orgId,
      approvalIds: body.approval_ids,
      decision: body.decision,
      decidedByEmail: body.decided_by_email,
      notes: body.notes,
    });
  }
}
