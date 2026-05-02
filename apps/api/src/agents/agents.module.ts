import { forwardRef, Module } from '@nestjs/common';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [forwardRef(() => AuditModule)],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
