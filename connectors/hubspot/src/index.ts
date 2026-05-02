import { z } from 'zod';

export interface ConnectorError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ConnectorResult {
  ok: boolean;
  data?: unknown;
  error?: ConnectorError;
}

export interface Connector {
  readonly name: string;
  supports(tool: string): boolean;
  invoke(tool: string, params: Record<string, unknown>): Promise<ConnectorResult>;
}

const PropertyValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Properties = z.record(PropertyValue);

const ContactCreateParams = z.object({ properties: Properties });
const ContactUpdateParams = z.object({
  contactId: z.string().min(1),
  properties: Properties,
});
const ContactGetParams = z.object({
  contactId: z.string().min(1),
  properties: z.array(z.string()).optional(),
});
const DealCreateParams = z.object({ properties: Properties });
const DealUpdateParams = z.object({
  dealId: z.string().min(1),
  properties: Properties,
});
const DealGetParams = z.object({
  dealId: z.string().min(1),
  properties: z.array(z.string()).optional(),
});

interface ToolDef<T extends z.ZodTypeAny> {
  schema: T;
  request: (
    input: z.infer<T>,
    baseUrl: string,
  ) => { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; body?: unknown };
}

const TOOLS = {
  'hubspot.contacts.create': {
    schema: ContactCreateParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/crm/v3/objects/contacts`,
      body: { properties: i.properties },
    }),
  } satisfies ToolDef<typeof ContactCreateParams>,
  'hubspot.contacts.update': {
    schema: ContactUpdateParams,
    request: (i, b) => ({
      method: 'PATCH',
      url: `${b}/crm/v3/objects/contacts/${encodeURIComponent(i.contactId)}`,
      body: { properties: i.properties },
    }),
  } satisfies ToolDef<typeof ContactUpdateParams>,
  'hubspot.contacts.get': {
    schema: ContactGetParams,
    request: (i, b) => {
      const qs = i.properties && i.properties.length
        ? `?properties=${encodeURIComponent(i.properties.join(','))}`
        : '';
      return {
        method: 'GET',
        url: `${b}/crm/v3/objects/contacts/${encodeURIComponent(i.contactId)}${qs}`,
      };
    },
  } satisfies ToolDef<typeof ContactGetParams>,
  'hubspot.deals.create': {
    schema: DealCreateParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/crm/v3/objects/deals`,
      body: { properties: i.properties },
    }),
  } satisfies ToolDef<typeof DealCreateParams>,
  'hubspot.deals.update': {
    schema: DealUpdateParams,
    request: (i, b) => ({
      method: 'PATCH',
      url: `${b}/crm/v3/objects/deals/${encodeURIComponent(i.dealId)}`,
      body: { properties: i.properties },
    }),
  } satisfies ToolDef<typeof DealUpdateParams>,
  'hubspot.deals.get': {
    schema: DealGetParams,
    request: (i, b) => {
      const qs = i.properties && i.properties.length
        ? `?properties=${encodeURIComponent(i.properties.join(','))}`
        : '';
      return {
        method: 'GET',
        url: `${b}/crm/v3/objects/deals/${encodeURIComponent(i.dealId)}${qs}`,
      };
    },
  } satisfies ToolDef<typeof DealGetParams>,
} as const;

export type HubspotTool = keyof typeof TOOLS;

export const HUBSPOT_TOOLS = Object.keys(TOOLS) as HubspotTool[];

export interface HubspotConnectorOptions {
  accessToken?: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class HubspotConnector implements Connector {
  readonly name = 'hubspot';
  private readonly token: string | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HubspotConnectorOptions = {}) {
    this.token = opts.accessToken ?? null;
    this.baseUrl = (opts.baseUrl ?? 'https://api.hubapi.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  supports(tool: string): boolean {
    return tool in TOOLS;
  }

  async invoke(
    tool: string,
    params: Record<string, unknown>,
  ): Promise<ConnectorResult> {
    const def = (TOOLS as Record<string, ToolDef<z.ZodTypeAny>>)[tool];
    if (!def) {
      return {
        ok: false,
        error: {
          code: 'unsupported_tool',
          message: `tool ${tool} not supported by hubspot connector`,
        },
      };
    }
    if (!this.token) {
      return {
        ok: false,
        error: {
          code: 'connector_not_configured',
          message: 'HUBSPOT_ACCESS_TOKEN is not set',
        },
      };
    }
    const parsed = def.schema.safeParse(params);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'invalid_params',
          message: 'params failed schema validation',
          details: parsed.error.issues,
        },
      };
    }
    const { method, url, body } = def.request(parsed.data, this.baseUrl);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: body !== undefined ? JSON.stringify(body) : null,
      });
    } catch (err) {
      return {
        ok: false,
        error: { code: 'network_error', message: (err as Error).message },
      };
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }

    if (!res.ok) {
      const msg =
        (json && typeof json === 'object' && 'message' in json
          ? String((json as { message: unknown }).message)
          : null) ?? `hubspot returned ${res.status}`;
      return {
        ok: false,
        error: { code: `http_${res.status}`, message: msg, details: json },
      };
    }
    return { ok: true, data: json };
  }
}
