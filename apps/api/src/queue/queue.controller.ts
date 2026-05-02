import { Controller, Get, Post } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { ExpiryProcessor } from './expiry.processor.js';
import { QUEUE } from './queue.tokens.js';

@Controller('v1/queue')
export class QueueController {
  constructor(
    @Inject(QUEUE) private readonly queue: Queue,
    private readonly processor: ExpiryProcessor,
  ) {}

  @Post('expiry-sweep')
  async runExpirySweep() {
    return this.processor.sweep();
  }

  @Get('status')
  async status() {
    const [counts, schedulers] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      this.queue.getJobSchedulers(),
    ]);
    return {
      counts,
      schedulers: schedulers.map((s) => ({
        key: s.key,
        name: s.name,
        every: s.every,
        next: s.next,
      })),
    };
  }
}
