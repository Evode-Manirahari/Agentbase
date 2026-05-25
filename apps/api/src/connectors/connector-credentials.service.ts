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
import { and, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { DB } from '../db/db.module.js';
import type { Database } from '@agentbase/db';
import {
  connectorCredentials,
  oauthStates,
  type ConnectorCredential,
  type EncryptedConnectorConfig,
} from '@agentbase/db';
import {
  ConnectorProvider,
  type ConnectorProvider as ConnectorProviderT,
} from '@agentbase/shared';

const PROVIDERS = ConnectorProvider.options;
const OAUTH_PROVIDERS = ['hubspot', 'salesforce', 'gmail', 'outreach'] as const;
type OAuthProviderT = typeof OAUTH_PROVIDERS[number];

const HUBSPOT_INTROSPECT_URL = 'https://api.hubspot.com/oauth/v3/token/introspect';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

interface OAuthProviderDefinition {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientIdEnv: string[];
  clientSecretEnv: string[];
  redirectUriEnv: string;
  scopesEnv: string;
  defaultScopes: string[];
  defaultExpiresInSec: number;
  extraAuthorizeParams?: Record<string, string>;
}

const OAUTH_PROVIDER_DEFS: Record<OAuthProviderT, OAuthProviderDefinition> = {
  hubspot: {
    label: 'HubSpot',
    authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
    tokenUrl: 'https://api.hubspot.com/oauth/v3/token',
    clientIdEnv: ['HUBSPOT_CLIENT_ID'],
    clientSecretEnv: ['HUBSPOT_CLIENT_SECRET'],
    redirectUriEnv: 'HUBSPOT_REDIRECT_URI',
    scopesEnv: 'HUBSPOT_SCOPES',
    defaultExpiresInSec: 1800,
    defaultScopes: [
      'crm.objects.contacts.read',
      'crm.objects.contacts.write',
      'crm.objects.deals.read',
      'crm.objects.deals.write',
    ],
  },
  salesforce: {
    label: 'Salesforce',
    authorizeUrl: 'https://login.salesforce.com/services/oauth2/authorize',
    tokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    clientIdEnv: ['SALESFORCE_CLIENT_ID', 'SALESFORCE_CONSUMER_KEY'],
    clientSecretEnv: ['SALESFORCE_CLIENT_SECRET', 'SALESFORCE_CONSUMER_SECRET'],
    redirectUriEnv: 'SALESFORCE_REDIRECT_URI',
    scopesEnv: 'SALESFORCE_SCOPES',
    defaultExpiresInSec: 7200,
    defaultScopes: ['api', 'refresh_token'],
  },
  gmail: {
    label: 'Gmail',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientIdEnv: ['GMAIL_CLIENT_ID', 'GOOGLE_CLIENT_ID'],
    clientSecretEnv: ['GMAIL_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'],
    redirectUriEnv: 'GMAIL_REDIRECT_URI',
    scopesEnv: 'GMAIL_SCOPES',
    defaultExpiresInSec: 3600,
    defaultScopes: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    extraAuthorizeParams: {
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
    },
  },
  outreach: {
    label: 'Outreach',
    authorizeUrl: 'https://api.outreach.io/oauth/authorize',
    tokenUrl: 'https://api.outreach.io/oauth/token',
    clientIdEnv: ['OUTREACH_CLIENT_ID'],
    clientSecretEnv: ['OUTREACH_CLIENT_SECRET'],
    redirectUriEnv: 'OUTREACH_REDIRECT_URI',
    scopesEnv: 'OUTREACH_SCOPES',
    defaultExpiresInSec: 7200,
    defaultScopes: [
      'prospects.all',
      'sequenceStates.all',
      'tasks.all',
      'sequences.read',
      'mailboxes.read',
    ],
  },
};

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
  id?: number | string | null;
  hub_id?: number | string | null;
  hub_domain?: string | null;
  instance_url?: string | null;
  user?: string | null;
  scopes?: string[];
  expires_at?: string | null;
}

