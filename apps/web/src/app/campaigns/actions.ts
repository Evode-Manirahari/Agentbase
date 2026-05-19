'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api } from '../../lib/api';

export interface RunCampaignState {
  error: string | null;
}

// Enqueues a run and redirects to its detail page. The run executes in
// the worker; the detail page polls /v1/campaigns/runs/:id for status.
export async function startCampaignAction(
  _prev: RunCampaignState,
  formData: FormData,
): Promise<RunCampaignState> {
  const jobKey = field(formData, 'job_key');
  const agentId = field(formData, 'agent_id');
  const email = field(formData, 'email');
  const notes = field(formData, 'notes');

  if (!jobKey || !agentId || !email) {
    return { error: 'job, agent, and lead email are required' };
  }

  let runId: string;
  try {
    const created = await api.campaigns.createRun({
      job_key: jobKey,
      agent_id: agentId,
      context: {
        email,
        ...(notes ? { notes } : {}),
      },
    });
    runId = created.id;
  } catch (e) {
    return { error: (e as Error).message ?? 'campaign create failed' };
  }

  revalidatePath('/campaigns');
  redirect(`/campaigns/${runId}` as never);
}

function field(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '').trim();
  return value.length > 0 ? value : null;
}
