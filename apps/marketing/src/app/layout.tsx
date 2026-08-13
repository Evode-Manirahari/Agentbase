import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agentbase — the effect commit layer for AI agents',
  description:
    "Commit an agent's irreversible actions exactly once, prove what happened, and survive a crash in the middle. Ten retries across three crash points, one effect.",
  openGraph: {
    title: 'Agentbase — the effect commit layer for AI agents',
    description:
      "Commit an agent's irreversible actions exactly once, prove what happened, and survive a crash in the middle.",
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
