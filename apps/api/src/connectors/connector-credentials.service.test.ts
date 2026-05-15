// Integration tests for org-scoped connector credentials — require Postgres on
// $DATABASE_URL (default localhost:5433).

import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
} from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { schema, orgs, connectorCredentials } from '@dejavas/db';
import { ConnectorRegistry } from './connector-registry.js';
import { ConnectorCredentialsService } from './connector-credentials.service.js';

const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://dejavas:dejavas@localhost:5433/dejavas';

class FakeConfig {
  constructor(private readonly env: Record<string, string | undefined> = {}) {}
  get<T = string>(key: string): T | undefined {
    return this.env[key] as T | undefined;
  }
}

const TEST_KEY =
  'hex:0000000000000000000000000000000000000000000000000000000000000000';

function config(env: Record<string, string | undefined> = {}) {
  return new FakeConfig({
    CONNECTOR_CREDENTIALS_KEY: TEST_KEY,
    ...env,
  }) as unknown as ConfigService;
}

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

before(() => {
  client = postgres(DB_URL, { max: 5 });
  db = drizzle(client, { schema });
});

after(async () => {
  await client.end();
});

describe('ConnectorCredentialsService', () => {
  let orgId: string;

  beforeEach(async () => {
    const [org] = await db
      .insert(orgs)
      .values({ name: 'Connector Test', slug: `conn-${randomUUID().slice(0, 8)}` })
      .returning();
    orgId = org!.id;
  });

  afterEach(async () => {
    if (orgId) await db.delete(orgs).where(eq(orgs.id, orgId));
  });

  it('lists env-backed connectors without persisting org credentials', async () => {
    const svc = new ConnectorCredentialsService(
      db,
      config({ HUBSPOT_ACCESS_TOKEN: 'env-hubspot-token' }),
    );

    const out = await svc.listForOrg(orgId);
    const hubspot = out.items.find((item) => item.provider === 'hubspot');
    const apollo = out.items.find((item) => item.provider === 'apollo');

    assert.equal(out.items.length, 5);
    assert.equal(hubspot?.configured, true);
    assert.equal(hubspot?.enabled, true);
    assert.equal(hubspot?.source, 'env');
    assert.equal(apollo?.configured, false);
    assert.equal(apollo?.source, null);
  });

  it('stores org credentials encrypted and decrypts normalized connector config', async () => {
    const svc = new ConnectorCredentialsService(db, config());

    const status = await svc.upsert({
      orgId,
      provider: 'hubspot',
      credentials: { access_token: 'org-hubspot-secret' },
      actorId: 'operator-1',
    });

    assert.equal(status.configured, true);
    assert.equal(status.source, 'org');
    assert.deepEqual(await svc.configForOrg(orgId, 'hubspot'), {
      provider: 'hubspot',
      accessToken: 'org-hubspot-secret',
    });

    const [row] = await db
      .select()
      .from(connectorCredentials)
      .where(eq(connectorCredentials.orgId, orgId))
      .limit(1);
    assert.ok(row);
    assert.equal(JSON.stringify(row!.encryptedConfig).includes('org-hubspot-secret'), false);
  });

  it('disables env fallback by writing an org tombstone row', async () => {
    const svc = new ConnectorCredentialsService(
      db,
      config({ HUBSPOT_ACCESS_TOKEN: 'env-hubspot-token' }),
    );

    assert.deepEqual(await svc.configForOrg(orgId, 'hubspot'), {
      provider: 'hubspot',
      accessToken: 'env-hubspot-token',
    });

    await svc.disable({ orgId, provider: 'hubspot', actorId: 'operator-1' });
    assert.equal(await svc.configForOrg(orgId, 'hubspot'), null);

    const status = (await svc.listForOrg(orgId)).items.find(
      (item) => item.provider === 'hubspot',
    );
    assert.equal(status?.configured, false);
    assert.equal(status?.enabled, false);
    assert.equal(status?.source, 'org');
  });

  it('rejects invalid provider-specific credential shapes', async () => {
    const svc = new ConnectorCredentialsService(db, config());

    await assert.rejects(
      () =>
        svc.upsert({
          orgId,
          provider: 'salesforce',
          credentials: {
            access_token: 'sf-token',
            instance_url: 'not-a-url',
          },
          actorId: 'operator-1',
        }),
      BadRequestException,
    );
  });

  it('lets the registry resolve connectors from org credentials', async () => {
    const svc = new ConnectorCredentialsService(db, config());
    await svc.upsert({
      orgId,
      provider: 'hubspot',
      credentials: { access_token: 'org-hubspot-secret' },
      actorId: 'operator-1',
    });

    const registry = new ConnectorRegistry(config(), svc);
    const connector = await registry.resolveForOrg(orgId, 'hubspot.contacts.update');
    assert.equal(connector?.name, 'hubspot');

    const configuredResult = await connector!.invoke('hubspot.contacts.update', {
      properties: {},
    });
    assert.equal(configuredResult.ok, false);
    assert.equal(configuredResult.error?.code, 'invalid_params');

    await svc.disable({ orgId, provider: 'hubspot', actorId: 'operator-1' });
    const disabledConnector = await registry.resolveForOrg(
      orgId,
      'hubspot.contacts.update',
    );
    const disabledResult = await disabledConnector!.invoke('hubspot.contacts.update', {
      properties: {},
    });
    assert.equal(disabledResult.ok, false);
    assert.equal(disabledResult.error?.code, 'connector_not_configured');
  });

  it('builds a signed HubSpot OAuth authorization URL', async () => {
    const svc = new ConnectorCredentialsService(
      db,
      config({
        HUBSPOT_CLIENT_ID: 'hub-client-id',
        HUBSPOT_CLIENT_SECRET: 'hub-client-secret',
        API_PUBLIC_URL: 'https://api.dejavas.test',
        HUBSPOT_SCOPES: 'crm.objects.contacts.read crm.objects.contacts.write',
      }),
    );

    const out = await svc.startHubspotOAuth({ orgId, actorId: 'operator-1' });
    const url = new URL(out.authorization_url);

    assert.equal(url.origin + url.pathname, 'https://app.hubspot.com/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'hub-client-id');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'https://api.dejavas.test/v1/connectors/hubspot/oauth/callback',
    );
    assert.equal(
      url.searchParams.get('scope'),
      'crm.objects.contacts.read crm.objects.contacts.write',
    );
    assert.ok(url.searchParams.get('state'));
  });

  it('builds signed OAuth authorization URLs for Salesforce, Gmail, and Outreach', async () => {
    const svc = new ConnectorCredentialsService(
      db,
      config({
        API_PUBLIC_URL: 'https://api.dejavas.test',
        SALESFORCE_CLIENT_ID: 'sf-client-id',
        SALESFORCE_CLIENT_SECRET: 'sf-client-secret',
        SALESFORCE_LOGIN_URL: 'https://test.salesforce.com',
        SALESFORCE_SCOPES: 'api refresh_token',
        GMAIL_CLIENT_ID: 'gmail-client-id',
        GMAIL_CLIENT_SECRET: 'gmail-client-secret',
        GMAIL_SCOPES: 'https://www.googleapis.com/auth/gmail.send',
        OUTREACH_CLIENT_ID: 'outreach-client-id',
        OUTREACH_CLIENT_SECRET: 'outreach-client-secret',
        OUTREACH_SCOPES: 'prospects.all tasks.all',
      }),
    );

    const salesforce = new URL(
      (await svc.startOAuth({
        provider: 'salesforce',
        orgId,
        actorId: 'operator-1',
      })).authorization_url,
    );
    assert.equal(
      salesforce.origin + salesforce.pathname,
      'https://test.salesforce.com/services/oauth2/authorize',
    );
    assert.equal(salesforce.searchParams.get('client_id'), 'sf-client-id');
    assert.equal(
      salesforce.searchParams.get('redirect_uri'),
      'https://api.dejavas.test/v1/connectors/salesforce/oauth/callback',
    );
    assert.equal(salesforce.searchParams.get('scope'), 'api refresh_token');

    const gmail = new URL(
      (await svc.startOAuth({
        provider: 'gmail',
        orgId,
        actorId: 'operator-1',
      })).authorization_url,
    );
    assert.equal(
      gmail.origin + gmail.pathname,
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    assert.equal(gmail.searchParams.get('client_id'), 'gmail-client-id');
    assert.equal(gmail.searchParams.get('access_type'), 'offline');
    assert.equal(gmail.searchParams.get('include_granted_scopes'), 'true');
    assert.equal(gmail.searchParams.get('prompt'), 'consent');
    assert.equal(
      gmail.searchParams.get('redirect_uri'),
      'https://api.dejavas.test/v1/connectors/gmail/oauth/callback',
    );

    const outreach = new URL(
      (await svc.startOAuth({
        provider: 'outreach',
        orgId,
        actorId: 'operator-1',
      })).authorization_url,
    );
    assert.equal(
      outreach.origin + outreach.pathname,
      'https://api.outreach.io/oauth/authorize',
    );
    assert.equal(outreach.searchParams.get('client_id'), 'outreach-client-id');
    assert.equal(outreach.searchParams.get('scope'), 'prospects.all tasks.all');
    assert.equal(
      outreach.searchParams.get('redirect_uri'),
      'https://api.dejavas.test/v1/connectors/outreach/oauth/callback',
    );
  });

  it('exchanges HubSpot OAuth code, stores metadata, and decrypts config', async () => {
    const svc = new ConnectorCredentialsService(
      db,
      config({
        HUBSPOT_CLIENT_ID: 'hub-client-id',
        HUBSPOT_CLIENT_SECRET: 'hub-client-secret',
        API_PUBLIC_URL: 'https://api.dejavas.test',
      }),
    );
    const state = new URL(
      (await svc.startHubspotOAuth({ orgId, actorId: 'operator-1' })).authorization_url,
    ).searchParams.get('state')!;
    const mock = mockFetch([
      {
        assert: (url, init) => {
          assert.equal(url, 'https://api.hubspot.com/oauth/v3/token');
          assert.equal(init.method, 'POST');
          const body = init.body as URLSearchParams;
          assert.equal(body.get('grant_type'), 'authorization_code');
          assert.equal(body.get('code'), 'oauth-code');
        },
        body: {
          access_token: 'oauth-access-token',
          refresh_token: 'oauth-refresh-token',
          expires_in: 1800,
          hub_id: 12345,
          scopes: ['crm.objects.contacts.read'],
        },
      },
      {
        assert: (url, init) => {
          assert.equal(url, 'https://api.hubspot.com/oauth/v3/token/introspect');
          const body = init.body as URLSearchParams;
          assert.equal(body.get('token_type_hint'), 'refresh_token');
          assert.equal(body.get('refresh_token'), 'oauth-refresh-token');
        },
        body: {
          active: true,
          hub_id: 12345,
          hub_domain: 'acme.test',
          user: 'ops@acme.test',
          scopes: ['crm.objects.contacts.read'],
        },
      },
    ]);

    try {
      const status = await svc.completeHubspotOAuth({ code: 'oauth-code', state });
      assert.equal(status.auth_type, 'oauth');
      assert.equal(status.account?.hub_domain, 'acme.test');
      assert.deepEqual(await svc.configForOrg(orgId, 'hubspot'), {
        provider: 'hubspot',
        accessToken: 'oauth-access-token',
      });

      const [row] = await db
        .select()
        .from(connectorCredentials)
        .where(eq(connectorCredentials.orgId, orgId))
        .limit(1);
      assert.ok(row);
      const encrypted = JSON.stringify(row!.encryptedConfig);
      assert.equal(encrypted.includes('oauth-access-token'), false);
      assert.equal(encrypted.includes('oauth-refresh-token'), false);
      assert.equal(mock.calls.length, 2);
    } finally {
      mock.restore();
    }
  });

  it('refreshes expired HubSpot OAuth access tokens before dispatch', async () => {
    const svc = new ConnectorCredentialsService(
      db,
      config({
        HUBSPOT_CLIENT_ID: 'hub-client-id',
        HUBSPOT_CLIENT_SECRET: 'hub-client-secret',
        API_PUBLIC_URL: 'https://api.dejavas.test',
      }),
    );
    const state = new URL(
      (await svc.startHubspotOAuth({ orgId, actorId: 'operator-1' })).authorization_url,
    ).searchParams.get('state')!;
    const mock = mockFetch([
      {
        body: {
          access_token: 'old-access-token',
          refresh_token: 'refresh-token',
          expires_in: 1,
          hub_id: 12345,
          scopes: ['crm.objects.contacts.read'],
        },
      },
      {
        body: {
          active: true,
          hub_id: 12345,
          hub_domain: 'acme.test',
          user: 'ops@acme.test',
        },
      },
      {
        assert: (_url, init) => {
          const body = init.body as URLSearchParams;
          assert.equal(body.get('grant_type'), 'refresh_token');
          assert.equal(body.get('refresh_token'), 'refresh-token');
        },
        body: {
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 1800,
          hub_id: 12345,
          scopes: ['crm.objects.contacts.read'],
        },
      },
    ]);

    try {
      await svc.completeHubspotOAuth({ code: 'oauth-code', state });
      assert.deepEqual(await svc.configForOrg(orgId, 'hubspot'), {
        provider: 'hubspot',
        accessToken: 'fresh-access-token',
      });
      assert.equal(mock.calls.length, 3);
    } finally {
      mock.restore();
    }
  });

  it('exchanges Salesforce OAuth code and stores refreshable instance metadata', async () => {
    const svc = new ConnectorCredentialsService(
      db,
      config({
        SALESFORCE_CLIENT_ID: 'sf-client-id',
        SALESFORCE_CLIENT_SECRET: 'sf-client-secret',
        API_PUBLIC_URL: 'https://api.dejavas.test',
      }),
    );
    const state = new URL(
      (await svc.startOAuth({
        provider: 'salesforce',
        orgId,
        actorId: 'operator-1',
      })).authorization_url,
    ).searchParams.get('state')!;
    const mock = mockFetch([
      {
        assert: (url, init) => {
          assert.equal(url, 'https://login.salesforce.com/services/oauth2/token');
          const body = init.body as URLSearchParams;
          assert.equal(body.get('grant_type'), 'authorization_code');
          assert.equal(body.get('code'), 'sf-code');
          assert.equal(
            body.get('redirect_uri'),
            'https://api.dejavas.test/v1/connectors/salesforce/oauth/callback',
          );
        },
        body: {
          access_token: 'sf-access-token',
          refresh_token: 'sf-refresh-token',
          expires_in: 7200,
          instance_url: 'https://acme.my.salesforce.com',
          id: 'https://login.salesforce.com/id/org/user',
          scope: 'api refresh_token',
        },
      },
    ]);

    try {
      const status = await svc.completeOAuth({
        provider: 'salesforce',
        code: 'sf-code',
        state,
      });
      assert.equal(status.auth_type, 'oauth');
      assert.equal(status.account?.instance_url, 'https://acme.my.salesforce.com');
      assert.deepEqual(await svc.configForOrg(orgId, 'salesforce'), {
        provider: 'salesforce',
        accessToken: 'sf-access-token',
        instanceUrl: 'https://acme.my.salesforce.com',
      });
      assert.equal(mock.calls.length, 1);
    } finally {
      mock.restore();
    }
  });

  it('refreshes expired Gmail OAuth access tokens before dispatch', async () => {
    const svc = new ConnectorCredentialsService(
      db,
      config({
        GMAIL_CLIENT_ID: 'gmail-client-id',
        GMAIL_CLIENT_SECRET: 'gmail-client-secret',
        API_PUBLIC_URL: 'https://api.dejavas.test',
      }),
    );
    const state = new URL(
      (await svc.startOAuth({
        provider: 'gmail',
        orgId,
        actorId: 'operator-1',
      })).authorization_url,
    ).searchParams.get('state')!;
    const mock = mockFetch([
      {
        body: {
          access_token: 'old-gmail-access-token',
          refresh_token: 'gmail-refresh-token',
          expires_in: 1,
          scope: 'https://www.googleapis.com/auth/gmail.send',
        },
      },
      {
        assert: (url, init) => {
          assert.equal(url, 'https://oauth2.googleapis.com/token');
          const body = init.body as URLSearchParams;
          assert.equal(body.get('grant_type'), 'refresh_token');
          assert.equal(body.get('refresh_token'), 'gmail-refresh-token');
        },
        body: {
          access_token: 'fresh-gmail-access-token',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.send',
        },
      },
    ]);

    try {
      await svc.completeOAuth({ provider: 'gmail', code: 'gmail-code', state });
      assert.deepEqual(await svc.configForOrg(orgId, 'gmail'), {
        provider: 'gmail',
        accessToken: 'fresh-gmail-access-token',
        userId: 'me',
      });
      assert.equal(mock.calls.length, 2);
    } finally {
      mock.restore();
    }
  });

  it('exchanges Outreach OAuth code and stores scope metadata', async () => {
    const svc = new ConnectorCredentialsService(
      db,
      config({
        OUTREACH_CLIENT_ID: 'outreach-client-id',
        OUTREACH_CLIENT_SECRET: 'outreach-client-secret',
        API_PUBLIC_URL: 'https://api.dejavas.test',
      }),
    );
    const state = new URL(
      (await svc.startOAuth({
        provider: 'outreach',
        orgId,
        actorId: 'operator-1',
      })).authorization_url,
    ).searchParams.get('state')!;
    const mock = mockFetch([
      {
        assert: (url, init) => {
          assert.equal(url, 'https://api.outreach.io/oauth/token');
          const body = init.body as URLSearchParams;
          assert.equal(body.get('grant_type'), 'authorization_code');
          assert.equal(body.get('code'), 'outreach-code');
        },
        body: {
          access_token: 'outreach-access-token',
          refresh_token: 'outreach-refresh-token',
          expires_in: 7200,
          scope: 'prospects.all tasks.all',
          token_type: 'Bearer',
        },
      },
    ]);

    try {
      const status = await svc.completeOAuth({
        provider: 'outreach',
        code: 'outreach-code',
        state,
      });
      assert.equal(status.auth_type, 'oauth');
      assert.deepEqual(status.account?.scopes, ['prospects.all', 'tasks.all']);
      assert.deepEqual(await svc.configForOrg(orgId, 'outreach'), {
        provider: 'outreach',
        accessToken: 'outreach-access-token',
      });
      assert.equal(mock.calls.length, 1);
    } finally {
      mock.restore();
    }
  });
});

function mockFetch(
  responses: Array<{
    status?: number;
    body: unknown;
    assert?: (url: string, init: RequestInit) => void;
  }>,
) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch call to ${String(url)}`);
    const call = { url: String(url), init };
    calls.push(call);
    next.assert?.(call.url, call.init);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
