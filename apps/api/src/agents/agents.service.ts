import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@dejavas/db';
import { agents, agentApiKeys, orgs } from '@dejavas/db';
import { generateApiKey } from '../auth/api-key.js';

@Injectable()
export class AgentsService {
  constructor(@Inject(DB) private readonly db: Database) {}

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
  }) {
    const [agent] = await this.db
      .insert(agents)
      .values({
        orgId: input.orgId,
        name: input.name,
        description: input.description ?? null,
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
    };
  }

  async getById(agentId: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('agent not found');
    return row;
  }
}
