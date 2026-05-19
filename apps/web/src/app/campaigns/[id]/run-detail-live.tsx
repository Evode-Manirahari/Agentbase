'use client';

import { useEffect, useState } from 'react';
import { TranscriptView } from '../transcript-view';
import type { AgentRunResult } from '../../../lib/api';

const POLL_INTERVAL_MS = 2000;
const TERMINAL: AgentRunResult['status'][] = ['completed', 'paused', 'failed'];

export function RunDetailLive({
  initialResult,
}: {
  initialResult: AgentRunResult;
}) {
  const [result, setResult] = useState(initialResult);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (TERMINAL.includes(result.status)) {
      // Even when paused, we keep polling — a Slack approval can flip
      // the run to running again as the worker resumes.
      if (result.status !== 'paused') return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const resp = await fetch(`/campaigns/api/runs/${result.id}`, {
          cache: 'no-store',
        });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const next = (await resp.json()) as AgentRunResult;
        if (!cancelled) setResult(next);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    };
    const t = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [result.id, result.status]);

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-300">
          Live update error: {error}. Last-known state below.
        </div>
      ) : null}
      <TranscriptView result={result} />
    </div>
  );
}
