import { NextResponse, type NextRequest } from 'next/server';
import { api } from '../../../../../lib/api';

export const dynamic = 'force-dynamic';

// Server-side proxy from the browser's polling loop to
// /v1/campaigns/batches/:id. The api helper forwards the Clerk JWT
// that lives server-side; the browser never sees the token.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const batch = await api.campaigns.getBatch(id);
    return NextResponse.json(batch, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (e) {
    const message = (e as Error).message ?? 'failed to fetch batch';
    const status = message.includes('404') ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
