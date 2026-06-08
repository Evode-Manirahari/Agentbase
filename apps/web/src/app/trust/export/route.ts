import type { NextRequest } from 'next/server';
import { buildSecurityPacket, loadTrustEvidence } from '../evidence';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const agentId = req.nextUrl.searchParams.get('agent_id');
  const evidence = await loadTrustEvidence(agentId);
  const packet = buildSecurityPacket(evidence);
  const scope =
    evidence.selected_agent?.name
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'organization';
  return new Response(JSON.stringify(packet, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="agentbase-security-packet-${scope}.json"`,
      'cache-control': 'no-store',
    },
  });
}
