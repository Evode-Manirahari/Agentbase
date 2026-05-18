// Clerk session-token guard for management endpoints (everything that isn't
// agent-API-key authenticated or Slack-signed).
//
// Behavior is delegated to resolveAuthMode() — see auth-mode.ts:
// - 'enforced'        → requires a Clerk session token in `Authorization:
//                       Bearer <token>`, verified via @clerk/backend's
//                       verifyToken (validates JWT signature against Clerk's
//                       JWKS).
// - 'dev_passthrough' → passes every request through; logs a warning once at
//                       boot. Reserved for local development; refused in
//                       production unless DEJAVAS_ALLOW_UNAUTHENTICATED=1 is
//                       explicitly set.
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
import { resolveAuthMode, type AuthMode } from './auth-mode.js';

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
  private readonly mode: AuthMode;
  private readonly secretKey: string | null;

  constructor(config: ConfigService) {
    const sk = config.get<string>('CLERK_SECRET_KEY');
    this.secretKey = sk && sk.length > 0 ? sk : null;
    // resolveAuthMode throws when NODE_ENV=production and there is no secret
    // and no explicit unauthenticated opt-in — boot fails fast instead of
    // silently exposing every /v1 endpoint.
    this.mode = resolveAuthMode({
      NODE_ENV: config.get<string>('NODE_ENV') ?? process.env.NODE_ENV,
      CLERK_SECRET_KEY: this.secretKey ?? undefined,
      DEJAVAS_ALLOW_UNAUTHENTICATED:
        config.get<string>('DEJAVAS_ALLOW_UNAUTHENTICATED') ??
        process.env.DEJAVAS_ALLOW_UNAUTHENTICATED,
    });
    if (this.mode === 'dev_passthrough') {
      this.log.warn(
        'ClerkAuthGuard running in DEV PASSTHROUGH mode — management endpoints accept any request. Set CLERK_SECRET_KEY for enforced mode.',
      );
    }
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.mode === 'dev_passthrough') return true;
    if (!this.secretKey) return true; // unreachable, kept for type narrowing

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
