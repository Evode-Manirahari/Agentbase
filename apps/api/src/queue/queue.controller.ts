import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { ExpiryProcessor } from './expiry.processor.js';
import { QUEUE } from './queue.tokens.js';
import { ClerkAuthGuard } from '../auth/clerk-auth.guard.js';

@Controller('v1/queue')
@UseGuards(ClerkAuthGuard)
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
