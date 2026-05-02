import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { WebClient } from '@slack/web-api';
import { ConfigService } from '@nestjs/config';
import { SlackSignatureGuard } from './slack-signature.guard.js';
import { SlackService } from './slack.service.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { AgentsService } from '../agents/agents.service.js';

interface SlackInteractivePayloadAction {
  action_id: string;
  block_id: string;
  value: string;
}

interface SlackInteractivePayload {
  type: string;
  user: { id: string; username?: string; team_id?: string };
  actions: SlackInteractivePayloadAction[];
  response_url: string;
  container?: { channel_id?: string; message_ts?: string };
}

@Controller('v1/slack')
export class SlackController {
  private readonly log = new Logger(SlackController.name);
  private readonly users: WebClient | null;

  constructor(
    private readonly slack: SlackService,
    private readonly approvals: ApprovalsService,
    private readonly agents: AgentsService,
    config: ConfigService,
  ) {
    const token = config.get<string>('SLACK_BOT_TOKEN');
    this.users = token && token.length > 0 ? new WebClient(token) : null;
  }

  @Post('interactive')
  @UseGuards(SlackSignatureGuard)
  @HttpCode(200)
  async interactive(@Body() body: { payload?: string }) {
    if (!body?.payload) {
      this.log.warn('slack interactive without payload');
      return { ok: false };
    }
    let payload: SlackInteractivePayload;
    try {
      payload = JSON.parse(body.payload) as SlackInteractivePayload;
    } catch {
      return { ok: false };
    }

    const action = payload.actions?.[0];
    if (!action) return { ok: false };
    const [decisionWord, approvalId] = action.value.split(':');
    if ((decisionWord !== 'approve' && decisionWord !== 'deny') || !approvalId) {
      return { ok: false };
    }

    const orgId = await this.agents.ensureDefaultOrg();

    const decidedByDisplay =
      payload.user.username ?? payload.user.id ?? 'unknown';
    const email = await this.tryResolveEmail(payload.user.id);

    let actionStatus = '';
    let errorCode: string | null = null;
    let finalDecision: 'approved' | 'denied' | 'expired' = 'expired';
    let agentName = '';
    let tool = '';

    try {
      const view = await this.approvals.getOne(orgId, approvalId);
      agentName = view.agent_name;
      tool = view.tool;
    } catch {
      // tolerate — we still try to decide; if decide errors, we'll respond accordingly
    }

    try {
      const result = await this.approvals.decide({
        approvalId,
        orgId,
        decision: decisionWord,
        ...(email ? { decidedByEmail: email } : {}),
        notes: `via Slack: ${decidedByDisplay} (${payload.user.id})`,
      });
      finalDecision = result.decision === 'approved' ? 'approved' : 'denied';
      actionStatus = result.action_status;
      const r = result.result as { error?: { code?: string } } | null;
      errorCode = r?.error?.code ?? null;
    } catch (err) {
      if (err instanceof ConflictException) {
        const msg = (err.getResponse() as { message?: string }).message ?? 'already decided';
        await this.slack.updateViaResponseUrl(
          payload.response_url,
          [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `⚠️ This approval is no longer pending — ${msg}.`,
              },
            },
          ],
          'Approval no longer pending',
        );
        return { ok: true, already_decided: true };
      }
      if (err instanceof GoneException) {
        await this.slack.updateViaResponseUrl(
          payload.response_url,
          [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '⌛ This approval has expired.' },
            },
          ],
          'Approval expired',
        );
        return { ok: true, expired: true };
      }
      if (err instanceof NotFoundException) {
        await this.slack.updateViaResponseUrl(
          payload.response_url,
          [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '❓ Approval not found.' },
            },
          ],
          'Approval not found',
        );
        return { ok: false, not_found: true };
      }
      throw err;
    }

    const blocks = this.slack.buildResolvedBlocks({
      decision: finalDecision,
      decidedByDisplay: `<@${payload.user.id}>`,
      tool,
      agentName,
      actionStatus,
      errorCode,
      notes: null,
    });
    await this.slack.updateViaResponseUrl(
      payload.response_url,
      blocks,
      `Approval ${finalDecision} by ${decidedByDisplay}`,
    );

    return { ok: true };
  }

  private async tryResolveEmail(userId: string): Promise<string | null> {
    if (!this.users) return null;
    try {
      const r = await this.users.users.info({ user: userId });
      const email = r.user?.profile?.email;
      return typeof email === 'string' && email.length > 0 ? email : null;
    } catch {
      return null;
    }
  }
}
