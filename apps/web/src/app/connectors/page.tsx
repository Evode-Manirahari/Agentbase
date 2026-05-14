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
  startHubspotOAuthAction,
  testConnectorAction,
} from './actions';
import { CredentialForm } from './credential-form';

export const dynamic = 'force-dynamic';

interface SearchParams {
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

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
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
                  {connector.account ? <AccountLine connector={connector} /> : null}
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

              {connector.provider === 'hubspot' ? (
                <div className="mb-4 flex flex-wrap gap-2">
                  {connector.oauth_available ? (
                    <form action={startHubspotOAuthAction}>
                      <button
                        type="submit"
                        className="px-3 py-2 rounded-md text-xs font-medium bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:opacity-90"
                      >
                        {connector.auth_type === 'oauth'
                          ? 'Reconnect HubSpot'
                          : 'Connect HubSpot'}
                      </button>
                    </form>
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

function AccountLine({ connector }: { connector: ConnectorStatus }) {
  const account = connector.account;
  if (!account) return null;
  const label =
    account.hub_domain ??
    account.user ??
    (account.hub_id ? `Hub ID ${account.hub_id}` : null);
  if (!label) return null;
  return (
    <div className="mt-1 text-xs text-[var(--color-muted)] truncate">
      {label}
    </div>
  );
}
