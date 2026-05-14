import { Global, Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { ConnectorsController } from './connectors.controller.js';
import { ConnectorCredentialsService } from './connector-credentials.service.js';
import { ConnectorRegistry } from './connector-registry.js';

@Global()
@Module({
  imports: [AgentsModule],
  controllers: [ConnectorsController],
  providers: [ConnectorRegistry, ConnectorCredentialsService],
  exports: [ConnectorRegistry, ConnectorCredentialsService],
})
export class ConnectorsModule {}
