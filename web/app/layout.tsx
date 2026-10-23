import './globals.css';
import type { ReactNode } from 'react';
import { DotGothic16, JetBrains_Mono, Zen_Dots } from 'next/font/google';

const head = Zen_Dots({ weight: '400', subsets: ['latin'], variable: '--f-head' });
const jp = DotGothic16({ weight: '400', subsets: ['latin', 'japanese'], variable: '--f-jp', preload: false });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--f-mono' });

export const metadata = { title: 'ゼロコミット | Zero Commit · Live Workspace' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${head.variable} ${jp.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}