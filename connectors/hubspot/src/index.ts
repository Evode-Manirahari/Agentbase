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
  // The provider's own identifier for what happened — a Stripe charge id, a
  // GitHub ref sha, a Terraform apply id. Optional because not every provider
  // returns one, but when it exists it is what turns "we logged a success"
  // into "here is their word for it", which is the difference between a claim
  // and evidence.
  providerRef?: string;
}

/**
 * What makes a retry safe against a given provider operation. This is a
 * property of THEIR API, not of our code, so it has to be declared per tool
 * rather than assumed — and getting it wrong in the optimistic direction is
 * how a retry duplicates a payment.
 */
export type IdempotencyMode =
  // The provider honours a key we supply, so our retry is their same request.
  // Stripe's `Idempotency-Key` is the canonical case.
  | 'key'
  // The operation is idempotent by construction: deleting a named resource,
  // setting a field to a fixed value. Repeating it converges rather than
  // duplicating.
  | 'natural'
  // Neither. A retry may produce a second effect, so an attempt we never
  // learned the outcome of must NOT be re-sent without a human establishing
  // what happened.
  | 'none';

export interface ConnectorInvokeContext {
  // Deterministic key for THIS action, stable across retries. Connectors that
  // can pass it to the provider (Stripe's `Idempotency-Key`, GitHub's, etc)
  // should; a provider that honours it collapses our retries into one effect,
  // which is the only thing that makes retrying safe when we cannot tell
  // whether the first attempt landed.
  idempotencyKey?: string;
}

export interface Connector {
  readonly name: string;
  supports(tool: string): boolean;
  invoke(
    tool: string,
    params: Record<string, unknown>,
    ctx?: ConnectorInvokeContext,
  ): Promise<ConnectorResult>;
  /**
   * Declares whether retrying this call is safe. Optional, and a connector that
   * does not implement it is treated as `'none'` — the pessimistic reading.
   * Defaulting the other way would silently convert every unaudited connector
   * into a duplicate-effect risk.
   *
   * Takes params as well as the tool because for some connectors the answer
   * lives in the arguments, not the verb: `shell.run` is safe to repeat when
   * the command is `git status` and catastrophic when it is `npm publish`.
   */
  idempotency?(tool: string, params?: Record<string, unknown>): IdempotencyMode;
}

const PropertyValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Properties = z.record(PropertyValue);
type HubspotProperties = z.infer<typeof Properties>;
const TimestampValue = z.union([z.string().min(1), z.number().int().positive()]);
const SearchValue = z.union([z.string(), z.number(), z.boolean()]);

const AssociationInput = z.object({
  toObjectType: z.string().min(1),
  toObjectId: z.string().min(1),
  associationTypeId: z.union([z.number().int().positive(), z.string().min(1)]),
  associationCategory: z.enum(['HUBSPOT_DEFINED', 'USER_DEFINED']).optional(),
});
type AssociationInput = z.infer<typeof AssociationInput>;

const SearchFilter = z.object({
  propertyName: z.string().min(1),
  operator: z.string().min(1),
  value: SearchValue.optional(),
  values: z.array(SearchValue).min(1).optional(),
  highValue: SearchValue.optional(),
});

const SearchParams = z.object({
  query: z.string().min(1).optional(),
  filterGroups: z
    .array(z.object({ filters: z.array(SearchFilter).min(1) }))
    .min(1)
    .optional(),
  sorts: z
    .array(
      z.union([
        z.string().min(1),
        z.object({
          propertyName: z.string().min(1),
          direction: z.enum(['ASCENDING', 'DESCENDING']),
        }),
      ]),
    )
    .min(1)
    .optional(),
  properties: z.array(z.string().min(1)).min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  after: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
});

