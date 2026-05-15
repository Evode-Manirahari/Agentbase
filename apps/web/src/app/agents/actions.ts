'use server';

import { revalidatePath } from 'next/cache';
import {
  AgentPermissionProfile,
  buildAgentPermissionProfilePolicyYaml,
} from '@dejavas/shared';
import { api } from '../../lib/api';

export type RegisterState =
  | { status: 'idle' }
  | {
      status: 'success';
      agent_id: string;
      api_key: string;
      api_key_prefix: string;
      permission_profile: AgentPermissionProfile;
      name: string;
    }
  | { status: 'error'; message: string };

export async function registerAgentAction(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || undefined;
  const rawProfile = String(formData.get('permission_profile') ?? '').trim();
  const permissionProfile = AgentPermissionProfile.safeParse(rawProfile).success
    ? AgentPermissionProfile.parse(rawProfile)
    : 'sales_sdr';
  if (!name) return { status: 'error', message: 'name is required' };
  try {
    const result = await api.agents.register({
      name,
      ...(description ? { description } : {}),
      permission_profile: permissionProfile,
    });
    revalidatePath('/agents');
    revalidatePath('/');
    return { status: 'success', name, ...result };
  } catch (e) {
    return { status: 'error', message: (e as Error).message };
  }
}

export async function updateAgentProfileAction(formData: FormData) {
  const id = String(formData.get('agent_id') ?? '');
  const rawProfile = String(formData.get('permission_profile') ?? '').trim();
  const parsed = AgentPermissionProfile.safeParse(rawProfile);
  if (!id || !parsed.success) return;
  await api.agents.updatePermissionProfile(id, parsed.data);
  revalidatePath('/agents');
  revalidatePath('/audit');
  revalidatePath('/');
}

export async function installPermissionProfilePolicyAction() {
  await api.policies.setActive({
    name: 'agent-permission-profiles',
    yaml: buildAgentPermissionProfilePolicyYaml(),
  });
  revalidatePath('/agents');
  revalidatePath('/policies');
  revalidatePath('/');
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
