'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, type ConnectorStatus } from '../../lib/api';

export type ConnectorFormState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string };

export async function saveConnectorCredentialsAction(
  _prev: ConnectorFormState,
  formData: FormData,
): Promise<ConnectorFormState> {
  const provider = String(formData.get('provider') ?? '') as ConnectorStatus['provider'];
  const credentials: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key === 'provider') continue;
    const trimmed = String(value).trim();
    if (trimmed) credentials[key] = trimmed;
  }

  if (!provider) return { status: 'error', message: 'provider is required' };
  if (Object.keys(credentials).length === 0) {
    return { status: 'error', message: 'enter at least one credential field' };
  }

  try {
    await api.connectors.saveCredentials(provider, credentials);
    revalidatePath('/connectors');
    return { status: 'success', message: `${provider} credentials saved` };
  } catch (e) {
    return { status: 'error', message: (e as Error).message };
  }
}

export async function disableConnectorAction(formData: FormData) {
  const provider = String(formData.get('provider') ?? '') as ConnectorStatus['provider'];
  if (!provider) return;
  await api.connectors.disable(provider);
  revalidatePath('/connectors');
}

export async function startHubspotOAuthAction() {
  const out = await api.connectors.startOAuth('hubspot');
  redirect(out.authorization_url as never);
}

export async function testConnectorAction(formData: FormData) {
  const provider = String(formData.get('provider') ?? '') as ConnectorStatus['provider'];
  if (!provider) return;

  const params = new URLSearchParams({ provider });
  try {
    const out = await api.connectors.test(provider);
    params.set('test', out.ok ? 'ok' : 'error');
    const err = (out.result as { error?: { code?: string; message?: string } }).error;
    params.set(
      'message',
      out.ok
        ? `${provider} connection is healthy`
        : err?.message ?? `${provider} connection failed`,
    );
  } catch (e) {
    params.set('test', 'error');
    params.set('message', (e as Error).message);
  }

  revalidatePath('/connectors');
  redirect(`/connectors?${params.toString()}` as never);
}
