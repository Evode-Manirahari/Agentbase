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

const PeopleMatchParams = z
  .object({
    email: z.string().email().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    organization_name: z.string().optional(),
    domain: z.string().optional(),
    reveal_personal_emails: z.boolean().optional(),
    reveal_phone_number: z.boolean().optional(),
    linkedin_url: z.string().url().optional(),
  })
  .refine(
    (d) =>
      Boolean(d.email) ||
      Boolean(d.linkedin_url) ||
      (Boolean(d.first_name) && Boolean(d.last_name)) ||
      Boolean(d.domain) ||
      Boolean(d.organization_name),
    {
      message:
        'provide at least one of: email, linkedin_url, first_name+last_name, domain, organization_name',
    },
  );

const OrganizationsMatchParams = z.object({
  domain: z.string().min(1),
});

const PeopleSearchParams = z.object({
  q_keywords: z.string().optional(),
  person_titles: z.array(z.string()).optional(),
  organization_domains: z.array(z.string()).optional(),
  organization_locations: z.array(z.string()).optional(),
  page: z.number().int().min(1).optional(),
  per_page: z.number().int().min(1).max(100).optional(),
});

interface ToolDef<T extends z.ZodTypeAny> {
  schema: T;
  request: (
    input: z.infer<T>,
    baseUrl: string,
  ) => { method: 'POST'; url: string; body: unknown };
}

const TOOLS = {
  'apollo.people.match': {
    schema: PeopleMatchParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/v1/people/match`,
      body: i,
    }),
  } satisfies ToolDef<typeof PeopleMatchParams>,
  'apollo.organizations.match': {
    schema: OrganizationsMatchParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/v1/organizations/match`,
      body: i,
    }),
  } satisfies ToolDef<typeof OrganizationsMatchParams>,
  'apollo.people.search': {
    schema: PeopleSearchParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/v1/people/search`,
      body: i,
    }),
  } satisfies ToolDef<typeof PeopleSearchParams>,
} as const;

export type ApolloTool = keyof typeof TOOLS;
export const APOLLO_TOOLS = Object.keys(TOOLS) as ApolloTool[];

export interface ApolloConnectorOptions {
  apiKey?: string | null;
  /** Defaults to https://api.apollo.io */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class ApolloConnector implements Connector {
  readonly name = 'apollo';
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApolloConnectorOptions = {}) {
    this.apiKey = opts.apiKey ?? null;
    this.baseUrl = (opts.baseUrl ?? 'https://api.apollo.io').replace(/\/$/, '');
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
          message: `tool ${tool} not supported by apollo connector`,
        },
      };
    }
    if (!this.apiKey) {
      return {
        ok: false,
        error: {
          code: 'connector_not_configured',
          message: 'APOLLO_API_KEY is not set',
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
          'X-Api-Key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
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
      const apiError =
        (json as { error?: string; errors?: string[] } | null) ?? null;
      const msg =
        apiError?.error ??
        apiError?.errors?.[0] ??
        `apollo returned ${res.status}`;
      return {
        ok: false,
        error: { code: `http_${res.status}`, message: msg, details: json },
      };
    }
    return { ok: true, data: json };
  }
}
