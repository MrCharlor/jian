import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '../app/globals.css';
import type { Preview } from '@storybook/nextjs-vite';
import { setupWorker } from 'msw/browser';
import { mswLoader } from 'msw-storybook-addon/csf3';
import { ThemeProvider } from '../components/shell/theme';
import { handlers } from '../stories/handlers';

const preview: Preview = {
  decorators: [
    (Story) => (
      <ThemeProvider>
        <Story />
      </ThemeProvider>
    ),
  ],
  loaders: [
    // A request no handler answers goes to the network, which in Storybook means it fails
    // visibly instead of being made up.
    mswLoader(async () => {
      // Keep the gateway handlers across Storybook's handler resets during story/HMR changes.
      const worker = setupWorker(...handlers);

      await worker.start({
        onUnhandledRequest: 'bypass',
        quiet: true,
        serviceWorker: { url: './mockServiceWorker.js' },
      });

      return worker;
    }),
  ],
  parameters: {
    layout: 'fullscreen',
    nextjs: { appDirectory: true },
    a11y: { test: 'todo' },
    controls: { expanded: true },
  },
};

export default preview;
