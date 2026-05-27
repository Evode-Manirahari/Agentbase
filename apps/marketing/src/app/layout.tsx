import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agentbase — the secure action layer for AI sales agents',
  description:
    'Cross-stack governance for revenue agents before they touch CRM, email, and sales tools. Okta + Zapier + Datadog for AI sales agents.',
  openGraph: {
    title: 'Agentbase — the secure action layer for AI sales agents',
    description:
      'Cross-stack governance for revenue agents before they touch CRM, email, and sales tools.',
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
