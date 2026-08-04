import {
  Global,
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { ExpiryProcessor } from './expiry.processor.js';
import { QueueController } from './queue.controller.js';
import {
  AGENT_RUN_JOB,
  DISPATCH_RECONCILE_JOB,
  EMAIL_REPLY_POLL_JOB,
  EXPIRY_JOB,
  QUEUE,
  QUEUE_NAME,
  REDIS_CONNECTION,
  SDR_FOLLOWUP_JOB,
  type AgentRunJobData,
  type EmailReplyPollJobData,
  type SdrFollowupJobData,
} from './queue.tokens.js';
import { ActionsService } from '../actions/actions.service.js';
import { AgentRunProcessor } from '../agent-runtime/agent-run.processor.js';
import { EmailsService } from '../agent-runtime/emails.service.js';
import { AuditModule } from '../audit/audit.module.js';
import {
  WebhookService,
  WEBHOOK_DELIVER_JOB,
  type DeliverJobData,
} from '../webhooks/webhook.service.js';

const SWEEP_INTERVAL_MS = 60_000;
const EMAIL_REPLY_POLL_INTERVAL_MS = 10 * 60 * 1000;
// How long a dispatch may stay in flight before we stop believing it is still
// running. Deliberately generous: promoting to `unknown` early would label
// slow-but-live connector calls indeterminate.
const DISPATCH_RECONCILE_INTERVAL_MS = 60_000;
const DISPATCH_STALE_AFTER_MS = 5 * 60 * 1000;

@Global()
@Module({
  imports: [AuditModule],
  controllers: [QueueController],
  providers: [
    ExpiryProcessor,
    {
      provide: REDIS_CONNECTION,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const url = cfg.get<string>('REDIS_URL') ?? 'redis://localhost:6380';
        return new Redis(url, { maxRetriesPerRequest: null });
      },
    },
    {
      provide: QUEUE,
      inject: [REDIS_CONNECTION],
      useFactory: (connection: Redis) =>
        new Queue(QUEUE_NAME, { connection }),
    },
  ],
  exports: [QUEUE, REDIS_CONNECTION, ExpiryProcessor],
})
export class QueueModule implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(QueueModule.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(QUEUE) private readonly queue: Queue,
    @Inject(REDIS_CONNECTION) private readonly connection: Redis,
    private readonly processor: ExpiryProcessor,
    // Optional so the queue can boot in test contexts that don't include
    // the webhook module. In production WebhookModule is @Global and will
    // always be wired.
    @Optional() private readonly webhooks?: WebhookService,
    // Same pattern for agent runs — AgentRuntimeModule provides this in
    // production; absent in test contexts that don't import it.
    @Optional() private readonly agentRuns?: AgentRunProcessor,
    @Optional() private readonly emails?: EmailsService,
    // Same pattern again: ActionsModule provides this in production.
    @Optional() private readonly actions?: ActionsService,
  ) {}

  async onModuleInit() {
    try {
      await this.queue.upsertJobScheduler(
        EXPIRY_JOB,
        { every: SWEEP_INTERVAL_MS },
        {
          name: EXPIRY_JOB,
          data: {},
          opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
        },
      );
    } catch (err) {
      this.log.warn(`failed to register expiry scheduler: ${(err as Error).message}`);
    }

    if (this.actions) {
      try {
        await this.queue.upsertJobScheduler(
          DISPATCH_RECONCILE_JOB,
          { every: DISPATCH_RECONCILE_INTERVAL_MS },
          {
            name: DISPATCH_RECONCILE_JOB,
            data: {},
            opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
          },
        );
      } catch (err) {
        this.log.warn(
          `failed to register dispatch reconciler: ${(err as Error).message}`,
        );
      }
    }

    if (this.emails) {
      try {
        await this.queue.upsertJobScheduler(
          EMAIL_REPLY_POLL_JOB,
          { every: EMAIL_REPLY_POLL_INTERVAL_MS },
          {
            name: EMAIL_REPLY_POLL_JOB,
            data: {} as EmailReplyPollJobData,
            opts: { attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
          },
        );
      } catch (err) {
        this.log.warn(
          `failed to register email reply scheduler: ${(err as Error).message}`,
        );
      }
    }

    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        if (job.name === EXPIRY_JOB) {
          return this.processor.sweep();
        }
        if (job.name === DISPATCH_RECONCILE_JOB) {
          if (!this.actions) {
            return { skipped: true, reason: 'actions service not wired' };
          }
          const reconciled = await this.actions.reconcileStaleDispatches(
            DISPATCH_STALE_AFTER_MS,
          );
          return { reconciled };
        }
        if (job.name === WEBHOOK_DELIVER_JOB) {
          if (!this.webhooks) {
            return { skipped: true, reason: 'webhook service not wired' };
          }
          return this.webhooks.deliver(job.data as DeliverJobData);
        }
        if (job.name === AGENT_RUN_JOB) {
          if (!this.agentRuns) {
            return { skipped: true, reason: 'agent runtime not wired' };
          }
          return this.agentRuns.process(job.data as AgentRunJobData);
        }
        if (job.name === EMAIL_REPLY_POLL_JOB) {
          if (!this.emails) {
            return { skipped: true, reason: 'emails service not wired' };
          }
          return this.emails.scanForReplies(
            job.data as EmailReplyPollJobData,
          );
        }
        if (job.name === SDR_FOLLOWUP_JOB) {
          if (!this.emails) {
            return { skipped: true, reason: 'emails service not wired' };
          }
          return this.emails.processFollowup(job.data as SdrFollowupJobData);
        }
        return { skipped: true, reason: `unknown job ${job.name}` };
      },
      { connection: this.connection },
    );

    this.worker.on('failed', (job, err) => {
      this.log.error(`job ${job?.name ?? 'unknown'} failed: ${err.message}`);
    });
    this.worker.on('completed', (job, result) => {
      const r = result as { expired?: number };
      if (r?.expired) {
        this.log.debug(`${job.name} completed: ${JSON.stringify(result)}`);
      }
    });

    this.log.log(
      `queue '${QUEUE_NAME}' ready; expiry sweep every ${SWEEP_INTERVAL_MS / 1000}s` +
        (this.actions
          ? `; dispatch reconcile every ${DISPATCH_RECONCILE_INTERVAL_MS / 1000}s`
          : ''),
    );
  }

  async onModuleDestroy() {
    try {
      await this.worker?.close();
      await this.queue.close();
      await this.connection.quit();
    } catch (err) {
      this.log.warn(`shutdown error: ${(err as Error).message}`);
    }
  }
}
