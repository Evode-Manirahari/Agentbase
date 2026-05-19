'use server';

import { revalidatePath } from 'next/cache';
import { api, type AgentRunResult } from '../../lib/api';

export interface RunCampaignState {
  result: AgentRunResult | null;
  error: string | null;
}

export async function runCampaignAction(
  _prev: RunCampaignState,
  formData: FormData,
): Promise<RunCampaignState> {
  const jobKey = field(formData, 'job_key');
  const agentId = field(formData, 'agent_id');
  const email = field(formData, 'email');
  const notes = field(formData, 'notes');

  if (!jobKey || !agentId || !email) {
    return {
      result: null,
      error: 'job, agent, and lead email are required',
    };
  }

  try {
    const result = await api.campaigns.run({
      job_key: jobKey,
      agent_id: agentId,
      context: {
        email,
        ...(notes ? { notes } : {}),
      },
    });
    revalidatePath('/');
    revalidatePath('/approvals');
    revalidatePath('/actions');
    revalidatePath('/audit');
    return { result, error: null };
  } catch (e) {
    return {
      result: null,
      error: (e as Error).message ?? 'campaign run failed',
    };
  }
}

function field(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '').trim();
  return value.length > 0 ? value : null;
}
