import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HubspotConnector, type Connector } from '@agentbase/connector-hubspot';
import { SalesforceConnector } from '@agentbase/connector-salesforce';
import { GmailConnector } from '@agentbase/connector-gmail';
import { OutreachConnector } from '@agentbase/connector-outreach';
import { ApolloConnector } from '@agentbase/connector-apollo';
import { ShellConnector, SHELL_TOOLS } from '@agentbase/connector-shell';
import {
  ConnectorCredentialsService,
  type ConnectorConfig,
} from './connector-credentials.service.js';
import type { ConnectorProvider } from '@agentbase/shared';

@Injectable()
export class ConnectorRegistry {
  private readonly envConfig: Record<ConnectorProvider, ConnectorConfig | null>;
  // Shell is not a credentialed provider — there is no token to store and no
  // per-org config — so it sits outside ConnectorProvider rather than being
  // forced into an enum that also backs the connector_credentials table.
  private readonly shell: ShellConnector;

  constructor(
    config: ConfigService,
    @Optional() private readonly credentials?: ConnectorCredentialsService,
  ) {
    const shellEnabled =
      (config.get<string>('AGENTBASE_SHELL_ENABLED') ?? '').trim() === '1';
    const shellCwd = config.get<string>('AGENTBASE_SHELL_CWD');
    this.shell = new ShellConnector({
      enabled: shellEnabled,
      ...(shellCwd ? { cwd: shellCwd } : {}),
    });
    const hubspotToken = config.get<string>('HUBSPOT_ACCESS_TOKEN');
    const sfToken = config.get<string>('SALESFORCE_ACCESS_TOKEN');
    const sfInstanceUrl = config.get<string>('SALESFORCE_INSTANCE_URL');
    const gmailToken = config.get<string>('GMAIL_ACCESS_TOKEN');
    const gmailUserId = config.get<string>('GMAIL_USER_ID');
    const outreachToken = config.get<string>('OUTREACH_ACCESS_TOKEN');
    const apolloApiKey = config.get<string>('APOLLO_API_KEY');
    this.envConfig = {
      hubspot:
        hubspotToken && hubspotToken.length > 0
          ? { provider: 'hubspot', accessToken: hubspotToken }
          : null,
      salesforce:
        sfToken && sfToken.length > 0 && sfInstanceUrl && sfInstanceUrl.length > 0
          ? {
              provider: 'salesforce',
              accessToken: sfToken,
              instanceUrl: sfInstanceUrl,
            }
          : null,
      gmail:
        gmailToken && gmailToken.length > 0
          ? {
              provider: 'gmail',
              accessToken: gmailToken,
              userId: gmailUserId && gmailUserId.length > 0 ? gmailUserId : null,
            }
          : null,
      outreach:
        outreachToken && outreachToken.length > 0
          ? { provider: 'outreach', accessToken: outreachToken }
          : null,
      apollo:
        apolloApiKey && apolloApiKey.length > 0
          ? { provider: 'apollo', apiKey: apolloApiKey }
          : null,
    };
  }

  resolve(tool: string): Connector | null {
    // Resolved even when execution is disabled, deliberately. The connector's
    // assess() is what lets policy classify the command, so a disabled shell
    // still gets graded and gated — and the caller gets `shell_disabled`,
    // which names the misconfiguration, rather than `no_connector`, which
    // looks like the tool does not exist.
    if (isShellTool(tool)) return this.shell;
    const provider = providerForTool(tool);
    if (!provider) return null;
    const connector = buildConnector(provider, this.envConfig[provider]);
    return connector.supports(tool) ? connector : null;
  }

  async resolveForOrg(orgId: string, tool: string): Promise<Connector | null> {
    if (isShellTool(tool)) return this.shell;
    const provider = providerForTool(tool);
    if (!provider) return null;
    const config = this.credentials
      ? await this.credentials.configForOrg(orgId, provider)
      : this.envConfig[provider];
    const connector = buildConnector(provider, config);
    return connector.supports(tool) ? connector : null;
  }

  list(): { name: string }[] {
    return [...CONNECTOR_PROVIDERS.map((name) => ({ name })), { name: 'shell' }];
  }
}

const CONNECTOR_PROVIDERS: ConnectorProvider[] = [
  'hubspot',
  'salesforce',
  'gmail',
  'outreach',
  'apollo',
];

function isShellTool(tool: string): boolean {
  return (SHELL_TOOLS as readonly string[]).includes(tool);
}

function providerForTool(tool: string): ConnectorProvider | null {
  const [prefix] = tool.split('.');
  return CONNECTOR_PROVIDERS.includes(prefix as ConnectorProvider)
    ? (prefix as ConnectorProvider)
    : null;
}

function buildConnector(
  provider: ConnectorProvider,
  config: ConnectorConfig | null,
): Connector {
  switch (provider) {
    case 'hubspot':
      return new HubspotConnector({
        accessToken: config?.provider === 'hubspot' ? config.accessToken : null,
      });
    case 'salesforce':
      return new SalesforceConnector({
        accessToken: config?.provider === 'salesforce' ? config.accessToken : null,
        instanceUrl: config?.provider === 'salesforce' ? config.instanceUrl : null,
      });
    case 'gmail':
      return new GmailConnector({
        accessToken: config?.provider === 'gmail' ? config.accessToken : null,
        userId: config?.provider === 'gmail' ? config.userId : null,
      });
    case 'outreach':
      return new OutreachConnector({
        accessToken: config?.provider === 'outreach' ? config.accessToken : null,
      });
    case 'apollo':
      return new ApolloConnector({
        apiKey: config?.provider === 'apollo' ? config.apiKey : null,
      });
  }
}
