import { Module } from '@nestjs/common';
import { ActionsController } from './actions.controller.js';
import { ActionsService } from './actions.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { PolicyModule } from '../policy/policy.module.js';
import { ApiKeyGuard } from '../auth/api-key.guard.js';

@Module({
  imports: [AuditModule, PolicyModule],
  controllers: [ActionsController],
  providers: [ActionsService, ApiKeyGuard],
})
export class ActionsModule {}
