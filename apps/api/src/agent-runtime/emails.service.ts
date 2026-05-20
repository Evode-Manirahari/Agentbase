import { Inject, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { and, desc, eq, gte, isNull, lt, or } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import {
  actions,
  agentEmails,
  type AgentEmail,
} from '@dejavas/db';
import {
  EMAIL_REPLY_POLL_JOB,
  QUEUE,
  SDR_FOLLOWUP_JOB,
  type EmailReplyPollJobData,
  type SdrFollowupJobData,
} from '../queue/queue.tokens.js';
import { ConnectorRegistry } from '../connectors/connector-registry.js';
import { AgentRunsService } from './agent-runs.service.js';
import { SEQUENCE_TOUCH_INTERVALS_MS } from './sequence.constants.js';

// How long after a send we keep polling for replies. Replies arriving
// after this window get manually re-triggered by the operator.
const REPLY_POLL_WINDOW_DAYS = 7;
// Don't repoll the same thread more often than this. Gmail's threads.get
// is cheap but we still want to keep the cron tick under a second per
// org.
const MIN_REPOLL_INTERVAL_MS = 5 * 60 * 1000;
// Cap per cron tick so a backlog can't drown the worker.
const BATCH_SCAN_LIMIT = 100;

export interface RecordSendInput {
  orgId: string;
  agentId: string;
  runId: string;
  sendActionId: string;
  gmailThreadId: string;
  gmailMessageId: string;
  toEmail: string;
  subject?: string | undefined;
}

@Injectable()
export class EmailsService {
  private readonly log = new Logger(EmailsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(QUEUE) private readonly queue: Queue,
    private readonly connectors: ConnectorRegistry,
    private readonly runs: AgentRunsService,
  ) {}

  // Called after a gmail.send action returns success. Records the
  // thread/message ids so the poller can detect replies later. The
  // recipient email is the canonical "to" address from the send.
  async recordSend(input: RecordSendInput): Promise<void> {
    try {
      await this.db
        .insert(agentEmails)
        .values({
          orgId: input.orgId,
          agentId: input.agentId,
          runId: input.runId,
          sendActionId: input.sendActionId,
          gmailThreadId: input.gmailThreadId,
          gmailMessageId: input.gmailMessageId,
          toEmail: input.toEmail,
          subject: input.subject ?? null,
        })
        // Same thread already tracked (rare — e.g. agent re-sends in a
        // thread it earlier sent in): ignore the conflict.
        .onConflictDoNothing();
    } catch (err) {
      this.log.warn(
        `failed to record agent_email for thread ${input.gmailThreadId}: ${(err as Error).message}`,
      );
    }
  }

  // Trigger a poll. Manual button path → run_id is set; recurring sweep
  // → both filters are null and we scan every org.
  async enqueuePoll(filter: EmailReplyPollJobData = {}): Promise<void> {
    await this.queue.add(EMAIL_REPLY_POLL_JOB, filter, {
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
  }

  // Worker entry point. Two phases:
  //   1. Backfill: find executed gmail.send actions that don't have an
  //      agent_emails row yet (insert one).
  //   2. Poll: for each agent_emails row whose thread hasn't been
  //      checked recently, call Gmail and see if there's a new reply;
  //      if so, mark the row + enqueue a reply-handler agent run.
  async scanForReplies(
    filter: EmailReplyPollJobData = {},
  ): Promise<{
    discovered: number;
    scanned: number;
    replies_found: number;
  }> {
    const discovered = await this.discoverNewSends(filter);
    const rows = await this.findPendingRows(filter);
    let repliesFound = 0;
    for (const row of rows) {
      try {
        const result = await this.pollOne(row);
        if (result.replied) repliesFound += 1;
      } catch (err) {
        this.log.warn(
          `poll error for email ${row.id}: ${(err as Error).message}`,
        );
      }
    }
    return {
      discovered,
      scanned: rows.length,
      replies_found: repliesFound,
    };
  }

  // Find gmail.send actions that succeeded recently and aren't yet
  // tracked in agent_emails. Pulls the threadId + messageId out of the
  // stored connector result. Best-effort: skips rows where the result
  // shape doesn't match Gmail's response.
  //
  // When the inserted row is a touch-1 outbound send (i.e., the
  // original gmail.send had no threadId in its params — only initial
  // SDR sends are unthreaded; follow-ups and reply-handler sends always
  // pass threadId), we ALSO enqueue two delayed BullMQ jobs at +3d and
  // +7d to fire the next touches in the sequence. The "no threadId"
  // gate is what stops follow-up sends from re-fanning-out (they all
  // carry a threadId), so we don't get an infinite cascade.
  private async discoverNewSends(filter: EmailReplyPollJobData): Promise<number> {
    const windowStart = new Date(
      Date.now() - REPLY_POLL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const existingIds = await this.db
      .select({ sendActionId: agentEmails.sendActionId })
      .from(agentEmails);
    const existingSet = new Set(existingIds.map((r) => r.sendActionId));

    const conds = [
      eq(actions.tool, 'gmail.send'),
      eq(actions.status, 'executed'),
      gte(actions.createdAt, windowStart),
    ];
    if (filter.org_id) conds.push(eq(actions.orgId, filter.org_id));
    // We can't filter by run_id directly here — actions don't carry
    // it. The downstream pollOne is scoped per-row, so leaving
    // discoverNewSends untargeted is fine.

    const rows = await this.db
      .select()
      .from(actions)
      .where(and(...conds))
      .orderBy(desc(actions.createdAt))
      .limit(BATCH_SCAN_LIMIT * 2);

    let discovered = 0;
    for (const row of rows) {
      if (existingSet.has(row.id)) continue;
      const extracted = extractSendMetadata(row);
      if (!extracted) continue;
      // Touch-1 = unthreaded send (no params.threadId). Follow-ups
      // and reply-handler sends pass threadId, so they get
      // sequence_touch=1 by column default but won't re-schedule.
      const isInitialSend = extracted.priorThreadId === undefined;
      try {
        const [inserted] = await this.db
          .insert(agentEmails)
          .values({
            orgId: row.orgId,
            agentId: row.agentId,
            // We don't have the agent_runs.id on actions yet — for
            // sequence scheduling we anchor on agent_emails.id, not
            // run_id, so this placeholder is harmless. PR-future:
            // add run_id to actions for direct lookup.
            runId: row.id,
            sendActionId: row.id,
            gmailThreadId: extracted.threadId,
            gmailMessageId: extracted.messageId,
            toEmail: extracted.toEmail,
            subject: extracted.subject ?? null,
          })
          .onConflictDoNothing()
          .returning({ id: agentEmails.id });
        discovered += 1;
        if (inserted && isInitialSend) {
          await this.scheduleSequenceFollowups(inserted.id);
        }
      } catch (err) {
        this.log.warn(
          `discoverNewSends insert failed for action ${row.id}: ${(err as Error).message}`,
        );
      }
    }
    return discovered;
  }

  private async scheduleSequenceFollowups(
    agentEmailId: string,
  ): Promise<void> {
    for (const [idx, delay] of SEQUENCE_TOUCH_INTERVALS_MS.entries()) {
      const touchNumber = (idx + 2) as 2 | 3;
      try {
        await this.queue.add(
          SDR_FOLLOWUP_JOB,
          {
            agent_email_id: agentEmailId,
            touch_number: touchNumber,
          } satisfies SdrFollowupJobData,
          {
            delay,
            attempts: 1,
            removeOnComplete: 50,
            removeOnFail: 50,
          },
        );
      } catch (err) {
        this.log.warn(
          `failed to schedule touch ${touchNumber} for email ${agentEmailId}: ${(err as Error).message}`,
        );
      }
    }
  }

  // Worker entry point for SDR_FOLLOWUP_JOB. Fires +3d or +7d after a
  // touch-1 send. Skip if the prospect already replied (the
  // reply-handler is now in charge of that thread); otherwise create
  // a new agent run on the ai-sdr-followup job with thread context.
  async processFollowup(
    data: SdrFollowupJobData,
  ): Promise<{ status: string; run_id?: string }> {
    const [row] = await this.db
      .select()
      .from(agentEmails)
      .where(eq(agentEmails.id, data.agent_email_id))
      .limit(1);
    if (!row) {
      return { status: 'not_found' };
    }
    if (row.replyReceived) {
      this.log.log(
        `sequence stopped: touch ${data.touch_number} skipped because reply landed on thread ${row.gmailThreadId}`,
      );
      return { status: 'stopped_replied' };
    }
    try {
      const handlerRun = await this.runs.create({
        orgId: row.orgId,
        agentId: row.agentId,
        jobKey: 'ai-sdr-followup',
        context: {
          thread_id: row.gmailThreadId,
          original_message_id: row.gmailMessageId,
          to_email: row.toEmail,
          subject: row.subject ?? '',
          touch_number: data.touch_number,
          original_run_id: row.runId,
        },
      });
      return { status: 'enqueued', run_id: handlerRun.id };
    } catch (err) {
      this.log.warn(
        `failed to enqueue follow-up run for email ${row.id}: ${(err as Error).message}`,
      );
      return { status: 'failed' };
    }
  }

  async listForRun(orgId: string, runId: string): Promise<AgentEmail[]> {
    return this.db
      .select()
      .from(agentEmails)
      .where(and(eq(agentEmails.orgId, orgId), eq(agentEmails.runId, runId)))
      .orderBy(desc(agentEmails.sentAt));
  }

  private async findPendingRows(
    filter: EmailReplyPollJobData,
  ): Promise<AgentEmail[]> {
    const windowStart = new Date(
      Date.now() - REPLY_POLL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const repollCutoff = new Date(Date.now() - MIN_REPOLL_INTERVAL_MS);

    const conds = [
      eq(agentEmails.replyReceived, false),
      // Sent within the polling window.
      // (drizzle: `gte(sentAt, windowStart)` would work but we want
      // pending rows ordered fresh-first below.)
    ];
    if (filter.org_id) conds.push(eq(agentEmails.orgId, filter.org_id));
    if (filter.run_id) conds.push(eq(agentEmails.runId, filter.run_id));

    // Either never polled, or last polled before the cutoff.
    const repollGate = or(
      isNull(agentEmails.lastPolledAt),
      lt(agentEmails.lastPolledAt, repollCutoff),
    );
    if (repollGate) conds.push(repollGate);

    const rows = await this.db
      .select()
      .from(agentEmails)
      .where(and(...conds))
      .orderBy(desc(agentEmails.sentAt))
      .limit(BATCH_SCAN_LIMIT);
    return rows.filter((r) => r.sentAt >= windowStart);
  }

  private async pollOne(
    row: AgentEmail,
  ): Promise<{ replied: boolean }> {
    const connector = this.connectors.resolve('gmail.threads.get');
    if (!connector) {
      this.log.warn('gmail connector not configured; skipping reply scan');
      await this.markPolled(row.id);
      return { replied: false };
    }
    const fetched = await connector.invoke('gmail.threads.get', {
      threadId: row.gmailThreadId,
      format: 'metadata',
    });
    await this.markPolled(row.id);
    if (!fetched.ok) {
      return { replied: false };
    }
    const data = (fetched.data ?? {}) as {
      messages?: { id?: string; from?: string; payload?: unknown }[];
    };
    const messages = data.messages ?? [];
    // The earliest message in the thread is our send; anything newer
    // from someone other than us is a reply. The simplest signal: more
    // than one message AND the last message id differs from ours.
    if (messages.length <= 1) return { replied: false };
    const last = messages[messages.length - 1];
    if (!last?.id || last.id === row.gmailMessageId) {
      return { replied: false };
    }

    // Mark the email as replied + create a handler run.
    await this.db
      .update(agentEmails)
      .set({
        replyReceived: true,
        replyMessageId: last.id,
        replyReceivedAt: new Date(),
      })
      .where(eq(agentEmails.id, row.id));

    try {
      const handlerRun = await this.runs.create({
        orgId: row.orgId,
        agentId: row.agentId,
        jobKey: 'ai-reply-handler',
        context: {
          thread_id: row.gmailThreadId,
          original_message_id: row.gmailMessageId,
          reply_message_id: last.id,
          to_email: row.toEmail,
          subject: row.subject ?? '',
          source_run_id: row.runId,
        },
      });
      await this.db
        .update(agentEmails)
        .set({ replyHandlerRunId: handlerRun.id })
        .where(eq(agentEmails.id, row.id));
    } catch (err) {
      this.log.warn(
        `failed to start reply handler for email ${row.id}: ${(err as Error).message}`,
      );
    }
    return { replied: true };
  }

  private async markPolled(id: string): Promise<void> {
    await this.db
      .update(agentEmails)
      .set({ lastPolledAt: new Date() })
      .where(eq(agentEmails.id, id));
  }
}

// Pulls the gmail.send response shape out of a stored action row.
// Gmail's messages.send returns { id, threadId, labelIds } as the
// `data` field of our ConnectorResult; the `to` recipient lives in
// the action's params. Returns null if the shape doesn't match.
//
// `priorThreadId` is the threadId the agent PASSED INTO gmail.send,
// not the one Gmail returned. It's only set when the agent threaded
// its send to an existing conversation (follow-ups, replies). Touch-1
// SDR sends omit threadId entirely; we use that signal to gate the
// sequence-scheduling fan-out in discoverNewSends.
function extractSendMetadata(
  row: typeof actions.$inferSelect,
): {
  threadId: string;
  messageId: string;
  toEmail: string;
  subject?: string;
  priorThreadId?: string;
} | null {
  const result = row.result as
    | { ok?: boolean; data?: { id?: string; threadId?: string } }
    | null;
  const params = row.params as
    | { to?: string; subject?: string; threadId?: string }
    | null;
  if (!result?.ok) return null;
  const threadId = result.data?.threadId;
  const messageId = result.data?.id;
  const toEmail = params?.to;
  if (!threadId || !messageId || !toEmail) return null;
  return {
    threadId,
    messageId,
    toEmail,
    ...(params?.subject ? { subject: params.subject } : {}),
    ...(params?.threadId ? { priorThreadId: params.threadId } : {}),
  };
}
