import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'ゼロコミット | Zero Commit · Live Workspace' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}