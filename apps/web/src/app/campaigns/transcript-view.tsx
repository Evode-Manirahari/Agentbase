import type { AgentRunResult, TranscriptEntry } from '../../lib/api';

export function TranscriptView({ result }: { result: AgentRunResult }) {
  return (
    <div className="flex flex-col gap-3">
      <StatusBanner result={result} />
      <ol className="flex flex-col gap-2">
        {result.transcript.map((entry, i) => (
          <li key={i}>
            <EntryRow entry={entry} />
          </li>
        ))}
      </ol>
      {result.usage ? <UsageRow usage={result.usage} /> : null}
    </div>
  );
}

function StatusBanner({ result }: { result: AgentRunResult }) {
  const tone =
    result.status === 'completed'
      ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300'
      : result.status === 'paused'
        ? 'border-amber-500/30 bg-amber-500/5 text-amber-300'
        : result.status === 'pending' || result.status === 'running'
          ? 'border-sky-500/30 bg-sky-500/5 text-sky-300'
          : 'border-rose-500/30 bg-rose-500/5 text-rose-300';
  return (
    <div className={`rounded border p-3 text-sm ${tone}`}>
      <div className="font-medium uppercase tracking-wider text-xs mb-1">
        Run {result.status}
      </div>
      {result.status === 'paused' && result.paused_on ? (
        <div className="text-xs">
          Waiting on human approval for{' '}
          <span className="mono">{result.paused_on.dejavas_tool}</span> (action{' '}
          <span className="mono">{result.paused_on.action_id}</span>). Approve in
          Slack or on the{' '}
          <a href="/approvals" className="underline">
            approvals page
          </a>
          .
        </div>
      ) : null}
      {result.status === 'failed' && result.error ? (
        <div className="text-xs">{result.error}</div>
      ) : null}
    </div>
  );
}

function EntryRow({ entry }: { entry: TranscriptEntry }) {
  switch (entry.type) {
    case 'agent_thinking':
      return (
        <Block label="thinking" tone="muted">
          <span className="whitespace-pre-wrap text-[var(--color-muted)]">
            {entry.text}
          </span>
        </Block>
      );
    case 'agent_message':
      return (
        <Block label="agent">
          <span className="whitespace-pre-wrap">{entry.text}</span>
        </Block>
      );
    case 'tool_call':
      return (
        <Block label="tool call" tone="accent">
          <div className="flex flex-col gap-1">
            <div>
              <span className="mono text-xs">{entry.job_tool_name}</span>{' '}
              <span className="text-xs text-[var(--color-muted)]">
                →{' '}
                <span className="mono">{entry.dejavas_tool}</span>
              </span>
            </div>
            <pre className="mono text-xs text-[var(--color-muted)] overflow-x-auto">
              {JSON.stringify(entry.params, null, 2)}
            </pre>
          </div>
        </Block>
      );
    case 'tool_result': {
      const tone =
        entry.status === 'executed'
          ? 'ok'
          : entry.status === 'awaiting_approval'
            ? 'warn'
            : entry.status === 'denied' || entry.status === 'failed'
              ? 'bad'
              : 'muted';
      const effect = entry.policy_decision.effect;
      const reason = entry.policy_decision.reason;
      return (
        <Block label="result" tone={tone}>
          <div className="flex flex-col gap-1 text-xs">
            <div>
              <span className="mono">status: {entry.status}</span>
            </div>
            <div className="text-[var(--color-muted)]">
              policy: <span className="mono">{effect}</span>
              {reason ? ` — ${reason}` : ''}
            </div>
            <div className="text-[var(--color-muted)]">
              action: <span className="mono">{entry.action_id}</span>
            </div>
          </div>
        </Block>
      );
    }
  }
}

type Tone = 'default' | 'muted' | 'accent' | 'ok' | 'warn' | 'bad';

function Block({
  label,
  tone = 'default',
  children,
}: {
  label: string;
  tone?: Tone;
  children: React.ReactNode;
}) {
  const tones: Record<Tone, string> = {
    default: 'border-[var(--color-border)]',
    muted: 'border-[var(--color-border)] bg-[var(--color-panel)]/40',
    accent: 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5',
    ok: 'border-emerald-500/30 bg-emerald-500/5',
    warn: 'border-amber-500/30 bg-amber-500/5',
    bad: 'border-rose-500/30 bg-rose-500/5',
  };
  return (
    <div className={`rounded border p-3 text-sm ${tones[tone]}`}>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

function UsageRow({
  usage,
}: {
  usage: NonNullable<AgentRunResult['usage']>;
}) {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    <div className="text-xs text-[var(--color-muted)] mono">
      tokens · in={usage.input_tokens} · out={usage.output_tokens}
      {cacheRead > 0 ? ` · cache_read=${cacheRead}` : ''}
      {cacheWrite > 0 ? ` · cache_write=${cacheWrite}` : ''}
    </div>
  );
}
