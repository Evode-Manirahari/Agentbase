import { NextResponse, type NextRequest } from 'next/server';
import { api } from '../../../../../lib/api';

export const dynamic = 'force-dynamic';

// Proxy from the browser's polling loop to /v1/campaigns/runs/:id. The
// browser can't hit the API directly with a Clerk JWT — the api helper
// runs server-side and forwards the session token.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const run = await api.campaigns.getRun(id);
    return NextResponse.json(run, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (e) {
    const message = (e as Error).message ?? 'failed to fetch run';
    const status = message.includes('404') ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
