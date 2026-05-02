// Clerk session-token guard for management endpoints (everything that isn't
// agent-API-key authenticated or Slack-signed).
//
// Behavior:
// - CLERK_SECRET_KEY unset → DEV MODE: passes every request through; logs a
//   warning once at boot. This is what local development uses.
// - CLERK_SECRET_KEY set → enforces a Clerk session token in
//   `Authorization: Bearer <token>`, verified via @clerk/backend's
//   verifyToken (validates JWT signature against Clerk's JWKS).
//
// On success in enforced mode, attaches { userId, sessionId } to req.clerkUser
// so controllers can identify the actor.

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyToken } from '@clerk/backend';

export interface ClerkAuthedUser {
  userId: string;
  sessionId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    clerkUser?: ClerkAuthedUser;
  }
}

@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly log = new Logger(ClerkAuthGuard.name);
  private readonly secretKey: string | null;

  constructor(config: ConfigService) {
    const sk = config.get<string>('CLERK_SECRET_KEY');
    this.secretKey = sk && sk.length > 0 ? sk : null;
    if (!this.secretKey) {
      this.log.warn(
        'CLERK_SECRET_KEY not set — management endpoints are UNAUTHENTICATED (dev mode)',
      );
    }
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.secretKey) return true;

    const req = ctx.switchToHttp().getRequest();
    const header = (req.headers['authorization'] ?? '') as string;
    const token = header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : '';
    if (!token) {
      throw new UnauthorizedException('missing Clerk session token');
    }

    let claims: Awaited<ReturnType<typeof verifyToken>>;
    try {
      claims = await verifyToken(token, { secretKey: this.secretKey });
    } catch (err) {
      throw new UnauthorizedException(
        `invalid Clerk session: ${(err as Error).message}`,
      );
    }

    const sub = (claims as { sub?: unknown }).sub;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new UnauthorizedException('Clerk token missing sub claim');
    }
    const sid = (claims as { sid?: unknown }).sid;
    req.clerkUser = {
      userId: sub,
      sessionId: typeof sid === 'string' ? sid : null,
    };
    return true;
  }
}
