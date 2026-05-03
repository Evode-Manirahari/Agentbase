import { api } from '../../lib/api';
import {
  Card,
  EmptyState,
  ErrorBox,
  H1,
  Subtitle,
} from '../../components/nav';
import { CreateWebhookForm } from './create-form';
import { removeWebhookAction, toggleWebhookAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function WebhooksPage() {
  let items: Awaited<ReturnType<typeof api.webhooks.list>>['items'] = [];
  let error: unknown = null;
  try {
    items = (await api.webhooks.list()).items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-5xl">
      <H1>Webhooks</H1>
      <Subtitle>
        Fan out audit events to PagerDuty, Zapier, n8n, or your own pipe. Every
        request is signed with HMAC-SHA256.
      </Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      <Card className="mb-6 p-4">
        <CreateWebhookForm />
      </Card>

      {items.length === 0 ? (
        <EmptyState>No webhooks yet — create one above.</EmptyState>
      ) : (
        <Card>
          <table className="w-full text-sm">
            <thead className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">URL</th>
                <th className="text-left px-4 py-2 font-medium">Events</th>
                <th className="text-left px-4 py-2 font-medium">Last delivery</th>
                <th className="text-left px-4 py-2 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((w) => {
                const last = w.last_delivery_at
                  ? new Date(w.last_delivery_at).toLocaleString()
                  : null;
                const status = w.last_delivery_status;
                const ok2xx =
                  status !== null &&
                  /^[12]\d\d$/.test(status);
                return (
                  <tr
                    key={w.id}
                    className={`border-t border-[var(--color-border)] align-top ${
                      w.enabled ? '' : 'opacity-60'
                    }`}
                  >
                    <td className="px-4 py-2">
                      <div>{w.name}</div>
                      {!w.enabled && (
                        <div className="text-xs text-amber-400">disabled</div>
                      )}
                    </td>
                    <td className="px-4 py-2 mono text-xs break-all max-w-[280px]">
                      {w.url}
                    </td>
                    <td className="px-4 py-2 mono text-xs text-[var(--color-muted)]">
                      {w.events.join(', ')}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {last ? (
                        <div>
                          <div className="text-[var(--color-muted)]">{last}</div>
                          <div
                            className={
                              ok2xx ? 'text-emerald-400' : 'text-rose-400'
                            }
                          >
                            {status}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[var(--color-muted)]">never</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <form action={toggleWebhookAction}>
                          <input type="hidden" name="id" value={w.id} />
                          <input
                            type="hidden"
                            name="enabled"
                            value={w.enabled ? '0' : '1'}
                          />
                          <button
                            type="submit"
                            className="text-xs px-2 py-1 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                          >
                            {w.enabled ? 'Disable' : 'Enable'}
                          </button>
                        </form>
                        <form action={removeWebhookAction}>
                          <input type="hidden" name="id" value={w.id} />
                          <button
                            type="submit"
                            className="text-xs px-2 py-1 rounded border border-rose-500/30 text-rose-300 hover:bg-rose-500/10"
                            title="Permanently delete this webhook subscription"
                          >
                            Delete
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
