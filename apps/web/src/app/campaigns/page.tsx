import { api } from '../../lib/api';
import { Card, ErrorBox, H1, Subtitle } from '../../components/nav';
import { CampaignForm } from './campaign-form';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  let agents: Awaited<ReturnType<typeof api.agents.list>>['items'] = [];
  let jobs: Awaited<ReturnType<typeof api.campaigns.jobs>>['items'] = [];
  let error: unknown = null;
  try {
    const [a, j] = await Promise.all([
      api.agents.list(),
      api.campaigns.jobs(),
    ]);
    agents = a.items;
    jobs = j.items;
  } catch (e) {
    error = e;
  }

  return (
    <div className="max-w-5xl">
      <H1>Campaigns</H1>
      <Subtitle>
        Run an AI SDR agent against one lead. Risky writes pause for human approval —
        the safety story is wired at the code level, not marketing.
      </Subtitle>

      {error ? <ErrorBox error={error} /> : null}

      <Card className="p-4 mt-4">
        <CampaignForm agents={agents} jobs={jobs} />
      </Card>
    </div>
  );
}
