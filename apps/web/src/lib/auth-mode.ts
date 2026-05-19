// Dashboard-side mirror of apps/api/src/auth/auth-mode.ts. The contract is
// the same — in production, refuse to dev-passthrough unless the operator
// has explicitly opted in via DEJAVAS_ALLOW_UNAUTHENTICATED=1.

export type AuthMode = 'enforced' | 'dev_passthrough';

export class UnauthenticatedProductionError extends Error {
  constructor() {
    super(
      'Dejavas dashboard refuses to serve in production without authentication. ' +
        'Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (and CLERK_SECRET_KEY on the API) ' +
        'to enforce Clerk session tokens, or set DEJAVAS_ALLOW_UNAUTHENTICATED=1 ' +
        'to explicitly opt in to an unauthenticated deployment.',
    );
    this.name = 'UnauthenticatedProductionError';
  }
}

/**
 * Resolves whether the dashboard should enforce Clerk auth for the current env.
 */
export function resolveAuthMode(): AuthMode {
  const publishable = (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '').trim();
  if (publishable.length > 0) return 'enforced';

  const isProd = (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  const allowUnauth = (process.env.DEJAVAS_ALLOW_UNAUTHENTICATED ?? '').trim() === '1';
  if (isProd && !allowUnauth) {
    throw new UnauthenticatedProductionError();
  }
  return 'dev_passthrough';
}

/**
 * Resolves auth mode and logs the production refusal reason before rethrowing.
 */
export function authModeOrFatal(): AuthMode {
  try {
    return resolveAuthMode();
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.error('[dejavas-web]', (err as Error).message);
    }
    throw err;
  }
}
