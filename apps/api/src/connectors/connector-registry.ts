import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HubspotConnector, type Connector } from '@dejavas/connector-hubspot';
import { SalesforceConnector } from '@dejavas/connector-salesforce';
import { GmailConnector } from '@dejavas/connector-gmail';
import { OutreachConnector } from '@dejavas/connector-outreach';
import { ApolloConnector } from '@dejavas/connector-apollo';

@Injectable()
export class ConnectorRegistry {
  private readonly connectors: Connector[];

  constructor(config: ConfigService) {
    const hubspotToken = config.get<string>('HUBSPOT_ACCESS_TOKEN');
    const sfToken = config.get<string>('SALESFORCE_ACCESS_TOKEN');
    const sfInstanceUrl = config.get<string>('SALESFORCE_INSTANCE_URL');
    const gmailToken = config.get<string>('GMAIL_ACCESS_TOKEN');
    const gmailUserId = config.get<string>('GMAIL_USER_ID');
    const outreachToken = config.get<string>('OUTREACH_ACCESS_TOKEN');
    const apolloApiKey = config.get<string>('APOLLO_API_KEY');
    this.connectors = [
      new HubspotConnector({
        accessToken: hubspotToken && hubspotToken.length > 0 ? hubspotToken : null,
      }),
      new SalesforceConnector({
        accessToken: sfToken && sfToken.length > 0 ? sfToken : null,
        instanceUrl: sfInstanceUrl && sfInstanceUrl.length > 0 ? sfInstanceUrl : null,
      }),
      new GmailConnector({
        accessToken: gmailToken && gmailToken.length > 0 ? gmailToken : null,
        userId: gmailUserId && gmailUserId.length > 0 ? gmailUserId : null,
      }),
      new OutreachConnector({
        accessToken: outreachToken && outreachToken.length > 0 ? outreachToken : null,
      }),
      new ApolloConnector({
        apiKey: apolloApiKey && apolloApiKey.length > 0 ? apolloApiKey : null,
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
