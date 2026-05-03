import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module.js';
import { HealthModule } from './health/health.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { ActionsModule } from './actions/actions.module.js';
import { AuditModule } from './audit/audit.module.js';
import { PolicyModule } from './policy/policy.module.js';
import { ConnectorsModule } from './connectors/connectors.module.js';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { SlackModule } from './slack/slack.module.js';
import { QueueModule } from './queue/queue.module.js';
import { WebhookModule } from './webhooks/webhook.module.js';
import { MetricsModule } from './metrics/metrics.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    HealthModule,
    AgentsModule,
    ConnectorsModule,
    PolicyModule,
    ActionsModule,
    ApprovalsModule,
    SlackModule,
    // WebhookModule must come before QueueModule so WebhookService is
    // available when QueueModule.onModuleInit boots the worker.
    WebhookModule,
    QueueModule,
    AuditModule,
    MetricsModule,
  ],
})
export class AppModule {}
