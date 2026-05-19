import { Module, forwardRef } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module.js';
// SlackService is provided by SlackModule which is @Global, so no explicit
// import needed here (and importing it would cause a circular module ref).

@Module({
  // AgentRuntimeModule provides AgentRunsService so ApprovalsService can
  // notify a resume after an approval transitions an action out of
  // awaiting_approval. forwardRef keeps the module edge breakable if
  // future wiring composes the other direction.
  imports: [AuditModule, AgentsModule, forwardRef(() => AgentRuntimeModule)],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
