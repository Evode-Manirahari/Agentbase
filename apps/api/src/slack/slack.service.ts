import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebClient, type KnownBlock } from '@slack/web-api';
import type { ApprovalView, PolicyDecision } from '@dejavas/shared';

export interface ApprovalCardInput {
  approvalId: string;
  agentName: string;
  tool: string;
  params: Record<string, unknown>;
  reason: string | null;
  expiresAt: Date | null;
  channelOverride?: string | null;
}

export interface PostedCard {
  channel: string;
  ts: string;
}

@Injectable()
export class SlackService {
  private readonly log = new Logger(SlackService.name);
  private readonly client: WebClient | null;
  private readonly defaultChannel: string | null;

  constructor(config: ConfigService) {
    const token = config.get<string>('SLACK_BOT_TOKEN');
    const channel = config.get<string>('SLACK_APPROVALS_CHANNEL');
    this.client = token && token.length > 0 ? new WebClient(token) : null;
    this.defaultChannel = channel && channel.length > 0 ? channel : null;
    if (!this.client) {
      this.log.log('SLACK_BOT_TOKEN not set — approval cards will be skipped');
    } else if (!this.defaultChannel) {
      this.log.warn('SLACK_BOT_TOKEN set but SLACK_APPROVALS_CHANNEL is not — cards have nowhere to go');
    }
  }

  isConfigured(): boolean {
    return this.client !== null && this.defaultChannel !== null;
  }

  async postApprovalCard(input: ApprovalCardInput): Promise<PostedCard | null> {
    if (!this.client) return null;
    const channel = input.channelOverride ?? this.defaultChannel;
    if (!channel) return null;
    try {
      const res = await this.client.chat.postMessage({
        channel,
        text: `Approval needed: ${input.agentName} → ${input.tool}`,
        blocks: buildPendingBlocks(input),
      });
      if (!res.ok || !res.ts || !res.channel) {
        this.log.warn(`slack post returned ok=${res.ok}`);
        return null;
      }
      return { channel: res.channel, ts: res.ts };
    } catch (err) {
      this.log.warn(`slack post failed: ${(err as Error).message}`);
      return null;
    }
  }

  async updateViaResponseUrl(
    responseUrl: string,
    blocks: KnownBlock[],
    fallbackText: string,
  ): Promise<void> {
    try {
      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          replace_original: true,
          text: fallbackText,
          blocks,
        }),
      });
    } catch (err) {
      this.log.warn(`response_url update failed: ${(err as Error).message}`);
    }
  }

  async updateCard(
    channel: string,
    ts: string,
    blocks: KnownBlock[],
    fallbackText: string,
  ): Promise<boolean> {
    if (!this.client) return false;
    try {
      const res = await this.client.chat.update({
        channel,
        ts,
        text: fallbackText,
        blocks,
      });
      return res.ok === true;
    } catch (err) {
      this.log.warn(`chat.update failed: ${(err as Error).message}`);
      return false;
    }
  }

  buildResolvedBlocks(input: {
    decision: 'approved' | 'denied' | 'expired';
    decidedByDisplay: string;
    tool: string;
    agentName: string;
    actionStatus: string;
    errorCode: string | null;
    notes: string | null;
  }): KnownBlock[] {
    const icon =
      input.decision === 'approved' ? '✅' : input.decision === 'denied' ? '❌' : '⌛';
    const head = `${icon} ${input.decision[0]!.toUpperCase()}${input.decision.slice(1)} by ${input.decidedByDisplay}`;
    const fields = [
      mrkdwn(`*Agent*\n${input.agentName}`),
      mrkdwn(`*Tool*\n\`${input.tool}\``),
      mrkdwn(`*Action status*\n\`${input.actionStatus}\``),
    ];
    if (input.errorCode) fields.push(mrkdwn(`*Error*\n\`${input.errorCode}\``));
    if (input.notes) fields.push(mrkdwn(`*Notes*\n${input.notes}`));
    return [
      { type: 'header', text: { type: 'plain_text', text: head } },
      { type: 'section', fields },
    ];
  }
}

function buildPendingBlocks(input: ApprovalCardInput): KnownBlock[] {
  const fields = [
    mrkdwn(`*Agent*\n${input.agentName}`),
    mrkdwn(`*Tool*\n\`${input.tool}\``),
  ];
  if (input.reason) fields.push(mrkdwn(`*Reason*\n${input.reason}`));
  if (input.expiresAt) {
    fields.push(mrkdwn(`*Expires*\n<!date^${Math.floor(input.expiresAt.getTime() / 1000)}^{date_short_pretty} {time}|${input.expiresAt.toISOString()}>`));
  }
  const paramsJson = JSON.stringify(input.params, null, 2);
  const truncated = paramsJson.length > 2500 ? paramsJson.slice(0, 2497) + '…' : paramsJson;
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🛂 Approval needed', emoji: true },
    },
    { type: 'section', fields },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Params*\n\`\`\`${truncated}\`\`\`` },
    },
    {
      type: 'actions',
      block_id: 'dejavas_approval_actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          value: `approve:${input.approvalId}`,
          action_id: 'decide_approve',
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Deny', emoji: true },
          value: `deny:${input.approvalId}`,
          action_id: 'decide_deny',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `approval \`${input.approvalId}\``,
        },
      ],
    },
  ];
}

function mrkdwn(text: string): { type: 'mrkdwn'; text: string } {
  return { type: 'mrkdwn', text };
}

export type { ApprovalView, PolicyDecision };
