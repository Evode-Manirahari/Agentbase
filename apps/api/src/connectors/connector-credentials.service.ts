import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import {
  connectorCredentials,
  type EncryptedConnectorConfig,
} from '@dejavas/db';
import {
  ConnectorProvider,
  type ConnectorProvider as ConnectorProviderT,
} from '@dejavas/shared';

const PROVIDERS = ConnectorProvider.options;

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
  updated_at: string | null;
  fields: typeof CONNECTOR_FIELD_DEFS[ConnectorProviderT];
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
          return {
            provider,
            configured: row.enabled,
            enabled: row.enabled,
            source: 'org' as const,
            updated_at: row.updatedAt.toISOString(),
            fields: CONNECTOR_FIELD_DEFS[provider],
          };
        }
        const env = this.configFromEnv(provider);
        return {
          provider,
          configured: Boolean(env),
          enabled: Boolean(env),
          source: env ? ('env' as const) : null,
          updated_at: null,
          fields: CONNECTOR_FIELD_DEFS[provider],
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

    const encrypted = this.encrypt(parsed.data as Record<string, unknown>);
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
      updated_at: row?.updatedAt.toISOString() ?? now.toISOString(),
      fields: CONNECTOR_FIELD_DEFS[input.provider],
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
      updated_at: now.toISOString(),
      fields: CONNECTOR_FIELD_DEFS[input.provider],
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
      return normalizeConfig(provider, this.decrypt(row.encryptedConfig));
    }

    return this.configFromEnv(provider);
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

  private encrypt(value: Record<string, unknown>): EncryptedConnectorConfig {
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

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
