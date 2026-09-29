import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import { Notifications } from '../components/shell/notice';
import { ServiceWorker } from '../components/shell/service-worker';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jian · Gateway',
  description: 'Configure your agents, their channels and their connections in one place.',
  icons: { icon: '/ui/brand/jian.svg', apple: '/ui/brand/apple-touch-icon.png' },
  manifest: '/ui/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Jian' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#050505', colorScheme: 'dark' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {children}
        <Notifications />
        <ServiceWorker />
      </body>
    </html>
  );
}
