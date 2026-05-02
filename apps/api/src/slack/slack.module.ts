import { Global, Module } from '@nestjs/common';
import { SlackService } from './slack.service.js';
import { SlackController } from './slack.controller.js';
import { SlackSignatureGuard } from './slack-signature.guard.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { AgentsModule } from '../agents/agents.module.js';

@Global()
@Module({
  imports: [ApprovalsModule, AgentsModule],
  controllers: [SlackController],
  providers: [SlackService, SlackSignatureGuard],
  exports: [SlackService],
})
export class SlackModule {}
