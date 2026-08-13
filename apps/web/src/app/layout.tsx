import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import { Shell } from '../components/nav';

export const metadata: Metadata = {
  title: 'Agentbase',
  description:
    "Effect commit layer for AI agents — commit irreversible actions exactly once wherever the provider deduplicates, prove what happened, and survive a crash in the middle.",
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
