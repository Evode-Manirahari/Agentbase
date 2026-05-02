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
    AuditModule,
  ],
})
export class AppModule {}
