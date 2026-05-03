'use server';

import { revalidatePath } from 'next/cache';
import { api, type WebhookSubscriptionCreated } from '../../lib/api';
import { KNOWN_EVENTS } from './events';

export type CreateState =
  | { status: 'idle' }
  | { status: 'success'; subscription: WebhookSubscriptionCreated }
  | { status: 'error'; message: string };

export async function createWebhookAction(
  _prev: CreateState,
  formData: FormData,
): Promise<CreateState> {
  const name = String(formData.get('name') ?? '').trim();
  const url = String(formData.get('url') ?? '').trim();
  const eventsRaw = formData.getAll('events').map(String);
  const wildcard = String(formData.get('wildcard') ?? '') === 'on';

  if (!name) return { status: 'error', message: 'name is required' };
  if (!url) return { status: 'error', message: 'url is required' };
  try {
    new URL(url);
  } catch {
    return { status: 'error', message: 'url must be a valid absolute URL' };
  }

  const events = wildcard
    ? ['*']
    : eventsRaw.filter((e) => KNOWN_EVENTS.includes(e as (typeof KNOWN_EVENTS)[number]));
  if (events.length === 0) {
    return {
      status: 'error',
      message: 'select at least one event (or check "All events")',
    };
  }

  try {
    const sub = await api.webhooks.create({ name, url, events });
    revalidatePath('/webhooks');
    return { status: 'success', subscription: sub };
  } catch (e) {
    return { status: 'error', message: (e as Error).message };
  }
}

export async function toggleWebhookAction(formData: FormData) {
  const id = String(formData.get('id') ?? '');
  const enabled = String(formData.get('enabled') ?? '') === '1';
  if (!id) return;
  await api.webhooks.update(id, { enabled });
  revalidatePath('/webhooks');
}

export async function removeWebhookAction(formData: FormData) {
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  await api.webhooks.remove(id);
  revalidatePath('/webhooks');
}
