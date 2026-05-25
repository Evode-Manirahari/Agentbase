import { forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@agentbase/db';
import { agents, agentApiKeys, orgs } from '@agentbase/db';
import { AgentPermissionProfile } from '@agentbase/shared';
import { generateApiKey } from '../auth/api-key.js';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class AgentsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(forwardRef(() => AuditService))
    private readonly audit: AuditService,
  ) {}

  /**
   * Bootstrap helper for the smoke test: ensure a default org exists and return its id.
   * Real auth/org resolution will replace this once Clerk is wired up.
   */
  async ensureDefaultOrg(): Promise<string> {
    const slug = 'default';
    const existing = await this.db.select().from(orgs).where(eq(orgs.slug, slug)).limit(1);
    const found = existing[0];
    if (found) return found.id;
    const [created] = await this.db
      .insert(orgs)
      .values({ name: 'Default Org', slug })
      .returning();
    if (!created) throw new Error('failed to create default org');
    return created.id;
  }

  async register(input: {
    orgId: string;
    name: string;
    description?: string | undefined;
    permissionProfile?: AgentPermissionProfile | undefined;
  }) {
    const [agent] = await this.db
      .insert(agents)
      .values({
        orgId: input.orgId,
        name: input.name,
        description: input.description ?? null,
        permissionProfile: input.permissionProfile ?? 'sales_sdr',
      })
      .returning();
    if (!agent) throw new Error('failed to create agent');

    const key = generateApiKey();
    await this.db.insert(agentApiKeys).values({
      agentId: agent.id,
      keyHash: key.hash,
      keyPrefix: key.prefix,
    });

    return {
      agent_id: agent.id,
      api_key: key.plaintext,
      api_key_prefix: key.prefix,
      permission_profile: parsePermissionProfile(agent.permissionProfile),
    };
  }

  async ensureInternalAgent(input: {
    orgId: string;
    name: string;
    description?: string | undefined;
    permissionProfile?: AgentPermissionProfile | undefined;
  }) {
    const existing = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.orgId, input.orgId),
          eq(agents.name, input.name),
          eq(agents.status, 'active'),
        ),
      )
      .orderBy(desc(agents.createdAt))
      .limit(1);
    const found = existing[0];
    if (found) return found;

    const [created] = await this.db
      .insert(agents)
      .values({
        orgId: input.orgId,
        name: input.name,
        description: input.description ?? null,
        permissionProfile: input.permissionProfile ?? 'sales_sdr',
      })
      .returning();
    if (!created) throw new Error('failed to create internal agent');
    return created;
  }

  async getById(agentId: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('agent not found');
    return row;
  }

  async revoke(input: {
    orgId: string;
    agentId: string;
    reason?: string | undefined;
    revokedByEmail?: string | undefined;
  }) {
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.orgId, input.orgId)))
      .limit(1);
    const found = rows[0];
    if (!found) throw new NotFoundException('agent not found');

    if (found.status === 'revoked') {
      return {
        agent_id: found.id,
        status: 'revoked' as const,
        revoked_at: found.revokedAt?.toISOString() ?? null,
        keys_revoked: 0,
        already_revoked: true,
      };
    }

    const now = new Date();
    const revokedKeys = await this.db.transaction(async (tx) => {
      await tx
        .update(agents)
        .set({ status: 'revoked', revokedAt: now })
        .where(eq(agents.id, input.agentId));
      return tx
        .update(agentApiKeys)
        .set({ revokedAt: now })
        .where(
          and(
            eq(agentApiKeys.agentId, input.agentId),
            isNull(agentApiKeys.revokedAt),
          ),
        )
        .returning({ id: agentApiKeys.id, prefix: agentApiKeys.keyPrefix });
    });

    await this.audit.record({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.revokedByEmail ?? 'unknown',
      eventType: 'agent.revoked',
      payload: {
        agentId: input.agentId,
        agentName: found.name,
        keysRevoked: revokedKeys.length,
        keyPrefixes: revokedKeys.map((k) => k.prefix),
        reason: input.reason ?? null,
      },
    });

    return {
      agent_id: found.id,
      status: 'revoked' as const,
      revoked_at: now.toISOString(),
      keys_revoked: revokedKeys.length,
      already_revoked: false,
    };
  }

  async updatePermissionProfile(input: {
    orgId: string;
    agentId: string;
    permissionProfile: AgentPermissionProfile;
    actorId: string;
  }) {
    const rows = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.orgId, input.orgId)))
      .limit(1);
    const found = rows[0];
    if (!found) throw new NotFoundException('agent not found');

    const [updated] = await this.db
      .update(agents)
      .set({ permissionProfile: input.permissionProfile })
      .where(eq(agents.id, input.agentId))
      .returning();
    if (!updated) throw new Error('failed to update agent permission profile');

    await this.audit.record({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.actorId,
      eventType: 'agent.permission_profile.updated',
      payload: {
        agentId: input.agentId,
        agentName: found.name,
        from: parsePermissionProfile(found.permissionProfile),
        to: input.permissionProfile,
      },
    });

    return updated;
  }

  async listForOrg(orgId: string, limit = 100) {
    return this.db
      .select({
        id: agents.id,
        name: agents.name,
        description: agents.description,
        permissionProfile: agents.permissionProfile,
        status: agents.status,
        createdAt: agents.createdAt,
        revokedAt: agents.revokedAt,
        keyPrefix: agentApiKeys.keyPrefix,
      })
      .from(agents)
      .leftJoin(agentApiKeys, eq(agentApiKeys.agentId, agents.id))
      .where(eq(agents.orgId, orgId))
      .orderBy(desc(agents.createdAt))
      .limit(limit);
  }
}

function parsePermissionProfile(value: string): AgentPermissionProfile {
  const parsed = AgentPermissionProfile.safeParse(value);
  return parsed.success ? parsed.data : 'custom';
}
