'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
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

export async function runHubspotLeadWorkflowAction(formData: FormData) {
  const email = field(formData, 'email');
  const dealname = field(formData, 'dealname');
  const amount = numberField(formData, 'amount');
  const params = new URLSearchParams();

  if (!email || !dealname) {
    params.set('demo', 'error');
    params.set('message', 'email and deal name are required');
    redirect(`/actions?${params.toString()}` as never);
  }

  try {
    const result = await api.actions.runHubspotLeadWorkflow({
      email,
      dealname,
      ...(field(formData, 'firstname') ? { firstname: field(formData, 'firstname')! } : {}),
      ...(field(formData, 'lastname') ? { lastname: field(formData, 'lastname')! } : {}),
      ...(field(formData, 'company') ? { company: field(formData, 'company')! } : {}),
      ...(field(formData, 'jobtitle') ? { jobtitle: field(formData, 'jobtitle')! } : {}),
      ...(field(formData, 'phone') ? { phone: field(formData, 'phone')! } : {}),
      ...(amount !== null ? { amount } : {}),
      ...(field(formData, 'pipeline') ? { pipeline: field(formData, 'pipeline')! } : {}),
      ...(field(formData, 'dealstage') ? { dealstage: field(formData, 'dealstage')! } : {}),
      ...(field(formData, 'note') ? { note: field(formData, 'note')! } : {}),
    });
    params.set('demo', result.status === 'executed' ? 'ok' : result.status);
    params.set('message', `HubSpot workflow action ${result.status}`);
  } catch (e) {
    params.set('demo', 'error');
    params.set('message', (e as Error).message);
  }

  revalidatePath('/actions');
  revalidatePath('/audit');
  revalidatePath('/');
  redirect(`/actions?${params.toString()}` as never);
}

function field(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? '').trim();
  return value.length > 0 ? value : null;
}

function numberField(formData: FormData, key: string): number | null {
  const value = field(formData, key);
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
