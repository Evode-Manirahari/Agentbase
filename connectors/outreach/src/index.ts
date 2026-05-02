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

const Attributes = z.record(z.unknown());
const ResourceId = z.union([z.string().min(1), z.number().int()]);

const ProspectCreateParams = z.object({ attributes: Attributes });
const ProspectUpdateParams = z.object({
  prospectId: ResourceId,
  attributes: Attributes,
});
const ProspectGetParams = z.object({ prospectId: ResourceId });

const SequenceEnrollParams = z.object({
  prospectId: ResourceId,
  sequenceId: ResourceId,
  mailboxId: ResourceId,
});

const TaskCreateParams = z.object({
  attributes: Attributes,
  prospectId: ResourceId.optional(),
});

interface ToolDef<T extends z.ZodTypeAny> {
  schema: T;
  request: (
    input: z.infer<T>,
    baseUrl: string,
  ) => { method: 'GET' | 'POST' | 'PATCH'; url: string; body?: unknown };
}

const TOOLS = {
  'outreach.prospects.create': {
    schema: ProspectCreateParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/api/v2/prospects`,
      body: { data: { type: 'prospect', attributes: i.attributes } },
    }),
  } satisfies ToolDef<typeof ProspectCreateParams>,
  'outreach.prospects.update': {
    schema: ProspectUpdateParams,
    request: (i, b) => ({
      method: 'PATCH',
      url: `${b}/api/v2/prospects/${encodeURIComponent(String(i.prospectId))}`,
      body: {
        data: {
          type: 'prospect',
          id: String(i.prospectId),
          attributes: i.attributes,
        },
      },
    }),
  } satisfies ToolDef<typeof ProspectUpdateParams>,
  'outreach.prospects.get': {
    schema: ProspectGetParams,
    request: (i, b) => ({
      method: 'GET',
      url: `${b}/api/v2/prospects/${encodeURIComponent(String(i.prospectId))}`,
    }),
  } satisfies ToolDef<typeof ProspectGetParams>,
  'outreach.sequences.enroll': {
    schema: SequenceEnrollParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/api/v2/sequenceStates`,
      body: {
        data: {
          type: 'sequenceState',
          relationships: {
            prospect: {
              data: { type: 'prospect', id: String(i.prospectId) },
            },
            sequence: {
              data: { type: 'sequence', id: String(i.sequenceId) },
            },
            mailbox: {
              data: { type: 'mailbox', id: String(i.mailboxId) },
            },
          },
        },
      },
    }),
  } satisfies ToolDef<typeof SequenceEnrollParams>,
  'outreach.tasks.create': {
    schema: TaskCreateParams,
    request: (i, b) => {
      const data: Record<string, unknown> = {
        type: 'task',
        attributes: i.attributes,
      };
      if (i.prospectId !== undefined) {
        data.relationships = {
          prospect: {
            data: { type: 'prospect', id: String(i.prospectId) },
          },
        };
      }
      return {
        method: 'POST',
        url: `${b}/api/v2/tasks`,
        body: { data },
      };
    },
  } satisfies ToolDef<typeof TaskCreateParams>,
} as const;

export type OutreachTool = keyof typeof TOOLS;
export const OUTREACH_TOOLS = Object.keys(TOOLS) as OutreachTool[];

export interface OutreachConnectorOptions {
  /** OAuth bearer access token. Refresh-token flow not yet wired. */
  accessToken?: string | null;
  /** Defaults to https://api.outreach.io */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const JSON_API_CONTENT_TYPE = 'application/vnd.api+json';

export class OutreachConnector implements Connector {
  readonly name = 'outreach';
  private readonly token: string | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OutreachConnectorOptions = {}) {
    this.token = opts.accessToken ?? null;
    this.baseUrl = (opts.baseUrl ?? 'https://api.outreach.io').replace(/\/$/, '');
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
          message: `tool ${tool} not supported by outreach connector`,
        },
      };
    }
    if (!this.token) {
      return {
        ok: false,
        error: {
          code: 'connector_not_configured',
          message: 'OUTREACH_ACCESS_TOKEN is not set',
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
          'content-type': JSON_API_CONTENT_TYPE,
          accept: JSON_API_CONTENT_TYPE,
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
      // JSON:API errors: {errors: [{title, detail, status, ...}, ...]}
      const errs = (json as { errors?: { title?: string; detail?: string }[] } | null)?.errors;
      const first = errs && errs[0] ? errs[0] : null;
      const msg =
        first?.detail ?? first?.title ?? `outreach returned ${res.status}`;
      return {
        ok: false,
        error: { code: `http_${res.status}`, message: msg, details: json },
      };
    }
    return { ok: true, data: json };
  }
}
