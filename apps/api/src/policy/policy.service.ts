import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, max } from 'drizzle-orm';
import { parse as parseYaml } from 'yaml';
import {
  AgentPermissionProfile,
  PolicyDocument,
  type ActivePolicyResponse,
  type PolicyDecision,
} from '@dejavas/shared';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { agents, policies } from '@dejavas/db';
import { evaluatePolicy, FALLBACK_POLICY } from './policy-engine.js';

@Injectable()
export class PolicyService {
  constructor(@Inject(DB) private readonly db: Database) {}

  parseAndValidate(yaml: string): PolicyDocument {
    let raw: unknown;
    try {
      raw = parseYaml(yaml);
    } catch (err) {
      throw new BadRequestException(`invalid YAML: ${(err as Error).message}`);
    }
    const parsed = PolicyDocument.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'policy schema validation failed',
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  async getActive(orgId: string): Promise<ActivePolicyResponse> {
    const rows = await this.db
      .select()
      .from(policies)
      .where(and(eq(policies.orgId, orgId), eq(policies.isActive, true)))
      .orderBy(desc(policies.version))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return {
        policy_id: null,
        name: null,
        version: null,
        yaml: null,
        document: FALLBACK_POLICY,
        is_fallback: true,
      };
    }
    return {
      policy_id: row.id,
      name: row.name,
      version: row.version,
      yaml: row.yaml,
      document: this.parseAndValidate(row.yaml),
      is_fallback: false,
    };
  }

  async setActive(input: {
    orgId: string;
    name: string;
    yaml: string;
  }): Promise<ActivePolicyResponse> {
    this.parseAndValidate(input.yaml);

    return this.db.transaction(async (tx) => {
      const maxRow = await tx
        .select({ v: max(policies.version) })
        .from(policies)
        .where(eq(policies.orgId, input.orgId));
      const nextVersion = (maxRow[0]?.v ?? 0) + 1;

      await tx
        .update(policies)
        .set({ isActive: false })
        .where(and(eq(policies.orgId, input.orgId), eq(policies.isActive, true)));

      const [created] = await tx
        .insert(policies)
        .values({
          orgId: input.orgId,
          name: input.name,
          version: nextVersion,
          yaml: input.yaml,
          isActive: true,
        })
        .returning();
      if (!created) throw new Error('failed to create policy');

      return {
        policy_id: created.id,
        name: created.name,
        version: created.version,
        yaml: created.yaml,
        document: this.parseAndValidate(created.yaml),
        is_fallback: false,
      };
    });
  }

  async evaluate(
    orgId: string,
    action: {
      tool: string;
      params: Record<string, unknown>;
      agentId?: string | undefined;
    },
  ): Promise<PolicyDecision> {
    const active = await this.getActive(orgId);
    const doc = active.document ?? FALLBACK_POLICY;
    const agent = action.agentId
      ? await this.agentContext(orgId, action.agentId)
      : null;
    return evaluatePolicy(doc, { ...action, agent }, {
      policyId: active.policy_id,
      isFallback: active.is_fallback,
    });
  }

  private async agentContext(orgId: string, agentId: string) {
    const [row] = await this.db
      .select({
        id: agents.id,
        name: agents.name,
        permissionProfile: agents.permissionProfile,
      })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
      .limit(1);
    if (!row) return null;
    const parsed = AgentPermissionProfile.safeParse(row.permissionProfile);
    return {
      id: row.id,
      name: row.name,
      permission_profile: parsed.success ? parsed.data : 'custom',
    };
  }
}
