import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HubspotConnector, type Connector } from '@dejavas/connector-hubspot';
import { SalesforceConnector } from '@dejavas/connector-salesforce';

@Injectable()
export class ConnectorRegistry {
  private readonly connectors: Connector[];

  constructor(config: ConfigService) {
    const hubspotToken = config.get<string>('HUBSPOT_ACCESS_TOKEN');
    const sfToken = config.get<string>('SALESFORCE_ACCESS_TOKEN');
    const sfInstanceUrl = config.get<string>('SALESFORCE_INSTANCE_URL');
    this.connectors = [
      new HubspotConnector({
        accessToken: hubspotToken && hubspotToken.length > 0 ? hubspotToken : null,
      }),
      new SalesforceConnector({
        accessToken: sfToken && sfToken.length > 0 ? sfToken : null,
        instanceUrl: sfInstanceUrl && sfInstanceUrl.length > 0 ? sfInstanceUrl : null,
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
