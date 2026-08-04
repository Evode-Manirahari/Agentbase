import { Global, Module } from '@nestjs/common';
import { ActionsController } from './actions.controller.js';
import { ActionsService } from './actions.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { EffectDispatcher } from './effect-dispatcher.service.js';
import { EffectReceiptsService } from './effect-receipts.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
// SlackService is exported by SlackModule which is @Global, so no import needed.
// REDIS_CONNECTION is provided by QueueModule which is @Global.

// @Global so QueueModule's worker can @Optional-inject ActionsService to run
// the recurring dispatch reconciler, matching how WebhookModule and
// AgentRuntimeModule expose themselves to the same worker. Importing
// ActionsModule into QueueModule instead would be circular: RateLimitService
// injects REDIS_CONNECTION, which QueueModule provides.
@Global()
@Module({
  imports: [AuditModule, PolicyModule, AgentsModule],
  controllers: [ActionsController],
  providers: [
    ActionsService,
    RateLimitService,
    ApiKeyGuard,
    EffectDispatcher,
    EffectReceiptsService,
  ],
  exports: [ActionsService, EffectDispatcher, EffectReceiptsService],
})
export class ActionsModule {}
