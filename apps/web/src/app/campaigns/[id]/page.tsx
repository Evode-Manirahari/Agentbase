import { notFound } from 'next/navigation';
import { api } from '../../../lib/api';
import { Card, ErrorBox, H1, Subtitle } from '../../../components/nav';
import { RunDetailLive } from './run-detail-live';

export const dynamic = 'force-dynamic';

export default async function CampaignRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let initial: Awaited<ReturnType<typeof api.campaigns.getRun>>;
  let error: unknown = null;
  try {
    initial = await api.campaigns.getRun(id);
  } catch (e) {
    error = e;
    if ((e as Error).message?.includes('404')) notFound();
    return (
      <div className="max-w-5xl">
        <H1>Agent run</H1>
        <Subtitle>Run {id}</Subtitle>
        <ErrorBox error={error} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <H1>Agent run</H1>
      <Subtitle>
        Job <span className="mono">{initial.job_key}</span> · started{' '}
        {new Date(initial.created_at).toLocaleString()}
      </Subtitle>
      <Card className="p-4 mt-4">
        <RunDetailLive initialResult={initial} />
      </Card>
    </div>
  );
}
