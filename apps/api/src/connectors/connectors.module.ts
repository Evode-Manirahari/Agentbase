import { Global, Module } from '@nestjs/common';
import { ConnectorRegistry } from './connector-registry.js';

@Global()
@Module({
  providers: [ConnectorRegistry],
  exports: [ConnectorRegistry],
})
export class ConnectorsModule {}
