'use server';

import { revalidatePath } from 'next/cache';
import { api, type BulkApprovalDecisionResponse } from '../../lib/api';

export interface BulkDecideState {
  result: BulkApprovalDecisionResponse | null;
  error: string | null;
}

export async function decideOneAction(formData: FormData) {
  const id = String(formData.get('approval_id') ?? '');
  const decision = String(formData.get('decision') ?? '') as 'approve' | 'deny';
  const email = String(formData.get('email') ?? '').trim() || undefined;
  const notes = String(formData.get('notes') ?? '').trim() || undefined;
  if (!id || (decision !== 'approve' && decision !== 'deny')) return;
  await api.approvals.decide(id, {
    decision,
    ...(email ? { decided_by_email: email } : {}),
    ...(notes ? { notes } : {}),
  });
  revalidatePath('/approvals');
  revalidatePath('/');
  revalidatePath('/actions');
  revalidatePath('/audit');
}

// Bulk decide is hit via fetch from the client component so we can
// surface the per-id outcomes inline. A revalidatePath afterward
// refreshes the row list.
export async function bulkDecideAction(
  _prev: BulkDecideState,
  formData: FormData,
): Promise<BulkDecideState> {
  const ids = formData.getAll('approval_id').map((v) => String(v));
  const decision = String(formData.get('decision') ?? '') as 'approve' | 'deny';
  const email = String(formData.get('email') ?? '').trim() || undefined;
  const notes = String(formData.get('notes') ?? '').trim() || undefined;

  if (ids.length === 0) {
    return { result: null, error: 'Select at least one approval.' };
  }
  if (decision !== 'approve' && decision !== 'deny') {
    return { result: null, error: 'Decision must be approve or deny.' };
  }
  if (!email) {
    return {
      result: null,
      error: 'Your email is required so the decision is attributed.',
    };
  }

  try {
    const result = await api.approvals.bulkDecide({
      approval_ids: ids,
      decision,
      decided_by_email: email,
      ...(notes ? { notes } : {}),
    });
    revalidatePath('/approvals');
    revalidatePath('/');
    revalidatePath('/actions');
    revalidatePath('/audit');
    return { result, error: null };
  } catch (e) {
    return {
      result: null,
      error: (e as Error).message ?? 'bulk decide failed',
    };
  }
}
