'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api } from '../../lib/api';

export interface RunCampaignState {
  error: string | null;
}

const MAX_BATCH_LEADS = 50;

// Enqueues a batch (one or more leads) and redirects to the batch
// detail page. The runs execute in the worker; the detail page polls
// /v1/campaigns/batches/:id for per-run status.
export async function startCampaignAction(
  _prev: RunCampaignState,
  formData: FormData,
): Promise<RunCampaignState> {
  const jobKey = field(formData, 'job_key');
  const agentId = field(formData, 'agent_id');
  const emailsRaw = field(formData, 'emails');
  const notes = field(formData, 'notes');

  if (!jobKey || !agentId || !emailsRaw) {
    return { error: 'job, agent, and at least one lead email are required' };
  }

  const emails = parseEmailList(emailsRaw);
  if (emails.length === 0) {
    return { error: 'no valid email addresses found in the list' };
  }
  if (emails.length > MAX_BATCH_LEADS) {
    return {
      error: `batch size ${emails.length} exceeds limit of ${MAX_BATCH_LEADS}; split it`,
    };
  }

  let batchId: string;
  try {
    const created = await api.campaigns.createBatch({
      job_key: jobKey,
      agent_id: agentId,
      leads: emails.map((email) => ({
        email,
        ...(notes ? { notes } : {}),
      })),
    });
    batchId = created.batch_id;
  } catch (e) {
    return { error: (e as Error).message ?? 'campaign batch create failed' };
  }

  revalidatePath('/campaigns');
  redirect(`/campaigns/batch/${batchId}` as never);
}

function field(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '').trim();
  return value.length > 0 ? value : null;
}

// Accepts emails one per line, comma-separated, or semicolon-separated.
// Trims whitespace, drops empties, dedupes case-insensitively. Doesn't
// validate the email shape — the API does that via Zod.
function parseEmailList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,;]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
