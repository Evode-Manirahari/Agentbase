'use client';

import { useEffect, useState, useTransition } from 'react';
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
  const [replyCheckNote, setReplyCheckNote] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();

  function onCheckReplies() {
    setReplyCheckNote(null);
    startChecking(async () => {
      try {
        const resp = await fetch(
          `/campaigns/api/check-replies?run_id=${result.id}`,
          { method: 'POST' },
        );
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        setReplyCheckNote(
          'Reply check enqueued. New reply-handler runs will appear on /campaigns within a few seconds if any prospects replied.',
        );
      } catch (e) {
        setReplyCheckNote(
          `Reply check failed: ${(e as Error).message ?? 'unknown error'}`,
        );
      }
    });
  }

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

  // Only show the "check replies" button on runs that completed an
  // outbound flow. For hygiene or reply-handler runs,
  // the button would be a no-op.
  const showCheckReplies = result.job_key === 'ai-sdr-outbound' && result.status === 'completed';

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-300">
          Live update error: {error}. Last-known state below.
        </div>
      ) : null}
      {showCheckReplies ? (
        <div className="rounded border border-[var(--color-border)] p-3 flex items-center gap-3">
          <button
            type="button"
            onClick={onCheckReplies}
            disabled={checking}
            className="px-3 py-1.5 rounded-md text-xs border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {checking ? 'Checking…' : 'Check for replies'}
          </button>
          <span className="text-xs text-[var(--color-muted)]">
            Polls Gmail for replies to email sent in this run. A reply triggers an automatic ai-reply-handler agent run (approval-gated for the response).
          </span>
        </div>
      ) : null}
      {replyCheckNote ? (
        <div className="rounded border border-sky-500/30 bg-sky-500/5 p-2 text-xs text-sky-300">
          {replyCheckNote}
        </div>
      ) : null}
      <TranscriptView result={result} />
    </div>
  );
}
