import { forwardRef, Module } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';
import { AgentsModule } from '../agents/agents.module.js';

@Module({
  imports: [forwardRef(() => AgentsModule)],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
