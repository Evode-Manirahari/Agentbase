import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HubspotConnector, type Connector } from '@dejavas/connector-hubspot';

@Injectable()
export class ConnectorRegistry {
  private readonly connectors: Connector[];

  constructor(config: ConfigService) {
    const hubspotToken = config.get<string>('HUBSPOT_ACCESS_TOKEN');
    this.connectors = [
      new HubspotConnector({
        accessToken: hubspotToken && hubspotToken.length > 0 ? hubspotToken : null,
      }),
    ];
  }

  resolve(tool: string): Connector | null {
    return this.connectors.find((c) => c.supports(tool)) ?? null;
  }

  list(): { name: string }[] {
    return this.connectors.map((c) => ({ name: c.name }));
  }
}
