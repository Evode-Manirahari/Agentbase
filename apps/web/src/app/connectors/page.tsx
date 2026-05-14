import { api, type ConnectorStatus } from '../../lib/api';
import {
  Card,
  EmptyState,
  ErrorBox,
  H1,
  StatusPill,
  Subtitle,
} from '../../components/nav';
import { disableConnectorAction } from './actions';
import { CredentialForm } from './credential-form';

export const dynamic = 'force-dynamic';

const labels: Record<ConnectorStatus['provider'], string> = {
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  gmail: 'Gmail',
  outreach: 'Outreach',
  apollo: 'Apollo',
};

export default async function ConnectorsPage() {
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

      {items.length === 0 && !error ? (
        <EmptyState>No connector metadata available.</EmptyState>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {items.map((connector) => (
            <Card key={connector.provider} className="p-4">
              <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                  <div className="text-base font-medium">
                    {labels[connector.provider]}
                  </div>
                  <div className="text-xs text-[var(--color-muted)] mono">
                    {connector.provider}.*
                  </div>
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
