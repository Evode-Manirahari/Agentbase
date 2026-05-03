'use server';

import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';

export async function retryActionAction(formData: FormData) {
  const id = String(formData.get('action_id') ?? '');
  if (!id) return;
  try {
    await api.actions.retry(id);
  } catch {
    // Surface via revalidate; the row's status reflects the outcome.
  }
  revalidatePath('/actions');
  revalidatePath('/audit');
  revalidatePath('/');
}
