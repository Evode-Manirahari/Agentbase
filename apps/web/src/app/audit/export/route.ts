import { auth } from '@clerk/nextjs/server';
import type { NextRequest } from 'next/server';

const BASE_URL = process.env.API_URL ?? 'http://localhost:3002';
const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const FORWARDED_PARAMS = ['format', 'actor_type', 'event_type', 'since', 'until', 'max_rows'];
const EXPORT_TIMEOUT_MS = 30_000;

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const incoming = req.nextUrl.searchParams;
  const forwarded = new URLSearchParams();
  for (const key of FORWARDED_PARAMS) {
    const value = incoming.get(key);
    if (value !== null && value !== '') forwarded.set(key, value);
  }

  const headers = new Headers();
  if (clerkEnabled) {
    try {
      const token = await (await auth()).getToken();
      if (token) headers.set('authorization', `Bearer ${token}`);
    } catch {
      // fall through; API will reject with 401 if auth is required
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BASE_URL}/v1/audit/export?${forwarded.toString()}`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
  } catch (error) {
    if (isAbortError(error)) {
      return new Response('audit export timed out', { status: 504 });
    }
    return new Response('audit export failed', { status: 502 });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return new Response(text || 'audit export failed', { status: upstream.status });
  }

  const responseHeaders = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) responseHeaders.set('content-type', contentType);
  const disposition = upstream.headers.get('content-disposition');
  if (disposition) responseHeaders.set('content-disposition', disposition);
  responseHeaders.set('cache-control', 'no-store');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}
