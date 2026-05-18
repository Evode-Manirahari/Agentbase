// Single source of truth for "is Clerk session-token auth enforced?".
//
// Used by ClerkAuthGuard on the API and by the dashboard middleware/layout/
// route handlers on the web. The contract:
//
// - CLERK_SECRET_KEY set            → 'enforced' (the only mode safe for
//                                     paid pilots).
// - NODE_ENV !== 'production'       → 'dev_passthrough' (local dev).
// - NODE_ENV === 'production' but
//   DEJAVAS_ALLOW_UNAUTHENTICATED=1 → 'dev_passthrough' (explicit operator
//                                     opt-in, e.g. demo behind a VPN).
// - NODE_ENV === 'production' and
//   no secret and no escape hatch   → throws. The app refuses to boot —
//                                     better than silently exposing
//                                     /v1/agents to the world.

export type AuthMode = 'enforced' | 'dev_passthrough';

export interface AuthModeEnv {
  NODE_ENV?: string | undefined;
  CLERK_SECRET_KEY?: string | undefined;
  DEJAVAS_ALLOW_UNAUTHENTICATED?: string | undefined;
}

export class UnauthenticatedProductionError extends Error {
  constructor() {
    super(
      'Dejavas refuses to boot in production without authentication. ' +
        'Set CLERK_SECRET_KEY to enforce Clerk session tokens on management ' +
        'endpoints, or set DEJAVAS_ALLOW_UNAUTHENTICATED=1 to explicitly opt ' +
        'in to an unauthenticated deployment (every /v1 endpoint will be open).',
    );
    this.name = 'UnauthenticatedProductionError';
  }
}

export function resolveAuthMode(env: AuthModeEnv): AuthMode {
  const secret = (env.CLERK_SECRET_KEY ?? '').trim();
  if (secret.length > 0) return 'enforced';

  const isProd = (env.NODE_ENV ?? '').toLowerCase() === 'production';
  const allowUnauth = (env.DEJAVAS_ALLOW_UNAUTHENTICATED ?? '').trim() === '1';

  if (isProd && !allowUnauth) {
    throw new UnauthenticatedProductionError();
  }
  return 'dev_passthrough';
}
