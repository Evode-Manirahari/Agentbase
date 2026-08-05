import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ZodValidationPipe } from 'nestjs-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';
import { EffectReceiptsService } from './effect-receipts.service.js';
import { AgentsService } from '../agents/agents.service.js';
import { clampQueryInt } from '../common/query-int.js';

const ResolveBulkRequest = z.object({
  receipt_ids: z.array(z.string().uuid()).min(1).max(500),
  outcome: z.enum(['committed', 'failed']),
  // Required, unlike the single-resolve note. See resolveBulk(): a bulk
  // assertion without a stated basis is the rubber-stamp the quarantine
  // exists to prevent. There is deliberately no provider_ref — one reference
  // cannot describe many effects.
  note: z.string().trim().min(1).max(2000),
});
type ResolveBulkRequest = z.infer<typeof ResolveBulkRequest>;

const ResolveEffectRequest = z.object({
  // What the operator established by looking at the provider. There is
  // deliberately no 'indeterminate' option: this endpoint exists to END a
  // quarantine, and re-asserting the unknown is what doing nothing already does.
  outcome: z.enum(['committed', 'failed']),
  // The provider's reference, when the operator found one. This is what turns
  // their verdict into something a later reader can check independently.
  provider_ref: z.string().trim().min(1).optional(),
  note: z.string().trim().min(1).max(2000).optional(),
});
type ResolveEffectRequest = z.infer<typeof ResolveEffectRequest>;

/**
 * The operator surface for effects whose outcome nobody knows.
 *
 * The commit protocol deliberately refuses to guess: an attempt that never
 * settled stays `indeterminate` and is never auto-retried, because retrying an
 * unknown send is how a customer gets two emails. That honesty is only useful
 * if a human can act on it — a quarantine with no exit is just a leak.
 */
@Controller('v1/effects')
export class EffectsController {
  constructor(
    private readonly receipts: EffectReceiptsService,
    private readonly agents: AgentsService,
  ) {}

  /** The queue. Everything the system attempted and never learned the fate of. */
  @Get('indeterminate')
  @UseGuards(ClerkAuthGuard)
  async indeterminate(@Query('limit') limit?: string) {
    const orgId = await this.agents.ensureDefaultOrg();
    const n = clampQueryInt(limit, { fallback: 100, min: 1, max: 500 });
    const items = await this.receipts.indeterminateForOrg(orgId, n);
    return { items, count: items.length };
  }

  /** Every attempt made against one action, oldest first. The evidence trail. */
  @Get('actions/:actionId')
  @UseGuards(ClerkAuthGuard)
  async forAction(@Param('actionId') actionId: string) {
    const orgId = await this.agents.ensureDefaultOrg();
    const items = await this.receipts.historyForOrg(orgId, actionId);
    return { items, count: items.length };
  }

  /**
   * Record what a human found at the provider, ending the quarantine.
   *
   * Deliberately not a retry button. Resolving says "I looked, and here is what
   * is true" — the effect is not re-attempted, because if it already landed,
   * attempting it again is the exact failure the protocol exists to prevent.
   */
  /**
   * Resolve many quarantined attempts with one stated basis — the outage
   * case, where a person established the outcome for a window rather than
   * for each row.
   */
  @Post('resolve-bulk')
  @UseGuards(ClerkAuthGuard)
  async resolveBulk(
    @Body(new ZodValidationPipe(ResolveBulkRequest)) body: ResolveBulkRequest,
    @Req() req: FastifyRequest,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    return this.receipts.resolveBulk({
      orgId,
      receiptIds: body.receipt_ids,
      outcome: body.outcome,
      operatorId: operatorFrom(req),
      note: body.note,
    });
  }

  @Post(':receiptId/resolve')
  @UseGuards(ClerkAuthGuard)
  async resolve(
    @Param('receiptId') receiptId: string,
    @Body(new ZodValidationPipe(ResolveEffectRequest)) body: ResolveEffectRequest,
    @Req() req: FastifyRequest,
  ) {
    const orgId = await this.agents.ensureDefaultOrg();
    const operatorId = operatorFrom(req);

    const resolved = await this.receipts.resolve({
      orgId,
      receiptId,
      outcome: body.outcome,
      providerRef: body.provider_ref,
      operatorId,
      note: body.note,
    });
    return {
      receipt_id: receiptId,
      action_id: resolved.actionId,
      attempt: resolved.attempt,
      outcome: body.outcome,
    };
  }
}

function operatorFrom(req: FastifyRequest): string {
  const auth = (req as FastifyRequest & {
    auth?: { userId?: string; email?: string };
  }).auth;
  return auth?.email ?? auth?.userId ?? 'operator';
}