interface OAuthStatePayload {
  v: 1;
  provider: OAuthProviderT;
  orgId: string;
  actorId: string;
  exp: number;
  nonce: string;
}

const OAuthTokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().int().positive().optional(),
  hub_id: z.union([z.number(), z.string()]).optional(),
  instance_url: z.string().url().optional(),
  id: z.string().optional(),
  issued_at: z.union([z.number(), z.string()]).optional(),
  created_at: z.number().optional(),
  scope: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  token_type: z.string().optional(),
}).passthrough();

const HubspotIntrospectionResponse = z.object({
  active: z.boolean().optional(),
  hub_id: z.union([z.number(), z.string()]).optional(),
  user_id: z.union([z.number(), z.string()]).optional(),
  user: z.string().optional(),
  hub_domain: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  app_id: z.union([z.number(), z.string()]).optional(),
}).passthrough();

type OAuthTokenResponse = z.infer<typeof OAuthTokenResponse>;
type HubspotIntrospectionResponse = z.infer<typeof HubspotIntrospectionResponse>;

interface OAuthStoredConfig {
  auth_type: 'oauth';
  provider: OAuthProviderT;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  hub_id?: number | string | null;
  instance_url?: string | null;
  user_id?: string | null;
  scopes?: string[];
  account?: {
    id?: string | number | null;
    hub_id?: number | string | null;
    hub_domain?: string | null;
    user?: string | null;
    user_id?: number | string | null;
    app_id?: number | string | null;
    instance_url?: string | null;
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
            oauth_available: this.oauthAvailable(provider),
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
          oauth_available: this.oauthAvailable(provider),
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
      oauth_available: this.oauthAvailable(input.provider),
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
      oauth_available: this.oauthAvailable(input.provider),
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
      if (isOAuthProvider(provider) && raw.auth_type === 'oauth') {
        return this.configFromOAuthRow(row, provider, raw);
      }
      return normalizeConfig(provider, raw);
    }

