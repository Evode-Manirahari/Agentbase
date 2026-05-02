import {
  Global,
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { ExpiryProcessor } from './expiry.processor.js';
import { QueueController } from './queue.controller.js';
import {
  EXPIRY_JOB,
  QUEUE,
  QUEUE_NAME,
  REDIS_CONNECTION,
} from './queue.tokens.js';
import { AuditModule } from '../audit/audit.module.js';

const SWEEP_INTERVAL_MS = 60_000;

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

    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        if (job.name === EXPIRY_JOB) {
          return this.processor.sweep();
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

    this.log.log(`queue '${QUEUE_NAME}' ready; expiry sweep every ${SWEEP_INTERVAL_MS / 1000}s`);
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
