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

const FieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Fields = z.record(FieldValue);
const SfId = z.string().min(1);

const AccountCreateParams = z.object({ fields: Fields });
const AccountUpdateParams = z.object({ accountId: SfId, fields: Fields });
const AccountGetParams = z.object({
  accountId: SfId,
  fields: z.array(z.string()).optional(),
});

const OpportunityCreateParams = z.object({ fields: Fields });
const OpportunityUpdateParams = z.object({
  opportunityId: SfId,
  fields: Fields,
});
const OpportunityGetParams = z.object({
  opportunityId: SfId,
  fields: z.array(z.string()).optional(),
});

const ContactCreateParams = z.object({ fields: Fields });
const ContactUpdateParams = z.object({ contactId: SfId, fields: Fields });
const ContactGetParams = z.object({
  contactId: SfId,
  fields: z.array(z.string()).optional(),
});

interface ToolDef<T extends z.ZodTypeAny> {
  schema: T;
  request: (
    input: z.infer<T>,
    instanceUrl: string,
  ) => { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; body?: unknown };
}

const API_VERSION = 'v60.0';

function withFieldsQuery(fields?: string[]): string {
  return fields && fields.length
    ? `?fields=${encodeURIComponent(fields.join(','))}`
    : '';
}

const TOOLS = {
  'salesforce.account.create': {
    schema: AccountCreateParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/services/data/${API_VERSION}/sobjects/Account`,
      body: i.fields,
    }),
  } satisfies ToolDef<typeof AccountCreateParams>,
  'salesforce.account.update': {
    schema: AccountUpdateParams,
    request: (i, b) => ({
      method: 'PATCH',
      url: `${b}/services/data/${API_VERSION}/sobjects/Account/${encodeURIComponent(i.accountId)}`,
      body: i.fields,
    }),
  } satisfies ToolDef<typeof AccountUpdateParams>,
  'salesforce.account.get': {
    schema: AccountGetParams,
    request: (i, b) => ({
      method: 'GET',
      url: `${b}/services/data/${API_VERSION}/sobjects/Account/${encodeURIComponent(i.accountId)}${withFieldsQuery(i.fields)}`,
    }),
  } satisfies ToolDef<typeof AccountGetParams>,
  'salesforce.opportunity.create': {
    schema: OpportunityCreateParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/services/data/${API_VERSION}/sobjects/Opportunity`,
      body: i.fields,
    }),
  } satisfies ToolDef<typeof OpportunityCreateParams>,
  'salesforce.opportunity.update': {
    schema: OpportunityUpdateParams,
    request: (i, b) => ({
      method: 'PATCH',
      url: `${b}/services/data/${API_VERSION}/sobjects/Opportunity/${encodeURIComponent(i.opportunityId)}`,
      body: i.fields,
    }),
  } satisfies ToolDef<typeof OpportunityUpdateParams>,
  'salesforce.opportunity.get': {
    schema: OpportunityGetParams,
    request: (i, b) => ({
      method: 'GET',
      url: `${b}/services/data/${API_VERSION}/sobjects/Opportunity/${encodeURIComponent(i.opportunityId)}${withFieldsQuery(i.fields)}`,
    }),
  } satisfies ToolDef<typeof OpportunityGetParams>,
  'salesforce.contact.create': {
    schema: ContactCreateParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/services/data/${API_VERSION}/sobjects/Contact`,
      body: i.fields,
    }),
  } satisfies ToolDef<typeof ContactCreateParams>,
  'salesforce.contact.update': {
    schema: ContactUpdateParams,
    request: (i, b) => ({
      method: 'PATCH',
      url: `${b}/services/data/${API_VERSION}/sobjects/Contact/${encodeURIComponent(i.contactId)}`,
      body: i.fields,
    }),
  } satisfies ToolDef<typeof ContactUpdateParams>,
  'salesforce.contact.get': {
    schema: ContactGetParams,
    request: (i, b) => ({
      method: 'GET',
      url: `${b}/services/data/${API_VERSION}/sobjects/Contact/${encodeURIComponent(i.contactId)}${withFieldsQuery(i.fields)}`,
    }),
  } satisfies ToolDef<typeof ContactGetParams>,
} as const;

export type SalesforceTool = keyof typeof TOOLS;
export const SALESFORCE_TOOLS = Object.keys(TOOLS) as SalesforceTool[];

export interface SalesforceConnectorOptions {
  accessToken?: string | null;
  /** e.g., `https://yourdomain.my.salesforce.com` (or sandbox URL). Required. */
  instanceUrl?: string | null;
  fetchImpl?: typeof fetch;
}

export class SalesforceConnector implements Connector {
  readonly name = 'salesforce';
  private readonly token: string | null;
  private readonly instanceUrl: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SalesforceConnectorOptions = {}) {
    this.token = opts.accessToken ?? null;
    this.instanceUrl = opts.instanceUrl
      ? opts.instanceUrl.replace(/\/$/, '')
      : null;
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
          message: `tool ${tool} not supported by salesforce connector`,
        },
      };
    }
    if (!this.token || !this.instanceUrl) {
      return {
        ok: false,
        error: {
          code: 'connector_not_configured',
          message:
            'SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL must both be set',
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
    const { method, url, body } = def.request(parsed.data, this.instanceUrl);

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
      const arr = Array.isArray(json) ? json : null;
      const first =
        arr && arr[0]
          ? (arr[0] as { errorCode?: string; message?: string })
          : null;
      const msg = first?.message ?? `salesforce returned ${res.status}`;
      return {
        ok: false,
        error: { code: `http_${res.status}`, message: msg, details: json },
      };
    }
    return { ok: true, data: json };
  }
}
