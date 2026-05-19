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

const Recipient = z.union([z.string().email(), z.array(z.string().email())]);

const SendParams = z.object({
  to: Recipient,
  subject: z.string().min(1),
  body: z.string(),
  cc: Recipient.optional(),
  bcc: Recipient.optional(),
  html: z.boolean().optional(),
  /** Set to a thread id to reply within an existing thread. */
  threadId: z.string().optional(),
});

const DraftCreateParams = SendParams;

const DraftSendParams = z.object({
  draftId: z.string().min(1),
});

const MessagesGetParams = z.object({
  messageId: z.string().min(1),
  format: z.enum(['full', 'metadata', 'minimal', 'raw']).optional(),
});

const ThreadsGetParams = z.object({
  threadId: z.string().min(1),
  format: z.enum(['full', 'metadata', 'minimal']).optional(),
});

interface ToolDef<T extends z.ZodTypeAny> {
  schema: T;
  request: (
    input: z.infer<T>,
    baseUrl: string,
    userId: string,
  ) => { method: 'GET' | 'POST'; url: string; body?: unknown };
}

const TOOLS = {
  'gmail.send': {
    schema: SendParams,
    request: (i, b, u) => ({
      method: 'POST',
      url: `${b}/gmail/v1/users/${encodeURIComponent(u)}/messages/send`,
      body: gmailMessage(i),
    }),
  } satisfies ToolDef<typeof SendParams>,
  'gmail.draft.create': {
    schema: DraftCreateParams,
    request: (i, b, u) => ({
      method: 'POST',
      url: `${b}/gmail/v1/users/${encodeURIComponent(u)}/drafts`,
      body: { message: gmailMessage(i) },
    }),
  } satisfies ToolDef<typeof DraftCreateParams>,
  'gmail.draft.send': {
    schema: DraftSendParams,
    request: (i, b, u) => ({
      method: 'POST',
      url: `${b}/gmail/v1/users/${encodeURIComponent(u)}/drafts/send`,
      body: { id: i.draftId },
    }),
  } satisfies ToolDef<typeof DraftSendParams>,
  'gmail.messages.get': {
    schema: MessagesGetParams,
    request: (i, b, u) => {
      const qs = i.format ? `?format=${encodeURIComponent(i.format)}` : '';
      return {
        method: 'GET',
        url: `${b}/gmail/v1/users/${encodeURIComponent(u)}/messages/${encodeURIComponent(i.messageId)}${qs}`,
      };
    },
  } satisfies ToolDef<typeof MessagesGetParams>,
  'gmail.threads.get': {
    schema: ThreadsGetParams,
    request: (i, b, u) => {
      const qs = i.format ? `?format=${encodeURIComponent(i.format)}` : '';
      return {
        method: 'GET',
        url: `${b}/gmail/v1/users/${encodeURIComponent(u)}/threads/${encodeURIComponent(i.threadId)}${qs}`,
      };
    },
  } satisfies ToolDef<typeof ThreadsGetParams>,
} as const;

export type GmailTool = keyof typeof TOOLS;
export const GMAIL_TOOLS = Object.keys(TOOLS) as GmailTool[];

export interface GmailConnectorOptions {
  /** OAuth bearer (an access token). Refresh-token handling is out of scope for v0. */
  accessToken?: string | null;
  /** Defaults to 'me' (the authenticated user). */
  userId?: string | null;
  /** Defaults to https://gmail.googleapis.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class GmailConnector implements Connector {
  readonly name = 'gmail';
  private readonly token: string | null;
  private readonly userId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GmailConnectorOptions = {}) {
    this.token = opts.accessToken ?? null;
    this.userId = opts.userId && opts.userId.length > 0 ? opts.userId : 'me';
    this.baseUrl = (opts.baseUrl ?? 'https://gmail.googleapis.com').replace(/\/$/, '');
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
          message: `tool ${tool} not supported by gmail connector`,
        },
      };
    }
    if (!this.token) {
      return {
        ok: false,
        error: {
          code: 'connector_not_configured',
          message: 'GMAIL_ACCESS_TOKEN is not set',
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
    const { method, url, body } = def.request(parsed.data, this.baseUrl, this.userId);

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
      const apiError = (json as { error?: { message?: string } } | null)?.error;
      const msg = apiError?.message ?? `gmail returned ${res.status}`;
      return {
        ok: false,
        error: { code: `http_${res.status}`, message: msg, details: json },
      };
    }
    return { ok: true, data: json };
  }
}

interface MessageInput {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[] | undefined;
  bcc?: string | string[] | undefined;
  html?: boolean | undefined;
  threadId?: string | undefined;
}

/** Builds the {raw, threadId?} payload Gmail expects for messages.send. */
export function gmailMessage(input: MessageInput): {
  raw: string;
  threadId?: string;
} {
  const result: { raw: string; threadId?: string } = {
    raw: base64UrlEncode(buildRfc2822(input)),
  };
  if (input.threadId) result.threadId = input.threadId;
  return result;
}

function buildRfc2822(input: MessageInput): string {
  const lines: string[] = [];
  lines.push(`To: ${joinAddresses(input.to)}`);
  if (input.cc) lines.push(`Cc: ${joinAddresses(input.cc)}`);
  if (input.bcc) lines.push(`Bcc: ${joinAddresses(input.bcc)}`);
  lines.push(`Subject: ${input.subject}`);
  lines.push('MIME-Version: 1.0');
  lines.push(
    `Content-Type: ${input.html ? 'text/html' : 'text/plain'}; charset="UTF-8"`,
  );
  return `${lines.join('\r\n')}\r\n\r\n${input.body}`;
}

function joinAddresses(v: string | string[]): string {
  return Array.isArray(v) ? v.join(', ') : v;
}

/** UTF-8 → base64url (works in Node 16+ and browsers via global btoa). */
export function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
