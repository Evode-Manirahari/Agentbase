import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB } from '../db/db.module.js';
import type { Database } from '@agentbase/db';
import { agents, agentApiKeys } from '@agentbase/db';
import { hashApiKey, isValidKeyShape } from './api-key.js';

export interface AuthedAgent {
  agentId: string;
  orgId: string;
  apiKeyId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    agent?: AuthedAgent;
  }
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header = (req.headers['authorization'] ?? '') as string;
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token || !isValidKeyShape(token)) {
      throw new UnauthorizedException('missing or malformed api key');
    }

    const hash = hashApiKey(token);
    const rows = await this.db
      .select({
        keyId: agentApiKeys.id,
        agentId: agents.id,
        orgId: agents.orgId,
        agentStatus: agents.status,
        revokedAt: agentApiKeys.revokedAt,
      })
      .from(agentApiKeys)
      .innerJoin(agents, eq(agents.id, agentApiKeys.agentId))
      .where(eq(agentApiKeys.keyHash, hash))
      .limit(1);

    const row = rows[0];
    if (!row || row.revokedAt || row.agentStatus !== 'active') {
      throw new UnauthorizedException('invalid or revoked api key');
    }

    req.agent = { agentId: row.agentId, orgId: row.orgId, apiKeyId: row.keyId };
    return true;
  }
}
