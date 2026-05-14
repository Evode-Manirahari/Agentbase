import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import {
  connectorCredentials,
  type ConnectorCredential,
  type EncryptedConnectorConfig,
} from '@dejavas/db';
import {
  ConnectorProvider,
  type ConnectorProvider as ConnectorProviderT,
} from '@dejavas/shared';

const PROVIDERS = ConnectorProvider.options;
const HUBSPOT_AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN_URL = 'https://api.hubspot.com/oauth/v3/token';
const HUBSPOT_INTROSPECT_URL = 'https://api.hubspot.com/oauth/v3/token/introspect';
const HUBSPOT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_HUBSPOT_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
];

const CredentialSchemas = {
  hubspot: z.object({
    access_token: z.string().min(1),
  }),
  salesforce: z.object({
    access_token: z.string().min(1),
    instance_url: z.string().url(),
  }),
  gmail: z.object({
    access_token: z.string().min(1),
    user_id: z.string().min(1).optional(),
  }),
  outreach: z.object({
    access_token: z.string().min(1),
  }),
  apollo: z.object({
    api_key: z.string().min(1),
  }),
} satisfies Record<ConnectorProviderT, z.ZodTypeAny>;

export const CONNECTOR_FIELD_DEFS: Record<
  ConnectorProviderT,
  { key: string; label: string; secret: boolean; placeholder?: string }[]
> = {
  hubspot: [
    { key: 'access_token', label: 'Access token', secret: true, placeholder: 'pat-...' },
  ],
  salesforce: [
    { key: 'access_token', label: 'Access token', secret: true },
    {
      key: 'instance_url',
      label: 'Instance URL',
      secret: false,
      placeholder: 'https://yourdomain.my.salesforce.com',
    },
  ],
  gmail: [
    { key: 'access_token', label: 'Access token', secret: true },
    { key: 'user_id', label: 'User ID', secret: false, placeholder: 'me' },
  ],
  outreach: [
    { key: 'access_token', label: 'Access token', secret: true },
  ],
  apollo: [
    { key: 'api_key', label: 'API key', secret: true },
  ],
};

export type ConnectorConfig =
  | { provider: 'hubspot'; accessToken: string }
  | { provider: 'salesforce'; accessToken: string; instanceUrl: string }
  | { provider: 'gmail'; accessToken: string; userId: string | null }
  | { provider: 'outreach'; accessToken: string }
  | { provider: 'apollo'; apiKey: string };

export interface ConnectorStatus {
  provider: ConnectorProviderT;
  configured: boolean;
  enabled: boolean;
  source: 'org' | 'env' | null;
  auth_type: 'oauth' | 'static' | 'env' | null;
  updated_at: string | null;
  fields: typeof CONNECTOR_FIELD_DEFS[ConnectorProviderT];
  oauth_available: boolean;
  account: ConnectorAccount | null;
}

export interface ConnectorAccount {
  hub_id?: number | string | null;
  hub_domain?: string | null;
  user?: string | null;
  scopes?: string[];
  expires_at?: string | null;
}

interface HubspotOAuthState {
  v: 1;
  provider: 'hubspot';
  orgId: string;
  actorId: string;
  exp: number;
  nonce: string;
}

const HubspotTokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  hub_id: z.union([z.number(), z.string()]).optional(),
  scopes: z.array(z.string()).optional(),
  token_type: z.string().optional(),
});

const HubspotIntrospectionResponse = z.object({
  active: z.boolean().optional(),
  hub_id: z.union([z.number(), z.string()]).optional(),
  user_id: z.union([z.number(), z.string()]).optional(),
  user: z.string().optional(),
  hub_domain: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  app_id: z.union([z.number(), z.string()]).optional(),
}).passthrough();

type HubspotTokenResponse = z.infer<typeof HubspotTokenResponse>;
type HubspotIntrospectionResponse = z.infer<typeof HubspotIntrospectionResponse>;