    return this.configFromEnv(provider);
  }

  hubspotOAuthAvailable(): boolean {
    return this.oauthAvailable('hubspot');
  }

  oauthAvailable(provider: ConnectorProviderT): boolean {
    if (!isOAuthProvider(provider)) return false;
    return Boolean(this.oauthClientId(provider) && this.oauthClientSecret(provider));
  }

  async startOAuth(input: {
    provider: ConnectorProviderT;
    orgId: string;
    actorId: string;
  }): Promise<{ authorization_url: string; expires_at: string; redirect_uri: string; scopes: string[] }> {
    const provider = parseOAuthProvider(input.provider);
    const clientId = this.oauthClientId(provider);
    const clientSecret = this.oauthClientSecret(provider);
    const def = OAUTH_PROVIDER_DEFS[provider];
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        `${def.label} OAuth is not configured. Set ${def.clientIdEnv[0]} and ${def.clientSecretEnv[0]}.`,
      );
    }

    const expiresAtMs = Date.now() + OAUTH_STATE_TTL_MS;
    const expiresAt = new Date(expiresAtMs);
    const scopes = this.oauthScopes(provider);
    const redirectUri = this.oauthRedirectUri(provider);
    const nonce = randomBytes(32).toString('base64url');

    await this.db
      .delete(oauthStates)
      .where(lt(oauthStates.expiresAt, new Date(Date.now() - OAUTH_STATE_TTL_MS)));
    await this.db.insert(oauthStates).values({
      nonce,
      provider,
      orgId: input.orgId,
      actorId: input.actorId,
      expiresAt,
    });

    const state = this.signOAuthState({
      v: 1,
      provider,
      orgId: input.orgId,
      actorId: input.actorId,
      exp: expiresAtMs,
      nonce,
    });
    const url = new URL(this.oauthAuthorizeUrl(provider));
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('state', state);
    for (const [key, value] of Object.entries(def.extraAuthorizeParams ?? {})) {
      url.searchParams.set(key, value);
    }

    return {
      authorization_url: url.toString(),
      expires_at: expiresAt.toISOString(),
      redirect_uri: redirectUri,
      scopes,
    };
  }

  async startHubspotOAuth(input: {
    orgId: string;
    actorId: string;
  }): Promise<{ authorization_url: string; expires_at: string; redirect_uri: string; scopes: string[] }> {
    return this.startOAuth({ provider: 'hubspot', ...input });
  }

  async completeOAuth(input: {
    provider: ConnectorProviderT;
    code: string;
    state: string;
  }): Promise<ConnectorStatus> {
    const provider = parseOAuthProvider(input.provider);
    const state = await this.verifyOAuthState(input.state);
    if (state.provider !== provider) {
      throw new BadRequestException('OAuth state provider mismatch');
    }
    const token = await this.requestOAuthToken(provider, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.oauthRedirectUri(provider),
    });
    if (!token.refresh_token) {
      throw new BadRequestException(
        `${OAUTH_PROVIDER_DEFS[provider].label} OAuth response did not include a refresh token`,
      );
    }
    const account =
      provider === 'hubspot'
        ? await this.introspectHubspotRefreshToken(token.refresh_token)
        : null;
    const now = new Date();
    const encrypted = this.encrypt(oauthConfigFromToken(provider, token, account, {
      gmailUserId: this.gmailUserId(),
    }));

    const [row] = await this.db
      .insert(connectorCredentials)
      .values({
        orgId: state.orgId,
        provider,
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
      provider,
      configured: true,
      enabled: true,
      source: 'org',
      auth_type: 'oauth',
      updated_at: row?.updatedAt.toISOString() ?? now.toISOString(),
      fields: CONNECTOR_FIELD_DEFS[provider],
      oauth_available: true,
      account: accountFor(provider, raw),
    };
  }

  async completeHubspotOAuth(input: {
    code: string;
    state: string;
  }): Promise<ConnectorStatus> {
    return this.completeOAuth({ provider: 'hubspot', ...input });
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

  private async configFromOAuthRow(
    row: ConnectorCredential,
    provider: OAuthProviderT,
    raw: Record<string, unknown>,
  ): Promise<ConnectorConfig | null> {
    const parsed = parseOAuthConfig(provider, raw);
    if (!parsed) return null;

    if (Date.parse(parsed.expires_at) - Date.now() > TOKEN_REFRESH_SKEW_MS) {
      return normalizeOAuthConnectorConfig(provider, parsed);
    }

    const refreshed = await this.requestOAuthToken(provider, {
      grant_type: 'refresh_token',
      refresh_token: parsed.refresh_token,
    });
    const nextConfig = oauthConfigFromToken(provider, refreshed, parsed.account, {
      previousRefreshToken: parsed.refresh_token,
      previousHubId: parsed.hub_id,
      previousInstanceUrl: parsed.instance_url,
      previousUserId: parsed.user_id,
      previousScopes: parsed.scopes,
      gmailUserId: this.gmailUserId(),
    });
    await this.db
      .update(connectorCredentials)
      .set({
        encryptedConfig: this.encrypt(nextConfig),
        updatedAt: new Date(),
      })
      .where(eq(connectorCredentials.id, row.id));

    return normalizeOAuthConnectorConfig(provider, nextConfig);
  }

  private async requestOAuthToken(provider: OAuthProviderT, input: {
    grant_type: 'authorization_code' | 'refresh_token';
    code?: string;
    refresh_token?: string;
    redirect_uri?: string;
  }): Promise<OAuthTokenResponse> {
    const clientId = this.oauthClientId(provider);
    const clientSecret = this.oauthClientSecret(provider);
    const def = OAUTH_PROVIDER_DEFS[provider];
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        `${def.label} OAuth is not configured. Set ${def.clientIdEnv[0]} and ${def.clientSecretEnv[0]}.`,
      );
    }

    if (input.grant_type === 'authorization_code' && !nonEmpty(input.code)) {
      throw new BadRequestException('authorization_code grant requires a non-empty code');
    }
    if (input.grant_type === 'refresh_token' && !nonEmpty(input.refresh_token)) {
      throw new BadRequestException('refresh_token grant requires a non-empty refresh_token');
    }

    const body = new URLSearchParams({
      grant_type: input.grant_type,
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (input.code) body.set('code', input.code);
    if (input.refresh_token) body.set('refresh_token', input.refresh_token);
    if (input.redirect_uri) body.set('redirect_uri', input.redirect_uri);

    const res = await fetch(this.oauthTokenUrl(provider), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await readJson(res);
    if (!res.ok) {
      throw new BadRequestException({
        message: `${def.label} OAuth token request failed`,
        status: res.status,
        details: json,
      });
    }
    const parsed = OAuthTokenResponse.safeParse(json);
    if (!parsed.success) {
      throw new BadRequestException({
        message: `${def.label} OAuth token response failed schema validation`,
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  private async introspectHubspotRefreshToken(
    refreshToken: string,
  ): Promise<HubspotIntrospectionResponse | null> {
    const clientId = this.oauthClientId('hubspot');
    const clientSecret = this.oauthClientSecret('hubspot');
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

  private signOAuthState(payload: OAuthStatePayload): string {
    const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = createHmac('sha256', this.key()).update(data).digest('base64url');
    return `${data}.${sig}`;
  }

  private async verifyOAuthState(state: string): Promise<OAuthStatePayload> {
    const parts = state.split('.');
    if (parts.length !== 2) throw new BadRequestException('invalid OAuth state');
    const [data, sig] = parts;
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
    if (!isOAuthStatePayload(payload)) {
      throw new BadRequestException('invalid OAuth state payload');
    }
    if (payload.exp < Date.now()) {
      throw new BadRequestException('expired OAuth state');
    }

    const consumed = await this.db
      .delete(oauthStates)
      .where(
        and(
          eq(oauthStates.nonce, payload.nonce),
          eq(oauthStates.provider, payload.provider),
        ),
      )
      .returning();
    const row = consumed[0];
    if (!row) {
      throw new BadRequestException('OAuth state already used or unknown');
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('expired OAuth state');
    }
    if (row.orgId !== payload.orgId || row.actorId !== payload.actorId) {
      throw new BadRequestException('OAuth state binding mismatch');
    }
    return payload;
  }

  private oauthClientId(provider: OAuthProviderT): string | null {
    return firstEnv(this.config, OAUTH_PROVIDER_DEFS[provider].clientIdEnv);
  }

  private oauthClientSecret(provider: OAuthProviderT): string | null {
    return firstEnv(this.config, OAUTH_PROVIDER_DEFS[provider].clientSecretEnv);
  }

  private oauthScopes(provider: OAuthProviderT): string[] {
    const raw = nonEmpty(this.config.get<string>(OAUTH_PROVIDER_DEFS[provider].scopesEnv));
    return raw
      ? raw.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean)
      : OAUTH_PROVIDER_DEFS[provider].defaultScopes;
  }

  private oauthRedirectUri(provider: OAuthProviderT): string {
    const explicit = nonEmpty(
      this.config.get<string>(OAUTH_PROVIDER_DEFS[provider].redirectUriEnv),
    );
    if (explicit) return explicit;

    const base =
      nonEmpty(this.config.get<string>('API_PUBLIC_URL')) ??
      nonEmpty(this.config.get<string>('PUBLIC_BASE_URL'));
    if (base) return `${base.replace(/\/$/, '')}/v1/connectors/${provider}/oauth/callback`;

    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new InternalServerErrorException(
        `${OAUTH_PROVIDER_DEFS[provider].redirectUriEnv} or API_PUBLIC_URL must be set in production`,
      );
    }
    const port = nonEmpty(this.config.get<string>('PORT')) ?? '3002';
    return `http://localhost:${port}/v1/connectors/${provider}/oauth/callback`;
  }

  private oauthAuthorizeUrl(provider: OAuthProviderT): string {
    const override = nonEmpty(
      this.config.get<string>(`${providerEnvPrefix(provider)}_AUTHORIZE_URL`),
    );
    if (override) return override;
    if (provider === 'salesforce') {
      const loginUrl = nonEmpty(this.config.get<string>('SALESFORCE_LOGIN_URL'));
      if (loginUrl) return `${loginUrl.replace(/\/$/, '')}/services/oauth2/authorize`;
    }
    return OAUTH_PROVIDER_DEFS[provider].authorizeUrl;
  }

  private oauthTokenUrl(provider: OAuthProviderT): string {
    const override = nonEmpty(
      this.config.get<string>(`${providerEnvPrefix(provider)}_TOKEN_URL`),
    );
    if (override) return override;
    if (provider === 'salesforce') {
      const loginUrl = nonEmpty(this.config.get<string>('SALESFORCE_LOGIN_URL'));
      if (loginUrl) return `${loginUrl.replace(/\/$/, '')}/services/oauth2/token`;
    }
    return OAUTH_PROVIDER_DEFS[provider].tokenUrl;
  }

  private gmailUserId(): string | null {
    return nonEmpty(this.config.get<string>('GMAIL_USER_ID'));
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
    const iv = Buffer.from(encrypted.iv, 'base64url');
    if (iv.length !== 12) {
      throw new InternalServerErrorException('connector credential envelope has invalid IV length');
    }
    const tag = Buffer.from(encrypted.tag, 'base64url');
    if (tag.length !== 16) {
      throw new InternalServerErrorException('connector credential envelope has invalid auth tag length');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InternalServerErrorException('connector credential payload is not an object');
    }
    return parsed as Record<string, unknown>;
  }

  private key(): Buffer {
    const raw = nonEmpty(this.config.get<string>('CONNECTOR_CREDENTIALS_KEY'));
    const env = nonEmpty(this.config.get<string>('NODE_ENV'));
    const isTest = env === 'test';

    if (!raw) {
      if (!isTest) {
        throw new InternalServerErrorException(
          'CONNECTOR_CREDENTIALS_KEY must be set. Use `openssl rand -base64 32` and pass as `base64:...` (or `hex:...`).',
        );
      }
      return createHash('sha256').update('agentbase-test-key').digest();
    }

    if (raw.startsWith('base64:')) {
      const key = Buffer.from(raw.slice('base64:'.length), 'base64');
      if (key.length !== 32) {
        throw new InternalServerErrorException(
          `CONNECTOR_CREDENTIALS_KEY base64 payload must decode to 32 bytes (got ${key.length})`,
        );
      }
      return key;
    }
    if (raw.startsWith('hex:')) {
      const key = Buffer.from(raw.slice('hex:'.length), 'hex');
      if (key.length !== 32) {
        throw new InternalServerErrorException(
          `CONNECTOR_CREDENTIALS_KEY hex payload must decode to 32 bytes (got ${key.length})`,
        );
      }
      return key;
    }
    if (!isTest) {
      throw new InternalServerErrorException(
        'CONNECTOR_CREDENTIALS_KEY must be prefixed with `base64:` or `hex:` (refusing to silently hash an arbitrary string)',
      );
    }
    return createHash('sha256').update(raw).digest();
  }
}

function normalizeConfig(
  provider: ConnectorProviderT,
  raw: Record<string, unknown>,
): ConnectorConfig {
  const parsed = CredentialSchemas[provider].safeParse(raw);
  if (!parsed.success) {
    throw new InternalServerErrorException(
      `stored ${provider} credential payload failed schema validation — credential row may be corrupt or from an older schema`,
    );
  }
  const data = parsed.data as Record<string, unknown>;
  switch (provider) {
    case 'hubspot':
      return { provider, accessToken: String(data.access_token) };
    case 'salesforce':
      return {
        provider,
        accessToken: String(data.access_token),
        instanceUrl: String(data.instance_url),
      };
    case 'gmail':
      return {
        provider,
        accessToken: String(data.access_token),
        userId: typeof data.user_id === 'string' ? data.user_id : null,
      };
    case 'outreach':
      return { provider, accessToken: String(data.access_token) };
    case 'apollo':
      return { provider, apiKey: String(data.api_key) };
  }
}

function oauthConfigFromToken(
  provider: OAuthProviderT,
  token: OAuthTokenResponse,
  account: HubspotIntrospectionResponse | OAuthStoredConfig['account'] | null,
  previous: {
    previousRefreshToken?: string;
    previousHubId?: number | string | null | undefined;
    previousInstanceUrl?: string | null | undefined;
    previousUserId?: string | null | undefined;
    previousScopes?: string[] | undefined;
    gmailUserId?: string | null | undefined;
  } = {},
): OAuthStoredConfig {
  const accountInfo = provider === 'hubspot'
    ? normalizeHubspotAccount(account)
    : normalizeGenericAccount(account);
  const scopes =
    token.scopes ??
    parseScopes(token.scope) ??
    accountInfo?.scopes ??
    previous.previousScopes ??
    [];
  const config: OAuthStoredConfig = {
    auth_type: 'oauth',
    provider,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? previous.previousRefreshToken ?? '',
    expires_at: new Date(
      Date.now() +
        (token.expires_in ?? OAUTH_PROVIDER_DEFS[provider].defaultExpiresInSec) *
          1000,
    ).toISOString(),
    scopes,
  };
  if (provider === 'hubspot') {
    config.hub_id = token.hub_id ?? accountInfo?.hub_id ?? previous.previousHubId ?? null;
  }
  if (provider === 'salesforce') {
    config.instance_url =
      token.instance_url ?? accountInfo?.instance_url ?? previous.previousInstanceUrl ?? null;
  }
  if (provider === 'gmail') {
    config.user_id = previous.previousUserId ?? previous.gmailUserId ?? 'me';
  }
  if (accountInfo) config.account = accountInfo;
  if (provider === 'salesforce' && config.instance_url && !config.account) {
    config.account = { instance_url: config.instance_url, id: token.id ?? null };
  }
  if (provider === 'gmail' && !config.account) {
    config.account = { user: config.user_id ?? 'me' };
  }
  if (provider === 'outreach' && !config.account) {
    config.account = { user: 'Outreach user' };
  }
  return config;
}

function parseOAuthConfig(
  provider: OAuthProviderT,
  raw: Record<string, unknown>,
): OAuthStoredConfig | null {
  if (raw.auth_type !== 'oauth') return null;
  if (raw.provider !== undefined && raw.provider !== provider) return null;
  if (typeof raw.access_token !== 'string' || raw.access_token.length === 0) return null;
  if (typeof raw.refresh_token !== 'string' || raw.refresh_token.length === 0) {
    return null;
  }
  if (typeof raw.expires_at !== 'string' || Number.isNaN(Date.parse(raw.expires_at))) {
    return null;
  }
  const config: OAuthStoredConfig = {
    auth_type: 'oauth',
    provider,
    access_token: raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at: raw.expires_at,
    hub_id:
      typeof raw.hub_id === 'string' || typeof raw.hub_id === 'number'
        ? raw.hub_id
        : null,
    instance_url: typeof raw.instance_url === 'string' ? raw.instance_url : null,
    user_id: typeof raw.user_id === 'string' ? raw.user_id : null,
    scopes: Array.isArray(raw.scopes)
      ? raw.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [],
  };
  if (raw.account && typeof raw.account === 'object') {
    const account = provider === 'hubspot'
      ? normalizeHubspotAccount(raw.account as Record<string, unknown>)
      : normalizeGenericAccount(raw.account as Record<string, unknown>);
    if (account) config.account = account;
  }
  return config;
}

function normalizeOAuthConnectorConfig(
  provider: OAuthProviderT,
  config: OAuthStoredConfig,
): ConnectorConfig | null {
  switch (provider) {
    case 'hubspot':
      return { provider, accessToken: config.access_token };
    case 'salesforce': {
      const instanceUrl = config.instance_url ?? config.account?.instance_url ?? null;
      return instanceUrl
        ? { provider, accessToken: config.access_token, instanceUrl }
        : null;
    }
    case 'gmail':
      return {
        provider,
        accessToken: config.access_token,
        userId: config.user_id ?? 'me',
      };
    case 'outreach':
      return { provider, accessToken: config.access_token };
  }
}

function authTypeFor(
  provider: ConnectorProviderT,
  raw: Record<string, unknown>,
): ConnectorStatus['auth_type'] {
  if (isOAuthProvider(provider) && raw.auth_type === 'oauth') return 'oauth';
  return 'static';
}

function accountFor(
  provider: ConnectorProviderT,
  raw: Record<string, unknown>,
): ConnectorAccount | null {
  if (!isOAuthProvider(provider) || raw.auth_type !== 'oauth') return null;
  const parsed = parseOAuthConfig(provider, raw);
  if (!parsed) return null;
  return {
    id: parsed.account?.id ?? null,
    hub_id: parsed.account?.hub_id ?? parsed.hub_id ?? null,
    hub_domain: parsed.account?.hub_domain ?? null,
    instance_url: parsed.account?.instance_url ?? parsed.instance_url ?? null,
    user: parsed.account?.user ?? parsed.user_id ?? null,
    scopes: parsed.scopes ?? [],
    expires_at: parsed.expires_at,
  };
}

function normalizeHubspotAccount(
  account: HubspotIntrospectionResponse | Record<string, unknown> | null | undefined,
): (OAuthStoredConfig['account'] & { scopes?: string[] }) | null {
  if (!account || typeof account !== 'object') return null;
  const hubId = account.hub_id;
  const userId = account.user_id;
  const appId = account.app_id;
  const scopes = Array.isArray(account.scopes)
    ? account.scopes.filter((scope): scope is string => typeof scope === 'string')
    : null;
  const normalized: OAuthStoredConfig['account'] & { scopes?: string[] } = {
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

function normalizeGenericAccount(
  account: OAuthStoredConfig['account'] | Record<string, unknown> | null | undefined,
): (OAuthStoredConfig['account'] & { scopes?: string[] }) | null {
  if (!account || typeof account !== 'object') return null;
  const raw = account as Record<string, unknown>;
  const id = raw.id;
  const user = raw.user;
  const instanceUrl = raw.instance_url;
  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes.filter((scope): scope is string => typeof scope === 'string')
    : null;
  const normalized: OAuthStoredConfig['account'] & { scopes?: string[] } = {
    id: typeof id === 'number' || typeof id === 'string' ? id : null,
    user: typeof user === 'string' ? user : null,
    instance_url: typeof instanceUrl === 'string' ? instanceUrl : null,
  };
  if (scopes) normalized.scopes = scopes;
  return normalized;
}

function parseScopes(value: string | null | undefined): string[] | null {
  if (!value) return null;
  const scopes = value.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean);
  return scopes.length > 0 ? scopes : null;
}

function isOAuthStatePayload(value: unknown): value is OAuthStatePayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<OAuthStatePayload>;
  return (
    v.v === 1 &&
    typeof v.provider === 'string' &&
    isOAuthProvider(v.provider) &&
    typeof v.orgId === 'string' &&
    typeof v.actorId === 'string' &&
    typeof v.exp === 'number' &&
    typeof v.nonce === 'string'
  );
}

function parseOAuthProvider(provider: ConnectorProviderT): OAuthProviderT {
  if (!isOAuthProvider(provider)) {
    throw new BadRequestException(`${provider} does not support OAuth install`);
  }
  return provider;
}

function isOAuthProvider(provider: string): provider is OAuthProviderT {
  return (OAUTH_PROVIDERS as readonly string[]).includes(provider);
}

function providerEnvPrefix(provider: OAuthProviderT): string {
  return provider === 'gmail' ? 'GMAIL' : provider.toUpperCase();
}

function firstEnv(
  config: ConfigService,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = nonEmpty(config.get<string>(key));
    if (value) return value;
  }
  return null;
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
