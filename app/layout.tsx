import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Comfrt Infringement Scan',
  description: 'Marketplace infringement detection — Comfrt on Amazon + eBay',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
