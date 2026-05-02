'use server';

import { revalidatePath } from 'next/cache';
import { api } from '../../lib/api';

export type RegisterState =
  | { status: 'idle' }
  | {
      status: 'success';
      agent_id: string;
      api_key: string;
      api_key_prefix: string;
      name: string;
    }
  | { status: 'error'; message: string };

export async function registerAgentAction(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || undefined;
  if (!name) return { status: 'error', message: 'name is required' };
  try {
    const result = await api.agents.register({
      name,
      ...(description ? { description } : {}),
    });
    revalidatePath('/agents');
    revalidatePath('/');
    return { status: 'success', name, ...result };
  } catch (e) {
    return { status: 'error', message: (e as Error).message };
  }
}

export async function revokeAgentAction(formData: FormData) {
  const id = String(formData.get('agent_id') ?? '');
  const email = String(formData.get('revoked_by_email') ?? '').trim() || undefined;
  const reason = String(formData.get('reason') ?? '').trim() || undefined;
  if (!id) return;
  await api.agents.revoke(id, {
    ...(email ? { revoked_by_email: email } : {}),
    ...(reason ? { reason } : {}),
  });
  revalidatePath('/agents');
  revalidatePath('/audit');
  revalidatePath('/');
}
