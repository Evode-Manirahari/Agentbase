import { api, type ConnectorStatus } from '../../lib/api';
import {
  Card,
  EmptyState,
  ErrorBox,
  H1,
  StatusPill,
  Subtitle,
} from '../../components/nav';
import {
  disableConnectorAction,
  startOAuthAction,
  testConnectorAction,
} from './actions';
import { CredentialForm } from './credential-form';

export const dynamic = 'force-dynamic';

interface SearchParams {
  oauth?: string | string[];
  provider?: string | string[];
  test?: string | string[];
  message?: string | string[];
}

const labels: Record<ConnectorStatus['provider'], string> = {
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  gmail: 'Gmail',
  outreach: 'Outreach',
  apollo: 'Apollo',
};

const oauthSupported = new Set<ConnectorStatus['provider']>([
  'hubspot',
  'salesforce',
  'gmail',
  'outreach',
]);

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const oauthStatus = firstParam(sp.oauth);
  const oauthProvider = firstParam(sp.provider);
  const testStatus = firstParam(sp.test);
  const testMessage = firstParam(sp.message);
  let items: ConnectorStatus[] = [];
  let error: unknown = null;
  try {
    items = (await api.connectors.list()).items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-6xl">
      <H1>Connectors</H1>
      <Subtitle>
        Store org-scoped credentials for revenue tools. Org credentials override
        process env vars and are encrypted before they are written to Postgres.
      </Subtitle>

      {error ? <ErrorBox error={error} /> : null}
      {oauthStatus ? (
        <OAuthStatusBanner
          provider={oauthProvider}
          status={oauthStatus}
          message={testMessage}
        />
      ) : null}
      {testStatus ? (
        <div
          className={`mb-4 rounded border p-3 text-sm ${
            testStatus === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
              : 'border-rose-500/30 bg-rose-500/5 text-rose-300'
          }`}
        >
          {testMessage ?? (testStatus === 'ok' ? 'Connection healthy' : 'Connection failed')}
        </div>
      ) : null}

      {items.length === 0 && !error ? (
        <EmptyState>No connector metadata available.</EmptyState>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {items.map((connector) => (
            <Card key={connector.provider} className="p-4">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="text-base font-medium">
                      {labels[connector.provider]}
                    </div>
                    {connector.auth_type ? (
                      <span className="text-[10px] uppercase tracking-normal rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-muted)]">
                        {connector.auth_type}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-xs text-[var(--color-muted)] mono">
                    {connector.provider}.*
                  </div>
                  {connector.account ? <AccountDetails connector={connector} /> : null}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusPill
                    status={
                      connector.configured
                        ? connector.source === 'env'
                          ? 'env'
                          : 'active'
                        : connector.source === 'org'
                          ? 'disabled'
                          : 'missing'
                    }
                  />
                  {connector.updated_at ? (
                    <span className="text-xs text-[var(--color-muted)]">
                      {new Date(connector.updated_at).toLocaleString()}
                    </span>
                  ) : null}
                </div>
              </div>

              {oauthSupported.has(connector.provider) ? (
                <div className="mb-4 flex flex-wrap gap-2">
                  {connector.oauth_available ? (
                    <form action={startOAuthAction}>
                      <input
                        type="hidden"
                        name="provider"
                        value={connector.provider}
                      />
                      <button
                        type="submit"
                        className="px-3 py-2 rounded-md text-xs font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90"
                      >
                        {connector.auth_type === 'oauth'
                          ? `Reconnect ${labels[connector.provider]}`
                          : `Connect ${labels[connector.provider]}`}
                      </button>
                    </form>
                  ) : null}
                  {!connector.oauth_available && connector.auth_type !== 'oauth' ? (
                    <span className="self-center text-xs text-[var(--color-muted)]">
                      OAuth app not configured
                    </span>
                  ) : null}
                  {connector.configured ? (
                    <form action={testConnectorAction}>
                      <input
                        type="hidden"
                        name="provider"
                        value={connector.provider}
                      />
                      <button
                        type="submit"
                        className="px-3 py-2 rounded-md text-xs font-medium border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                      >
                        Test connection
                      </button>
                    </form>
                  ) : null}
                </div>
              ) : null}

              <CredentialForm connector={connector} />

              {connector.source === 'org' && connector.enabled ? (
                <form action={disableConnectorAction} className="mt-3">
                  <input
                    type="hidden"
                    name="provider"
                    value={connector.provider}
                  />
                  <button
                    type="submit"
                    className="text-xs px-2 py-1 rounded border border-rose-500/30 text-rose-300 hover:bg-rose-500/10"
                  >
                    Disable org credentials
                  </button>
                </form>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function OAuthStatusBanner({
  provider,
  status,
  message,
}: {
  provider: string | null;
  status: string;
  message: string | null;
}) {
  const providerLabel = provider ? labelForProvider(provider) : 'Connector';
  const isConnected = status === 'connected';
  return (
    <div
      className={`mb-4 rounded border p-3 text-sm ${
        isConnected
          ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
          : 'border-rose-500/30 bg-rose-500/5 text-rose-300'
      }`}
    >
      {isConnected
        ? `${providerLabel} connected.`
        : `${providerLabel} connection failed${message ? `: ${message}` : '.'}`}
    </div>
  );
}

function AccountDetails({ connector }: { connector: ConnectorStatus }) {
  const account = connector.account;
  if (!account) return null;
  const label =
    account.user ??
    account.hub_domain ??
    account.instance_url ??
    (account.hub_id ? `Hub ID ${account.hub_id}` : null);
  if (!label) return null;
  const expiresAt = formatDateTime(account.expires_at);
  const scopes = account.scopes?.length ?? 0;
  return (
    <div className="mt-2 space-y-1 text-xs text-[var(--color-muted)]">
      <div className="truncate">Connected as {label}</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {account.hub_id ? <span>Hub ID {account.hub_id}</span> : null}
        {account.id ? <span>ID {account.id}</span> : null}
        {account.instance_url ? <span>{shortHost(account.instance_url)}</span> : null}
        {expiresAt ? <span>Expires {expiresAt}</span> : null}
        {scopes > 0 ? <span>{scopes} scopes</span> : null}
      </div>
    </div>
  );
}

function labelForProvider(provider: string): string {
  return provider in labels
    ? labels[provider as ConnectorStatus['provider']]
    : 'Connector';
}

function shortHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}