const ContactCreateParams = z.object({ properties: Properties });
const ContactUpdateParams = z.object({
  contactId: z.string().min(1),
  properties: Properties,
});
const ContactGetParams = z.object({
  contactId: z.string().min(1),
  properties: z.array(z.string()).optional(),
});
const ContactUpsertParams = z.object({
  email: z.string().email(),
  properties: Properties.optional(),
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
const AssociationParams = z.object({
  fromId: z.string().min(1),
  toObjectType: z.string().min(1),
  toObjectId: z.string().min(1),
  associationTypeId: z.union([z.number().int().positive(), z.string().min(1)]),
});
const NoteCreateParams = z.object({
  body: z.string().min(1).max(65_536),
  timestamp: TimestampValue.optional(),
  ownerId: z.string().min(1).optional(),
  associations: z.array(AssociationInput).min(1).optional(),
});
const TaskCreateParams = z.object({
  subject: z.string().min(1),
  body: z.string().min(1).optional(),
  timestamp: TimestampValue.optional(),
  ownerId: z.string().min(1).optional(),
  status: z.enum(['COMPLETED', 'NOT_STARTED']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  type: z.enum(['EMAIL', 'CALL', 'TODO']).optional(),
  reminderTimestamp: TimestampValue.optional(),
  associations: z.array(AssociationInput).min(1).optional(),
});
const LeadCreateDealParams = z.object({
  contact: z.object({
    email: z.string().email(),
    firstname: z.string().min(1).optional(),
    lastname: z.string().min(1).optional(),
    company: z.string().min(1).optional(),
    jobtitle: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    properties: Properties.optional(),
  }),
  deal: z.object({
    dealname: z.string().min(1),
    amount: z.union([z.number(), z.string().min(1)]).optional(),
    pipeline: z.string().min(1).optional(),
    dealstage: z.string().min(1).optional(),
    closedate: z.union([z.string().min(1), z.number().int().positive()]).optional(),
    properties: Properties.optional(),
  }),
  note: z
    .object({
      body: z.string().min(1).max(65_536),
      timestamp: TimestampValue.optional(),
      ownerId: z.string().min(1).optional(),
    })
    .optional(),
});

type ContactUpsertParams = z.infer<typeof ContactUpsertParams>;
type LeadCreateDealParams = z.infer<typeof LeadCreateDealParams>;

interface HubspotRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
}

interface ToolDef<T extends z.ZodTypeAny> {
  schema: T;
  request: (input: z.infer<T>, baseUrl: string) => HubspotRequest;
}

const REQUEST_TOOLS = {
  'hubspot.connection.test': {
    schema: z.object({}).strict(),
    request: (_i, b) => ({
      method: 'GET',
      url: `${b}/crm/v3/objects/contacts?limit=1&properties=email`,
    }),
  } satisfies ToolDef<z.ZodObject<Record<string, never>>>,
  'hubspot.contacts.search': {
    schema: SearchParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/crm/v3/objects/contacts/search`,
      body: omitUndefined({
        query: i.query,
        filterGroups: i.filterGroups,
        sorts: i.sorts,
        properties: i.properties,
        limit: i.limit,
        after: i.after,
      }),
    }),
  } satisfies ToolDef<typeof SearchParams>,
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
  'hubspot.contacts.associate': {
    schema: AssociationParams,
    request: (i, b) => ({
      method: 'PUT',
      url:
        `${b}/crm/v3/objects/contacts/${encodeURIComponent(i.fromId)}` +
        `/associations/${encodeURIComponent(i.toObjectType)}` +
        `/${encodeURIComponent(i.toObjectId)}` +
        `/${encodeURIComponent(String(i.associationTypeId))}`,
    }),
  } satisfies ToolDef<typeof AssociationParams>,
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
  'hubspot.deals.associate': {
    schema: AssociationParams,
    request: (i, b) => ({
      method: 'PUT',
      url:
        `${b}/crm/v3/objects/deals/${encodeURIComponent(i.fromId)}` +
        `/associations/${encodeURIComponent(i.toObjectType)}` +
        `/${encodeURIComponent(i.toObjectId)}` +
        `/${encodeURIComponent(String(i.associationTypeId))}`,
    }),
  } satisfies ToolDef<typeof AssociationParams>,
  'hubspot.notes.create': {
    schema: NoteCreateParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/crm/v3/objects/notes`,
      body: omitUndefined({
        properties: omitUndefined({
          hs_timestamp: i.timestamp ?? new Date().toISOString(),
          hs_note_body: i.body,
          hubspot_owner_id: i.ownerId,
        }),
        associations: associationsPayload(i.associations),
      }),
    }),
  } satisfies ToolDef<typeof NoteCreateParams>,
  'hubspot.tasks.create': {
    schema: TaskCreateParams,
    request: (i, b) => ({
      method: 'POST',
      url: `${b}/crm/v3/objects/tasks`,
      body: omitUndefined({
        properties: omitUndefined({
          hs_timestamp:
            i.timestamp ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          hs_task_subject: i.subject,
          hs_task_body: i.body,
          hubspot_owner_id: i.ownerId,
          hs_task_status: i.status ?? 'NOT_STARTED',
          hs_task_priority: i.priority,
          hs_task_type: i.type ?? 'TODO',
          hs_task_reminders: i.reminderTimestamp,
        }),
        associations: associationsPayload(i.associations),
      }),
    }),
  } satisfies ToolDef<typeof TaskCreateParams>,
} as const;

