import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import { Notifications } from '../components/shell/notice';
import { ServiceWorker } from '../components/shell/service-worker';
import { ThemeProvider } from '../components/shell/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'Atena',
  description: 'Configure your agents, their channels and their connections in one place.',
  manifest: '/ui/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Atena' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#050505', colorScheme: 'dark light' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ThemeProvider>{children}</ThemeProvider>
        <Notifications />
        <ServiceWorker />
      </body>
    </html>
  );
}
