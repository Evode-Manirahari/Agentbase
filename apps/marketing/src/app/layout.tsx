import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agentbase — the safe-action layer for internal AI agents',
  description:
    'Scoped identity, approval, and audit for AI agents before they touch your APIs, CRM, email, and internal tools. Okta + Zapier + Datadog for AI agents.',
  openGraph: {
    title: 'Agentbase — the safe-action layer for internal AI agents',
    description:
      'Scoped identity, approval, and audit for AI agents before they touch your APIs, CRM, email, and internal tools.',
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
