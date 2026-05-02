'use server';

import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';

export async function setPolicyAction(formData: FormData) {
  const yaml = String(formData.get('yaml') ?? '').trim();
  const name = String(formData.get('name') ?? 'default').trim() || 'default';
  if (!yaml) return;
  await api.policies.setActive({ name, yaml });
  revalidatePath('/policies');
  revalidatePath('/');
}
