import { Module } from '@nestjs/common';
import { ActionsController } from './actions.controller.js';
import { ActionsService } from './actions.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
// SlackService is exported by SlackModule which is @Global, so no import needed.

@Module({
  imports: [AuditModule, PolicyModule, AgentsModule],
  controllers: [ActionsController],
  providers: [ActionsService, ApiKeyGuard],
})
export class ActionsModule {}
