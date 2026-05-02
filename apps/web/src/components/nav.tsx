import Link from 'next/link';
import type { ReactNode } from 'react';

const items = [
  { href: '/', label: 'Overview' },
  { href: '/agents', label: 'Agents' },
  { href: '/policies', label: 'Policies' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/actions', label: 'Actions' },
  { href: '/audit', label: 'Audit' },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex">
      <aside className="w-56 shrink-0 border-r border-[var(--color-border)] bg-[var(--color-panel)] p-4 flex flex-col gap-1">
        <div className="px-2 pb-4 mb-2 border-b border-[var(--color-border)]">
          <div className="text-lg font-semibold tracking-tight">Dejavas</div>
          <div className="text-xs text-[var(--color-muted)]">control plane</div>
        </div>
        {items.map((it) => (
          <Link
            key={it.href}
            href={it.href as never}
            className="px-3 py-2 rounded-md text-sm hover:bg-[var(--color-bg)] hover:text-white text-[var(--color-muted)] transition-colors"
          >
            {it.label}
          </Link>
        ))}
        <div className="mt-auto text-xs text-[var(--color-muted)] px-2">
          local · {process.env.API_URL ?? 'http://localhost:3002'}
        </div>
      </aside>
      <main className="flex-1 p-8 overflow-x-auto">{children}</main>
    </div>
  );
}

export function H1({ children }: { children: ReactNode }) {
  return <h1 className="text-2xl font-semibold mb-1">{children}</h1>;
}

export function Subtitle({ children }: { children: ReactNode }) {
  return <p className="text-sm text-[var(--color-muted)] mb-6">{children}</p>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] ${className}`}
    >
      {children}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'executed' || status === 'approved' || status === 'active'
      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
      : status === 'awaiting_approval' || status === 'pending'
        ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
        : status === 'failed' || status === 'denied' || status === 'expired' || status === 'revoked'
          ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
          : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30';
  return (
    <span className={`inline-block px-2 py-0.5 text-xs rounded border ${tone} mono`}>
      {status}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="text-sm text-[var(--color-muted)] py-12 text-center border border-dashed border-[var(--color-border)] rounded-lg">
      {children}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="rounded border border-rose-500/30 bg-rose-500/5 text-rose-300 p-4 text-sm mono">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}
