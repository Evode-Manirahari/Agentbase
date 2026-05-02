import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';

const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const isPublic = createRouteMatcher(['/sign-in(.*)']);

const protectedClerkMiddleware = clerkMiddleware(async (auth, req) => {
  if (!isPublic(req)) await auth.protect();
});

// In dev mode (no Clerk keys configured), the API also accepts requests
// without a Bearer token, so the dashboard can still hit it. Set both
// NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY to flip auth on.
export default clerkEnabled
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
