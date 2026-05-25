import { api } from '../../lib/api';
import { EmptyState, ErrorBox, H1, Subtitle } from '../../components/nav';
import { ApprovalsList } from './approvals-list';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  let items: Awaited<ReturnType<typeof api.approvals.list>>['items'] = [];
  let error: unknown = null;
  try {
    items = (await api.approvals.list()).items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-5xl">
      <H1>Approvals</H1>
      <Subtitle>
        Pending actions waiting for human sign-off. Select multiple rows to
        approve or deny in one go when a batch of outbound email, CRM updates,
        or sequence actions needs operator review.
      </Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      {items.length === 0 ? (
        <EmptyState>Inbox zero. No pending approvals.</EmptyState>
      ) : (
        <ApprovalsList items={items} />
      )}
    </div>
  );
}
