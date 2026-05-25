import { notFound } from 'next/navigation';
import { api } from '../../../../lib/api';
import { Card, ErrorBox, H1, Subtitle } from '../../../../components/nav';
import { BatchDetailLive } from './batch-detail-live';

export const dynamic = 'force-dynamic';

export default async function CampaignBatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let initial: Awaited<ReturnType<typeof api.campaigns.getBatch>>;
  let error: unknown = null;
  try {
    initial = await api.campaigns.getBatch(id);
  } catch (e) {
    error = e;
    if ((e as Error).message?.includes('404')) notFound();
    return (
      <div className="max-w-5xl">
        <H1>Governed batch</H1>
        <Subtitle>Batch {id}</Subtitle>
        <ErrorBox error={error} />
      </div>
    );
  }

  const first = initial.runs[0];
  return (
    <div className="max-w-5xl">
      <H1>Governed batch</H1>
      <Subtitle>
        {initial.run_count} run{initial.run_count === 1 ? '' : 's'} · job{' '}
        <span className="mono">{first?.job_key ?? '—'}</span> · started{' '}
        {first ? new Date(first.created_at).toLocaleString() : '—'}
      </Subtitle>
      <Card className="p-4 mt-4">
        <BatchDetailLive initialBatch={initial} />
      </Card>
    </div>
  );
}
