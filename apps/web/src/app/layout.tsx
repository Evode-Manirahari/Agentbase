import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import { Shell } from '../components/nav';

export const metadata: Metadata = {
  title: 'Dejavas',
  description:
    'Approval gate for AI agents writing to Salesforce, HubSpot, and Gmail.',
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
};

const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default function RootLayout({ children }: { children: ReactNode }) {
  const tree = (
    <html lang="en">
      <body className="antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );

  if (!clerkEnabled) {
    return tree;
  }

  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorBackground: '#0a0a0a',
          colorPrimary: '#4f46e5',
          colorText: '#f5f5f5',
        },
      }}
    >
      {tree}
    </ClerkProvider>
  );
}
