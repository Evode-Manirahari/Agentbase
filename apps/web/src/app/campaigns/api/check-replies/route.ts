import { NextResponse, type NextRequest } from 'next/server';
import { api } from '../../../../lib/api';

export const dynamic = 'force-dynamic';

// Lightweight proxy from the run detail page's "Check replies" button.
// The browser POSTs here; we forward to the API with the Clerk JWT
// that lives server-side.
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const runId = url.searchParams.get('run_id');
  const batchId = url.searchParams.get('batch_id');
  try {
    if (runId) {
      const r = await api.campaigns.checkRepliesForRun(runId);
      return NextResponse.json(r);
    }
    if (batchId) {
      const r = await api.campaigns.checkRepliesForBatch(batchId);
      return NextResponse.json(r);
    }
    return NextResponse.json(
      { error: 'run_id or batch_id required' },
      { status: 400 },
    );
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message ?? 'check-replies failed' },
      { status: 502 },
    );
  }
}
