import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller.js';
import { ApprovalsService } from './approvals.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { AgentsModule } from '../agents/agents.module.js';

@Module({
  imports: [AuditModule, AgentsModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
