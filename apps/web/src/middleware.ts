import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import { authModeOrFatal } from './lib/auth-mode';

// authModeOrFatal throws when NODE_ENV=production and Clerk env vars are
// missing and DEJAVAS_ALLOW_UNAUTHENTICATED=1 isn't set. That intentionally
// crashes the middleware at boot so the dashboard refuses to serve rather
// than silently dev-passthrough in production.
const mode = authModeOrFatal();

const isPublic = createRouteMatcher(['/sign-in(.*)']);

const protectedClerkMiddleware = clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

export default mode === 'enforced'
  ? protectedClerkMiddleware
  : function devModePassthrough(_req: NextRequest) {
      return NextResponse.next();
    };

export const config = {
  matcher: [
    '/((?!_next|.+\\.[\\w]+$).*)',
    '/(api|trpc)(.*)',
  ],
};