interface HubspotOAuthConfig {
  auth_type: 'oauth';
  access_token: string;
  refresh_token: string;
  expires_at: string;
  hub_id?: number | string | null;
  scopes?: string[];
  account?: {
    hub_id?: number | string | null;
    hub_domain?: string | null;
    user?: string | null;
    user_id?: number | string | null;
    app_id?: number | string | null;
  } | undefined;
}

@Injectable()
export class ConnectorCredentialsService {
  private readonly log = new Logger(ConnectorCredentialsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  async listForOrg(orgId: string): Promise<{ items: ConnectorStatus[] }> {
    const rows = await this.db
      .select()
      .from(connectorCredentials)
      .where(eq(connectorCredentials.orgId, orgId));
    const byProvider = new Map(rows.map((r) => [r.provider, r]));

    return {
      items: PROVIDERS.map((provider) => {
        const row = byProvider.get(provider);
        if (row) {
          const raw = row.enabled ? this.decrypt(row.encryptedConfig) : {};
          return {
            provider,
            configured: row.enabled,
            enabled: row.enabled,
            source: 'org' as const,
            auth_type: row.enabled ? authTypeFor(provider, raw) : null,
            updated_at: row.updatedAt.toISOString(),
            fields: CONNECTOR_FIELD_DEFS[provider],
            oauth_available: provider === 'hubspot' ? this.hubspotOAuthAvailable() : false,
            account: row.enabled ? accountFor(provider, raw) : null,
          };
        }
        const env = this.configFromEnv(provider);
        return {
          provider,
          configured: Boolean(env),
          enabled: Boolean(env),
          source: env ? ('env' as const) : null,
          auth_type: env ? ('env' as const) : null,
          updated_at: null,
          fields: CONNECTOR_FIELD_DEFS[provider],
          oauth_available: provider === 'hubspot' ? this.hubspotOAuthAvailable() : false,
          account: null,
        };
      }),
    };
  }

  async upsert(input: {
    orgId: string;
    provider: ConnectorProviderT;
    credentials: Record<string, string>;
    actorId: string;
  }): Promise<ConnectorStatus> {
    const parsedProvider = ConnectorProvider.safeParse(input.provider);
    if (!parsedProvider.success) {
      throw new BadRequestException(`unsupported connector provider ${input.provider}`);
    }

    const parsed = CredentialSchemas[input.provider].safeParse(input.credentials);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'connector credentials failed schema validation',
        issues: parsed.error.issues,
      });
    }

    const encrypted = this.encrypt({
      auth_type: 'static',
      ...(parsed.data as Record<string, unknown>),
    });
    const now = new Date();
    const [row] = await this.db
      .insert(connectorCredentials)
      .values({
        orgId: input.orgId,
        provider: input.provider,
        encryptedConfig: encrypted,
        enabled: true,
        createdBy: input.actorId,
        updatedBy: input.actorId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectorCredentials.orgId, connectorCredentials.provider],
        set: {
          encryptedConfig: encrypted,
          enabled: true,
          updatedBy: input.actorId,
          updatedAt: now,
        },
      })
      .returning();

    return {
      provider: input.provider,
      configured: true,
      enabled: true,
      source: 'org',
      auth_type: 'static',
      updated_at: row?.updatedAt.toISOString() ?? now.toISOString(),
      fields: CONNECTOR_FIELD_DEFS[input.provider],
      oauth_available:
        input.provider === 'hubspot' ? this.hubspotOAuthAvailable() : false,
      account: null,
    };
  }

  async disable(input: {
    orgId: string;
    provider: ConnectorProviderT;
    actorId: string;
  }): Promise<ConnectorStatus> {
    const parsedProvider = ConnectorProvider.safeParse(input.provider);
    if (!parsedProvider.success) {
      throw new BadRequestException(`unsupported connector provider ${input.provider}`);
    }

    const now = new Date();
    const encrypted = this.encrypt({});
    await this.db
      .insert(connectorCredentials)
      .values({
        orgId: input.orgId,
        provider: input.provider,
        encryptedConfig: encrypted,
        enabled: false,
        createdBy: input.actorId,
        updatedBy: input.actorId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectorCredentials.orgId, connectorCredentials.provider],
        set: { enabled: false, updatedBy: input.actorId, updatedAt: now },
      });

    return {
      provider: input.provider,
      configured: false,
      enabled: false,
      source: 'org',
      auth_type: null,
      updated_at: now.toISOString(),
      fields: CONNECTOR_FIELD_DEFS[input.provider],
      oauth_available:
        input.provider === 'hubspot' ? this.hubspotOAuthAvailable() : false,
      account: null,
    };
  }

  async configForOrg(
    orgId: string,
    provider: ConnectorProviderT,
  ): Promise<ConnectorConfig | null> {
    const [row] = await this.db
      .select()
      .from(connectorCredentials)
      .where(
        and(
          eq(connectorCredentials.orgId, orgId),
          eq(connectorCredentials.provider, provider),
        ),
      )
      .limit(1);

    if (row) {
      if (!row.enabled) return null;
      const raw = this.decrypt(row.encryptedConfig);
      if (provider === 'hubspot' && raw.auth_type === 'oauth') {
        return this.configFromHubspotOAuthRow(row, raw);
      }
      return normalizeConfig(provider, raw);
    }

    return this.configFromEnv(provider);
  }

  hubspotOAuthAvailable(): boolean {
    return Boolean(this.hubspotClientId() && this.hubspotClientSecret());
  }

  startHubspotOAuth(input: {
    orgId: string;
    actorId: string;
  }): { authorization_url: string; expires_at: string; redirect_uri: string; scopes: string[] } {
    const clientId = this.hubspotClientId();
    const clientSecret = this.hubspotClientSecret();
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        'HubSpot OAuth is not configured. Set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET.',
      );
    }

    const expiresAt = Date.now() + HUBSPOT_OAUTH_STATE_TTL_MS;
    const scopes = this.hubspotScopes();
    const redirectUri = this.hubspotRedirectUri();
    const state = this.signOAuthState({
      v: 1,
      provider: 'hubspot',
      orgId: input.orgId,
      actorId: input.actorId,
      exp: expiresAt,
      nonce: randomBytes(16).toString('base64url'),
    });
    const url = new URL(HUBSPOT_AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);

    return {
      authorization_url: url.toString(),
      expires_at: new Date(expiresAt).toISOString(),
      redirect_uri: redirectUri,
      scopes,
    };
  }

  async completeHubspotOAuth(input: {
    code: string;
    state: string;
  }): Promise<ConnectorStatus> {
    const state = this.verifyOAuthState(input.state);
    const token = await this.requestHubspotToken({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.hubspotRedirectUri(),
    });
    if (!token.refresh_token) {
      throw new BadRequestException('HubSpot OAuth response did not include a refresh token');
    }
    const account = await this.introspectHubspotRefreshToken(token.refresh_token);
    const now = new Date();
    const encrypted = this.encrypt(hubspotOAuthConfigFromToken(token, account));

    const [row] = await this.db
      .insert(connectorCredentials)
      .values({
        orgId: state.orgId,
        provider: 'hubspot',
        encryptedConfig: encrypted,
        enabled: true,
        createdBy: state.actorId,
        updatedBy: state.actorId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [connectorCredentials.orgId, connectorCredentials.provider],
        set: {
          encryptedConfig: encrypted,
          enabled: true,
          updatedBy: state.actorId,
          updatedAt: now,
        },
      })
      .returning();

    const raw = this.decrypt(row?.encryptedConfig ?? encrypted);
    return {
      provider: 'hubspot',
      configured: true,
      enabled: true,
      source: 'org',
      auth_type: 'oauth',
      updated_at: row?.updatedAt.toISOString() ?? now.toISOString(),
      fields: CONNECTOR_FIELD_DEFS.hubspot,
      oauth_available: true,
      account: accountFor('hubspot', raw),
    };
  }

  configFromEnv(provider: ConnectorProviderT): ConnectorConfig | null {
    switch (provider) {
      case 'hubspot': {
        const accessToken = nonEmpty(this.config.get<string>('HUBSPOT_ACCESS_TOKEN'));
        return accessToken ? { provider, accessToken } : null;
      }
      case 'salesforce': {
        const accessToken = nonEmpty(this.config.get<string>('SALESFORCE_ACCESS_TOKEN'));
        const instanceUrl = nonEmpty(this.config.get<string>('SALESFORCE_INSTANCE_URL'));
        return accessToken && instanceUrl ? { provider, accessToken, instanceUrl } : null;
      }
      case 'gmail': {
        const accessToken = nonEmpty(this.config.get<string>('GMAIL_ACCESS_TOKEN'));
        const userId = nonEmpty(this.config.get<string>('GMAIL_USER_ID'));
        return accessToken ? { provider, accessToken, userId } : null;
      }
      case 'outreach': {
        const accessToken = nonEmpty(this.config.get<string>('OUTREACH_ACCESS_TOKEN'));
        return accessToken ? { provider, accessToken } : null;
      }
      case 'apollo': {
        const apiKey = nonEmpty(this.config.get<string>('APOLLO_API_KEY'));
        return apiKey ? { provider, apiKey } : null;
      }
    }
  }

  private async configFromHubspotOAuthRow(
    row: ConnectorCredential,
    raw: Record<string, unknown>,
  ): Promise<ConnectorConfig | null> {
    const parsed = parseHubspotOAuthConfig(raw);
    if (!parsed) return null;

    if (Date.parse(parsed.expires_at) - Date.now() > TOKEN_REFRESH_SKEW_MS) {
      return { provider: 'hubspot', accessToken: parsed.access_token };
    }

    const refreshed = await this.requestHubspotToken({
      grant_type: 'refresh_token',
      refresh_token: parsed.refresh_token,
    });
    const nextConfig = hubspotOAuthConfigFromToken(refreshed, parsed.account, {
      previousRefreshToken: parsed.refresh_token,
      previousHubId: parsed.hub_id,
      previousScopes: parsed.scopes,
    });
    await this.db
      .update(connectorCredentials)
      .set({
        encryptedConfig: this.encrypt(nextConfig),
        updatedAt: new Date(),
      })
      .where(eq(connectorCredentials.id, row.id));

    return { provider: 'hubspot', accessToken: nextConfig.access_token };
  }

  private async requestHubspotToken(input: {
    grant_type: 'authorization_code' | 'refresh_token';
    code?: string;
    refresh_token?: string;
    redirect_uri?: string;
  }): Promise<HubspotTokenResponse> {
    const clientId = this.hubspotClientId();
    const clientSecret = this.hubspotClientSecret();
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        'HubSpot OAuth is not configured. Set HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET.',
      );
    }

    const body = new URLSearchParams({
      grant_type: input.grant_type,
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (input.code) body.set('code', input.code);
    if (input.refresh_token) body.set('refresh_token', input.refresh_token);
    if (input.redirect_uri) body.set('redirect_uri', input.redirect_uri);

    const res = await fetch(HUBSPOT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await readJson(res);
    if (!res.ok) {
      throw new BadRequestException({
        message: 'HubSpot OAuth token request failed',
        status: res.status,
        details: json,
      });
    }
    const parsed = HubspotTokenResponse.safeParse(json);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'HubSpot OAuth token response failed schema validation',
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  private async introspectHubspotRefreshToken(
    refreshToken: string,
  ): Promise<HubspotIntrospectionResponse | null> {
    const clientId = this.hubspotClientId();
    const clientSecret = this.hubspotClientSecret();
    if (!clientId || !clientSecret) return null;

    const res = await fetch(HUBSPOT_INTROSPECT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token_type_hint: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const json = await readJson(res);
    if (!res.ok) {
      this.log.warn(`HubSpot token introspection failed with HTTP ${res.status}`);
      return null;
    }
    const parsed = HubspotIntrospectionResponse.safeParse(json);
    if (!parsed.success) return null;
    return parsed.data;
  }

  private signOAuthState(payload: HubspotOAuthState): string {
    const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = createHmac('sha256', this.key()).update(data).digest('base64url');
    return `${data}.${sig}`;
  }

  private verifyOAuthState(state: string): HubspotOAuthState {
    const [data, sig] = state.split('.');
    if (!data || !sig) throw new BadRequestException('invalid OAuth state');
    const expected = createHmac('sha256', this.key()).update(data).digest('base64url');
    const actualBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new BadRequestException('invalid OAuth state signature');
    }

    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestException('invalid OAuth state payload');
    }
    if (!isHubspotOAuthState(payload)) {
      throw new BadRequestException('invalid OAuth state payload');
    }
    if (payload.exp < Date.now()) {
      throw new BadRequestException('expired OAuth state');
    }
    return payload;
  }

  private hubspotClientId(): string | null {
    return nonEmpty(this.config.get<string>('HUBSPOT_CLIENT_ID'));
  }

  private hubspotClientSecret(): string | null {
    return nonEmpty(this.config.get<string>('HUBSPOT_CLIENT_SECRET'));
  }

  private hubspotScopes(): string[] {
    const raw = nonEmpty(this.config.get<string>('HUBSPOT_SCOPES'));
    return raw
      ? raw.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean)
      : DEFAULT_HUBSPOT_SCOPES;
  }

  private hubspotRedirectUri(): string {
    const explicit = nonEmpty(this.config.get<string>('HUBSPOT_REDIRECT_URI'));
    if (explicit) return explicit;

    const base =
      nonEmpty(this.config.get<string>('API_PUBLIC_URL')) ??
      nonEmpty(this.config.get<string>('PUBLIC_BASE_URL')) ??
      `http://localhost:${nonEmpty(this.config.get<string>('PORT')) ?? '3002'}`;
    return `${base.replace(/\/$/, '')}/v1/connectors/hubspot/oauth/callback`;
  }

  private encrypt(value: unknown): EncryptedConnectorConfig {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64url'),
      tag: tag.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
  }

  private decrypt(encrypted: EncryptedConnectorConfig): Record<string, unknown> {
    if (encrypted.v !== 1 || encrypted.alg !== 'aes-256-gcm') {
      throw new InternalServerErrorException('unsupported connector credential envelope');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(encrypted.iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
  }

  private key(): Buffer {
    const raw = nonEmpty(this.config.get<string>('CONNECTOR_CREDENTIALS_KEY'));
    if (!raw && this.config.get<string>('NODE_ENV') === 'production') {
      throw new InternalServerErrorException(
        'CONNECTOR_CREDENTIALS_KEY must be set before storing connector credentials in production',
      );
    }
    if (!raw) {
      this.log.warn(
        'CONNECTOR_CREDENTIALS_KEY not set — using local development encryption key',
      );
    }
    if (raw?.startsWith('base64:')) {
      const key = Buffer.from(raw.slice('base64:'.length), 'base64');
      if (key.length === 32) return key;
    }
    if (raw?.startsWith('hex:')) {
      const key = Buffer.from(raw.slice('hex:'.length), 'hex');
      if (key.length === 32) return key;
    }
    return createHash('sha256')
      .update(raw ?? 'dejavas-local-dev-connector-credentials-key')
      .digest();
  }
}

function normalizeConfig(
  provider: ConnectorProviderT,
  raw: Record<string, unknown>,
): ConnectorConfig {
  switch (provider) {
    case 'hubspot':
      return { provider, accessToken: String(raw.access_token) };
    case 'salesforce':
      return {
        provider,
        accessToken: String(raw.access_token),
        instanceUrl: String(raw.instance_url),
      };
    case 'gmail':
      return {
        provider,
        accessToken: String(raw.access_token),
        userId: typeof raw.user_id === 'string' ? raw.user_id : null,
      };
    case 'outreach':
      return { provider, accessToken: String(raw.access_token) };
    case 'apollo':
      return { provider, apiKey: String(raw.api_key) };
  }
}

function hubspotOAuthConfigFromToken(
  token: HubspotTokenResponse,
  account: HubspotIntrospectionResponse | HubspotOAuthConfig['account'] | null,
  previous: {
    previousRefreshToken?: string;
    previousHubId?: number | string | null | undefined;
    previousScopes?: string[] | undefined;
  } = {},
): HubspotOAuthConfig {
  const accountInfo = normalizeHubspotAccount(account);
  const config: HubspotOAuthConfig = {
    auth_type: 'oauth',
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? previous.previousRefreshToken ?? '',
    expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    hub_id: token.hub_id ?? accountInfo?.hub_id ?? previous.previousHubId ?? null,
    scopes: token.scopes ?? accountInfo?.scopes ?? previous.previousScopes ?? [],
  };
  if (accountInfo) config.account = accountInfo;
  return config;
}

function parseHubspotOAuthConfig(
  raw: Record<string, unknown>,
): HubspotOAuthConfig | null {
  if (raw.auth_type !== 'oauth') return null;
  if (typeof raw.access_token !== 'string' || raw.access_token.length === 0) return null;
  if (typeof raw.refresh_token !== 'string' || raw.refresh_token.length === 0) {
    return null;
  }
  if (typeof raw.expires_at !== 'string' || Number.isNaN(Date.parse(raw.expires_at))) {
    return null;
  }
  const config: HubspotOAuthConfig = {
    auth_type: 'oauth',
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: raw.expires_at,
    hub_id:
      typeof raw.hub_id === 'string' || typeof raw.hub_id === 'number'
        ? raw.hub_id
        : null,
    scopes: Array.isArray(raw.scopes)
      ? raw.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
  };
  if (raw.account && typeof raw.account === 'object') {
    const account = normalizeHubspotAccount(raw.account as Record<string, unknown>);
    if (account) config.account = account;
  }
  return config;
}

function authTypeFor(
  provider: ConnectorProviderT,
  raw: Record<string, unknown>,
): ConnectorStatus['auth_type'] {
  if (provider === 'hubspot' && raw.auth_type === 'oauth') return 'oauth';
  return 'static';
}

function accountFor(
  provider: ConnectorProviderT,
  raw: Record<string, unknown>,
): ConnectorAccount | null {
  if (provider !== 'hubspot' || raw.auth_type !== 'oauth') return null;
  const parsed = parseHubspotOAuthConfig(raw);
  if (!parsed) return null;
  return {
    hub_id: parsed.account?.hub_id ?? parsed.hub_id ?? null,
    hub_domain: parsed.account?.hub_domain ?? null,
    user: parsed.account?.user ?? null,
    scopes: parsed.scopes ?? [],
    expires_at: parsed.expires_at,
  };
}

function normalizeHubspotAccount(
  account: HubspotIntrospectionResponse | Record<string, unknown> | null | undefined,
): (HubspotOAuthConfig['account'] & { scopes?: string[] }) | null {
  if (!account || typeof account !== 'object') return null;
  const hubId = account.hub_id;
  const userId = account.user_id;
  const appId = account.app_id;
  const scopes = Array.isArray(account.scopes)
    ? account.scopes.filter((scope): scope is string => typeof scope === 'string')
    : null;
  const normalized: HubspotOAuthConfig['account'] & { scopes?: string[] } = {
    hub_id: typeof hubId === 'number' || typeof hubId === 'string' ? hubId : null,
    hub_domain:
      typeof account.hub_domain === 'string' ? account.hub_domain : null,
    user: typeof account.user === 'string' ? account.user : null,
    user_id: typeof userId === 'number' || typeof userId === 'string' ? userId : null,
    app_id: typeof appId === 'number' || typeof appId === 'string' ? appId : null,
  };
  if (scopes) normalized.scopes = scopes;
  return normalized;
}

function isHubspotOAuthState(value: unknown): value is HubspotOAuthState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<HubspotOAuthState>;
  return (
    v.v === 1 &&
    v.provider === 'hubspot' &&
    typeof v.orgId === 'string' &&
    typeof v.actorId === 'string' &&
    typeof v.exp === 'number' &&
    typeof v.nonce === 'string'
  );
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
