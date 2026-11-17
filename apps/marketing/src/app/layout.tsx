import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agentbase — booking integrity for voice agents',
  description:
    'Find the bookings your voice agent duplicated, never confirmed with the caller, or never made. A read-only audit of your call logs that runs on your machine. Where the outcome is unknown, it says so.',
  openGraph: {
    title: 'Agentbase — booking integrity for voice agents',
    description:
      'Find the bookings your voice agent duplicated, never confirmed with the caller, or never made. Read-only, local, and honest about what it cannot see.',
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
