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
import { AgentRuntimeModule } from './agent-runtime/agent-runtime.module.js';

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
    // WebhookModule + AgentRuntimeModule must come before QueueModule
    // so their providers (WebhookService, AgentRunProcessor,
    // EmailsService) are in the DI container when QueueModule's
    // constructor resolves its @Optional injections at worker-boot
    // time. Otherwise the worker silently drops their job types with
    // "service not wired".
    WebhookModule,
    AgentRuntimeModule,
    QueueModule,
    AuditModule,
    MetricsModule,
  ],
})
export class AppModule {}
