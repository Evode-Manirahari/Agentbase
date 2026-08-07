'use server';

import { revalidatePath } from 'next/cache';
import { api, type BulkApprovalDecisionResponse } from '../../lib/api';

export interface BulkDecideState {
  result: BulkApprovalDecisionResponse | null;
  error: string | null;
}

// The decider is derived from the verified session by the API and cannot be
// supplied by the caller.
//
// `decided_by_email` was accepted from the request body once, and that was the
// spoofing hole #81 closed. It has been off the contract since, so the copy the
// dashboard kept sending was never a live vector — the API discarded it. The
// problem was that the form still asked for it: a field presented as
// attribution, attributing nothing, and marked required.
export async function decideOneAction(formData: FormData) {
  const id = String(formData.get('approval_id') ?? '');
  const decision = String(formData.get('decision') ?? '') as 'approve' | 'deny';
  const notes = String(formData.get('notes') ?? '').trim() || undefined;
  if (!id || (decision !== 'approve' && decision !== 'deny')) return;
  await api.approvals.decide(id, {
    decision,
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
  const notes = String(formData.get('notes') ?? '').trim() || undefined;

  if (ids.length === 0) {
    return { result: null, error: 'Select at least one approval.' };
  }
  if (decision !== 'approve' && decision !== 'deny') {
    return { result: null, error: 'Decision must be approve or deny.' };
  }
  // The email requirement here blocked bulk decide outright behind a field the
  // API discards. Attribution comes from the session, so there is nothing to
  // ask for.

  try {
    const result = await api.approvals.bulkDecide({
      approval_ids: ids,
      decision,
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