const CUSTOM_TOOL_SCHEMAS = {
  'hubspot.contacts.upsert': ContactUpsertParams,
  'hubspot.leads.create_deal': LeadCreateDealParams,
} as const;

export type HubspotTool =
  | keyof typeof REQUEST_TOOLS
  | keyof typeof CUSTOM_TOOL_SCHEMAS;

export const HUBSPOT_TOOLS = [
  ...Object.keys(REQUEST_TOOLS),
  ...Object.keys(CUSTOM_TOOL_SCHEMAS),
] as HubspotTool[];

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
    return tool in REQUEST_TOOLS || tool in CUSTOM_TOOL_SCHEMAS;
  }

  async invoke(
    tool: string,
    params: Record<string, unknown>,
  ): Promise<ConnectorResult> {
    const missingToken = this.missingTokenResult();
    if (missingToken) return missingToken;

    const def = (REQUEST_TOOLS as Record<string, ToolDef<z.ZodTypeAny>>)[tool];
    if (def) {
      const parsed = def.schema.safeParse(params);
      if (!parsed.success) return invalidParams(parsed.error);
      return this.send(def.request(parsed.data, this.baseUrl));
    }

    if (tool === 'hubspot.contacts.upsert') {
      const parsed = ContactUpsertParams.safeParse(params);
      if (!parsed.success) return invalidParams(parsed.error);
      return this.upsertContact(parsed.data);
    }

    if (tool === 'hubspot.leads.create_deal') {
      const parsed = LeadCreateDealParams.safeParse(params);
      if (!parsed.success) return invalidParams(parsed.error);
      return this.createDealFromLead(parsed.data);
    }

    return {
      ok: false,
      error: {
        code: 'unsupported_tool',
        message: `tool ${tool} not supported by hubspot connector`,
      },
    };
  }

  private missingTokenResult(): ConnectorResult | null {
    if (this.token) return null;
    return {
      ok: false,
      error: {
        code: 'connector_not_configured',
        message: 'HubSpot access token is not configured',
      },
    };
  }

  private async upsertContact(input: ContactUpsertParams): Promise<ConnectorResult> {
    const properties = omitUndefinedProperties({
      ...(input.properties ?? {}),
      email: input.email,
    });
    const search = await this.send({
      method: 'POST',
      url: `${this.baseUrl}/crm/v3/objects/contacts/search`,
      body: {
        limit: 1,
        properties: Array.from(
          new Set(['email', ...Object.keys(properties)]),
        ),
        filterGroups: [
          {
            filters: [
              {
                propertyName: 'email',
                operator: 'EQ',
                value: input.email,
              },
            ],
          },
        ],
      },
    });
    if (!search.ok) return search;

    const existing = firstResult(search.data);
    const existingId = objectId(existing);
    if (existingId) {
      const updated = await this.send({
        method: 'PATCH',
        url: `${this.baseUrl}/crm/v3/objects/contacts/${encodeURIComponent(existingId)}`,
        body: { properties },
      });
      if (!updated.ok) return updated;
      return {
        ok: true,
        data: { operation: 'updated', contact: updated.data },
      };
    }

    const created = await this.send({
      method: 'POST',
      url: `${this.baseUrl}/crm/v3/objects/contacts`,
      body: { properties },
    });
    if (!created.ok) return created;
    return {
      ok: true,
      data: { operation: 'created', contact: created.data },
    };
  }

  private async createDealFromLead(
    input: LeadCreateDealParams,
  ): Promise<ConnectorResult> {
    const contactProperties = omitUndefinedProperties({
      ...(input.contact.properties ?? {}),
      email: input.contact.email,
      firstname: input.contact.firstname,
      lastname: input.contact.lastname,
      company: input.contact.company,
      jobtitle: input.contact.jobtitle,
      phone: input.contact.phone,
      lifecyclestage:
        input.contact.properties?.lifecyclestage ?? 'salesqualifiedlead',
    });
    const contactResult = await this.upsertContact({
      email: input.contact.email,
      properties: contactProperties,
    });
    if (!contactResult.ok) return contactResult;

    const contact = readObject(contactResult.data, 'contact');
    const contactId = objectId(contact);
    if (!contactId) {
      return invalidHubspotResponse(
        'HubSpot contact upsert response did not include an id',
        contactResult.data,
      );
    }

    const dealProperties = omitUndefinedProperties({
      ...(input.deal.properties ?? {}),
      dealname: input.deal.dealname,
      amount: input.deal.amount,
      pipeline: input.deal.pipeline,
      dealstage: input.deal.dealstage,
      closedate: input.deal.closedate,
    });
    const dealResult = await this.send({
      method: 'POST',
      url: `${this.baseUrl}/crm/v3/objects/deals`,
      body: { properties: dealProperties },
    });
    if (!dealResult.ok) return dealResult;

    const dealId = objectId(dealResult.data);
    if (!dealId) {
      return invalidHubspotResponse(
        'HubSpot deal create response did not include an id',
        dealResult.data,
      );
    }

    const associationResult = await this.send({
      method: 'PUT',
      url:
        `${this.baseUrl}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}` +
        `/associations/deals/${encodeURIComponent(dealId)}/4`,
    });
    if (!associationResult.ok) return associationResult;

    let note: unknown = null;
    if (input.note) {
      const noteResult = await this.send({
        method: 'POST',
        url: `${this.baseUrl}/crm/v3/objects/notes`,
        body: {
          properties: omitUndefined({
            hs_timestamp: input.note.timestamp ?? new Date().toISOString(),
            hs_note_body: input.note.body,
            hubspot_owner_id: input.note.ownerId,
          }),
          associations: associationsPayload([
            {
              toObjectType: 'contact',
              toObjectId: contactId,
              associationTypeId: 202,
            },
            {
              toObjectType: 'deal',
              toObjectId: dealId,
              associationTypeId: 214,
            },
          ]),
        },
      });
      if (!noteResult.ok) return noteResult;
      note = noteResult.data ?? null;
    }

    return {
      ok: true,
      data: {
        contact: contactResult.data,
        deal: dealResult.data,
        association: associationResult.data ?? null,
        note,
      },
    };
  }

  private async send(req: HubspotRequest): Promise<ConnectorResult> {
    let res: Response;
    try {
      const init: RequestInit = {
        method: req.method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
      };
      if (req.body !== undefined) {
        init.body = JSON.stringify(req.body);
      }
      res = await this.fetchImpl(req.url, init);
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

function invalidParams(error: z.ZodError): ConnectorResult {
  return {
    ok: false,
    error: {
      code: 'invalid_params',
      message: 'params failed schema validation',
      details: error.issues,
    },
  };
}

function invalidHubspotResponse(message: string, details: unknown): ConnectorResult {
  return {
    ok: false,
    error: { code: 'invalid_hubspot_response', message, details },
  };
}

function associationsPayload(items: AssociationInput[] | undefined) {
  if (!items || items.length === 0) return undefined;
  return items.map((item) => ({
    to: { id: item.toObjectId },
    types: [
      {
        associationCategory: item.associationCategory ?? 'HUBSPOT_DEFINED',
        associationTypeId: item.associationTypeId,
      },
    ],
  }));
}

function firstResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  const results = (value as { results?: unknown }).results;
  return Array.isArray(results) ? results[0] ?? null : null;
}

function objectId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function readObject(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return null;
  const found = (value as Record<string, unknown>)[key];
  return found && typeof found === 'object' ? found : null;
}

function omitUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function omitUndefinedProperties(
  input: Record<string, HubspotProperties[string] | undefined>,
): HubspotProperties {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as HubspotProperties;
}
