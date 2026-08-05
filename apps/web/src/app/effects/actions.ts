'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api } from '../../lib/api';

/**
 * Record what a human found at the provider, ending a quarantine.
 *
 * Deliberately not a retry. Resolving says "I looked, and here is what is
 * true" — the effect is not re-attempted, because if it already landed,
 * attempting it again is the exact failure the commit protocol exists to
 * prevent.
 */
export async function resolveEffectAction(formData: FormData) {
  const receiptId = String(formData.get('receipt_id') ?? '');
  const outcome = String(formData.get('outcome') ?? '');
  if (!receiptId || (outcome !== 'committed' && outcome !== 'failed')) {
    redirect('/effects?status=error&message=missing+receipt+or+outcome' as never);
  }

  const providerRef = String(formData.get('provider_ref') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();

  try {
    await api.effects.resolve(receiptId, {
      outcome: outcome as 'committed' | 'failed',
      ...(providerRef ? { provider_ref: providerRef } : {}),
      ...(note ? { note } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'resolve failed';
    redirect(
      `/effects?status=error&message=${encodeURIComponent(msg)}` as never,
    );
  }

  revalidatePath('/effects');
  revalidatePath('/actions');
  revalidatePath('/audit');
  redirect(`/effects?status=ok&message=${encodeURIComponent('recorded')}` as never);
}
