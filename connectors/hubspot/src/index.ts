export interface HubspotConnectorConfig {
  accessToken: string;
  baseUrl?: string;
}

export interface ConnectorResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface Connector {
  readonly name: string;
  supports(tool: string): boolean;
  invoke(tool: string, params: Record<string, unknown>): Promise<ConnectorResult>;
}

const HUBSPOT_TOOLS = new Set([
  'hubspot.contacts.update',
  'hubspot.contacts.create',
  'hubspot.deals.update',
  'hubspot.deals.create',
]);

export class HubspotConnector implements Connector {
  readonly name = 'hubspot';
  private readonly baseUrl: string;
  private readonly accessToken: string;

  constructor(cfg: HubspotConnectorConfig) {
    this.accessToken = cfg.accessToken;
    this.baseUrl = (cfg.baseUrl ?? 'https://api.hubapi.com').replace(/\/$/, '');
  }

  supports(tool: string): boolean {
    return HUBSPOT_TOOLS.has(tool);
  }

  async invoke(tool: string, params: Record<string, unknown>): Promise<ConnectorResult> {
    if (!this.supports(tool)) {
      return { ok: false, error: { code: 'unsupported_tool', message: `tool ${tool} not supported by hubspot connector` } };
    }
    return {
      ok: false,
      error: {
        code: 'not_implemented',
        message: `hubspot connector stub: would call ${tool} with ${JSON.stringify(params)}`,
      },
    };
  }
}
